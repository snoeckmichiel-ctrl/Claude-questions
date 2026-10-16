// trekker_gps.ino
//
// Leest NMEA van een Quectel LC29H en verdeelt het over:
//   - de Trekker-GPS app op de tablet, via de hotspot van de tablet (of het eigen
//     wifinetwerk van het kastje, of Bluetooth LE),
//   - andere apps via USB of klassieke Bluetooth (alle zinnen),
//   - de Amazone Amatron 3 via RS232 (GGA, VTG, GSA aan 19200 baud).
// RTCM-correcties komen van de ingebouwde NTRIP-client of van een app via USB/Bluetooth.
//
// Bord: gewone ESP32 (ESP32 Dev Module), Partition Scheme "Huge APP".

#include <Arduino.h>
#include "config.h"
#include "nmea.h"

#define FW_VERSION "0.3.0"
#define WIFI_SERVER (HOTSPOT_ENABLED || BOX_AP_ENABLED)

#if NTRIP_ENABLED && !HOTSPOT_ENABLED
#error "NTRIP heeft internet nodig: zet HOTSPOT_ENABLED op 1"
#endif

#if TABLET_BT_ENABLED
#include <BluetoothSerial.h>
BluetoothSerial SerialBT;
#endif

#if BLE_ENABLED
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
// Nordic UART-dienst: een bekende standaard om tekst over BLE te sturen.
#define NUS_SERVICE "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_TX      "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
static BLEServer* bleServer = nullptr;
static BLECharacteristic* bleTx = nullptr;
static volatile bool bleConnected = false;
static volatile uint16_t bleConnId = 0;
static char bleBuf[1024];
static size_t bleLen = 0;
#endif

#if WIFI_SERVER
#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include "web_app.h"
static AsyncWebServer webServer(80);
static AsyncEventSource events("/events");  // NMEA-stroom voor de app
static char evBuf[2048];
static size_t evLen = 0;
#endif

#if HOTSPOT_ENABLED
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
static volatile bool announceRequested = false;
static volatile bool staDisconnected = false;
#endif

#if NTRIP_ENABLED
#include <base64.h>
#endif

HardwareSerial& GNSS = Serial2;
HardwareSerial& AMATRON = Serial1;

static nmea::LineAssembler assembler;
static nmea::AmatronFilter* amatronFilter = nullptr;

static char lastGGA[nmea::MAX_LINE + 4] = "";
static int fixQuality = -1;
static unsigned long lastGgaMillis = 0;
static unsigned long ggaCount = 0;
static unsigned long amatronSent = 0, amatronDropped = 0;

#if DEBUG_OUTPUT
#define DBG(...) do { Serial.print("# "); Serial.printf(__VA_ARGS__); Serial.print("\r\n"); } while (0)
#else
#define DBG(...) do {} while (0)
#endif

// ---------------------------------------------------------------------------
// GPS-module instellen
// ---------------------------------------------------------------------------
static void sendGnssCommand(const char* body) {
  char out[96];
  size_t n = nmea::buildCommand(body, out, sizeof out);
  if (n) GNSS.write((const uint8_t*)out, n);
  DBG("naar GPS: %s", body);
  delay(60);
}

static void configureGnss() {
#if GNSS_SEND_CONFIG
  char cmd[40];
  // Meetfrequentie
  snprintf(cmd, sizeof cmd, "PAIR050,%d", GNSS_FIX_INTERVAL_MS);
  sendGnssCommand(cmd);
  // NMEA-uitvoer per type: PAIR062,<type>,<elke N metingen>
  // type 0=GGA 1=GLL 2=GSA 3=GSV 4=RMC 5=VTG 6=ZDA
  int perSecond = 1000 / GNSS_FIX_INTERVAL_MS;
  if (perSecond < 1) perSecond = 1;
  sendGnssCommand("PAIR062,0,1");  // GGA elke meting
  sendGnssCommand("PAIR062,1,0");  // GLL uit
  sendGnssCommand("PAIR062,2,1");  // GSA elke meting
  snprintf(cmd, sizeof cmd, "PAIR062,3,%d", GNSS_GSV_EVERY);
  sendGnssCommand(cmd);            // GSV af en toe
  sendGnssCommand("PAIR062,4,1");  // RMC elke meting
  sendGnssCommand("PAIR062,5,1");  // VTG elke meting
  snprintf(cmd, sizeof cmd, "PAIR062,6,%d", perSecond);
  sendGnssCommand(cmd);            // ZDA 1x per seconde
#endif
}

// ---------------------------------------------------------------------------
// Bluetooth LE
// ---------------------------------------------------------------------------
#if BLE_ENABLED
class BleCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*, esp_ble_gatts_cb_param_t* param) override {
    bleConnId = param->connect.conn_id;
    bleConnected = true;
  }
  void onDisconnect(BLEServer*) override {
    bleConnected = false;
    BLEDevice::startAdvertising();  // meteen weer zichtbaar voor de tablet
  }
};

static void setupBle() {
  BLEDevice::init(BLE_NAME);
  BLEDevice::setMTU(247);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new BleCallbacks());
  BLEService* svc = bleServer->createService(NUS_SERVICE);
  bleTx = svc->createCharacteristic(NUS_TX, BLECharacteristic::PROPERTY_NOTIFY);
  bleTx->addDescriptor(new BLE2902());
  svc->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  DBG("Bluetooth zichtbaar als %s", BLE_NAME);
}

// Gebundelde zinnen versturen in stukken die in één BLE-bericht passen.
static void bleFlush() {
  if (!bleConnected) { bleLen = 0; return; }
  uint16_t mtu = bleServer->getPeerMTU(bleConnId);
  size_t chunk = (mtu > 23 ? mtu : 23) - 3;
  if (chunk > 244) chunk = 244;
  for (size_t off = 0; off < bleLen; off += chunk) {
    size_t n = bleLen - off < chunk ? bleLen - off : chunk;
    bleTx->setValue((uint8_t*)bleBuf + off, n);
    bleTx->notify();
  }
  bleLen = 0;
}

static void bleQueue(const char* line, size_t len) {
  if (!bleConnected) return;
  if (bleLen + len + 2 > sizeof bleBuf) bleFlush();
  if (len + 2 > sizeof bleBuf) return;
  memcpy(bleBuf + bleLen, line, len);
  bleBuf[bleLen + len] = '\r';
  bleBuf[bleLen + len + 1] = '\n';
  bleLen += len + 2;
}
#endif

// ---------------------------------------------------------------------------
// Wifi: hotspot van de tablet en/of eigen netwerk, met webserver voor de app
// ---------------------------------------------------------------------------
#if WIFI_SERVER
// Zinnen bundelen en ongeveer 10 keer per seconde naar de app sturen.
static void evFlush() {
  if (evLen && events.count() > 0) {
    evBuf[evLen] = '\0';
    events.send(evBuf, "nmea", millis());
  }
  evLen = 0;
}

static void evQueue(const char* line, size_t len) {
  if (evLen + len + 3 > sizeof evBuf) evFlush();
  if (len + 3 > sizeof evBuf) return;
  memcpy(evBuf + evLen, line, len);
  evBuf[evLen + len] = '\n';
  evLen += len + 1;
}

static String infoJson() {
  String s = "{\"name\":\"Trekker-GPS\",\"version\":\"" FW_VERSION "\"";
#if HOTSPOT_ENABLED
  s += ",\"ip\":\"" + (WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("")) + "\"";
#endif
#if BOX_AP_ENABLED
  s += ",\"ap\":\"" + WiFi.softAPIP().toString() + "\"";
#endif
  s += ",\"fix\":" + String(fixQuality) + ",\"clients\":" + String((unsigned)events.count()) + "}";
  return s;
}

static void setupWifi() {
#if HOTSPOT_ENABLED && BOX_AP_ENABLED
  WiFi.mode(WIFI_AP_STA);
#elif HOTSPOT_ENABLED
  WiFi.mode(WIFI_STA);
#else
  WiFi.mode(WIFI_AP);
#endif
#if BOX_AP_ENABLED
  WiFi.softAP(BOX_AP_SSID, BOX_AP_PASSWORD);
#endif
#if HOTSPOT_ENABLED
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t) { staDisconnected = true; },
               ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.setAutoReconnect(true);
  WiFi.begin(HOTSPOT_SSID, HOTSPOT_PASSWORD);
#endif

  // De online app (https) mag het kastje lezen: CORS en lokale netwerktoegang toestaan.
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Private-Network", "true");

  webServer.on("/", HTTP_GET, [](AsyncWebServerRequest* req) {
    AsyncWebServerResponse* res = req->beginResponse(200, "text/html", WEB_APP_GZ, WEB_APP_GZ_LEN);
    res->addHeader("Content-Encoding", "gzip");
    res->addHeader("Cache-Control", "no-cache");
    req->send(res);
  });
  webServer.on("/api/info", HTTP_GET, [](AsyncWebServerRequest* req) {
    req->send(200, "application/json", infoJson());
  });
  webServer.addHandler(&events);
  webServer.onNotFound([](AsyncWebServerRequest* req) {
    if (req->method() == HTTP_OPTIONS) req->send(204);
    else req->redirect("/");
  });
  webServer.begin();
}

#if HOTSPOT_ENABLED
// Na verbinden: vast adres x.x.x.200 nemen in het adresbereik van de hotspot.
// Na verbreken: terug naar DHCP, want de volgende hotspot kan een ander bereik hebben.
static void hotspotLoop() {
  static bool wasConnected = false;
  static bool staticSet = false;
  if (staDisconnected) {
    staDisconnected = false;
    if (staticSet) {
      WiFi.config(IPAddress(0, 0, 0, 0), IPAddress(0, 0, 0, 0), IPAddress(0, 0, 0, 0));
      staticSet = false;
      DBG("hotspot verbroken, terug naar DHCP");
    }
  }
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wasConnected) {
    IPAddress ip = WiFi.localIP(), gw = WiFi.gatewayIP(), mask = WiFi.subnetMask();
    if (!staticSet && mask == IPAddress(255, 255, 255, 0)) {
      uint8_t host = HOTSPOT_HOST_OCTET;
      if (gw[3] == host) host++;
      IPAddress want(ip[0], ip[1], ip[2], host);
      if (ip != want) WiFi.config(want, gw, mask, gw);
      staticSet = true;
    }
    DBG("hotspot verbonden, adres %s", WiFi.localIP().toString().c_str());
    announceRequested = true;
  }
  wasConnected = connected;

  static unsigned long lastAnnounce = 0;
  if (connected && millis() - lastAnnounce > 10UL * 60UL * 1000UL) {
    lastAnnounce = millis();
    announceRequested = true;
  }
}

static String urlEncode(const char* s) {
  String out;
  for (; *s; ++s) {
    char c = *s;
    if (isalnum((unsigned char)c) || c == '-' || c == '_' || c == '.' || c == '~') out += c;
    else { char b[4]; snprintf(b, sizeof b, "%%%02X", (unsigned char)c); out += b; }
  }
  return out;
}

// Meldt het adres aan de Drive-koppeling, in een aparte taak zodat de GPS-stroom doorloopt.
static void announceTask(void*) {
  for (;;) {
    if (announceRequested && WiFi.status() == WL_CONNECTED && strlen(DRIVE_URL) > 0) {
      announceRequested = false;
      vTaskDelay(pdMS_TO_TICKS(1500));  // vast adres eerst laten ingaan
      WiFiClientSecure client;
      client.setInsecure();  // alleen het lokale adres wordt gemeld
      HTTPClient http;
      String url = String(DRIVE_URL) + "?action=announce&key=" + urlEncode(DRIVE_KEY) +
                   "&ip=" + WiFi.localIP().toString() + "&version=" FW_VERSION;
      // Het script draait al bij het eerste verzoek; de omleiding niet volgen.
      http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
      if (http.begin(client, url)) {
        int code = http.GET();
        DBG("adres gemeld aan Drive: %d", code);
        (void)code;
        http.end();
      }
    }
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}
#endif
#endif

// ---------------------------------------------------------------------------
// Uitvoer
// ---------------------------------------------------------------------------
static void sendToTablet(const char* line, size_t len) {
#if WIFI_SERVER
  evQueue(line, len);
#endif
#if BLE_ENABLED
  bleQueue(line, len);
#endif
#if TABLET_USB_ENABLED
  Serial.write((const uint8_t*)line, len);
  Serial.write("\r\n");
#endif
#if TABLET_BT_ENABLED
  if (SerialBT.hasClient()) {
    SerialBT.write((const uint8_t*)line, len);
    SerialBT.write((const uint8_t*)"\r\n", 2);
  }
#endif
}

static void sendToAmatron(const char* line) {
  (void)line;
#if AMATRON_ENABLED
  char out[nmea::MAX_LINE + 8];
  size_t n = amatronFilter->process(line, out, sizeof out);
  if (!n) return;
  // Nooit een halve zin sturen: liever een hele zin overslaan.
  if ((size_t)AMATRON.availableForWrite() >= n) {
    AMATRON.write((const uint8_t*)out, n);
    ++amatronSent;
  } else {
    ++amatronDropped;
  }
#endif
}

static void updateLed() {
  // RTK fixed: led brandt. Anders knippert de led bij elke positie.
  // Geen positie meer gedurende 2 s: led uit.
  if (millis() - lastGgaMillis > 2000) {
    digitalWrite(STATUS_LED_PIN, LOW);
  } else if (fixQuality == 4) {
    digitalWrite(STATUS_LED_PIN, HIGH);
  }
}

static void handleLine(const char* line, size_t len) {
  nmea::Type t = nmea::typeOf(line);
  if (t == nmea::GGA) {
    ++ggaCount;
    lastGgaMillis = millis();
    fixQuality = nmea::ggaFixQuality(line);
    snprintf(lastGGA, sizeof lastGGA, "%s\r\n", line);
    if (fixQuality > 0 && fixQuality != 4) digitalWrite(STATUS_LED_PIN, !digitalRead(STATUS_LED_PIN));
  }
  sendToTablet(line, len);
  sendToAmatron(line);
}

// ---------------------------------------------------------------------------
// Correcties van een app (USB of klassieke Bluetooth) naar de GPS-module
// ---------------------------------------------------------------------------
static void forwardFromTablet() {
  uint8_t buf[256];
#if TABLET_USB_ENABLED && TABLET_FORWARD_RTCM
  while (Serial.available()) {
    size_t n = Serial.readBytes(buf, min((int)sizeof buf, Serial.available()));
    GNSS.write(buf, n);
  }
#endif
#if TABLET_BT_ENABLED && TABLET_FORWARD_RTCM
  while (SerialBT.available()) {
    size_t n = SerialBT.readBytes(buf, min((int)sizeof buf, SerialBT.available()));
    GNSS.write(buf, n);
  }
#endif
  (void)buf;
}

// ---------------------------------------------------------------------------
// NTRIP-client
// ---------------------------------------------------------------------------
#if NTRIP_ENABLED
enum NtripState { WIFI_WAIT, CASTER_CONNECT, HEADER_WAIT, STREAMING, RETRY_WAIT };
static NtripState ntripState = WIFI_WAIT;
static WiFiClient caster;
static unsigned long ntripTimer = 0, lastRtcmMillis = 0, lastGgaSent = 0;
static char header[256];
static size_t headerLen = 0;

static void ntripFail(const char* why) {
  (void)why;  // alleen gebruikt als DEBUG_OUTPUT aan staat
  DBG("NTRIP: %s, opnieuw over 5 s", why);
  caster.stop();
  ntripState = RETRY_WAIT;
  ntripTimer = millis();
}

static void ntripLoop() {
  unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (ntripState != WIFI_WAIT) {
      caster.stop();
      ntripState = WIFI_WAIT;
      DBG("geen internet voor NTRIP");
    }
    return;
  }

  switch (ntripState) {
    case WIFI_WAIT:
      ntripState = CASTER_CONNECT;
      break;

    case CASTER_CONNECT: {
      if (!caster.connect(NTRIP_HOST, NTRIP_PORT, 2000)) { ntripFail("caster onbereikbaar"); break; }
      String auth = base64::encode(String(NTRIP_USER) + ":" + NTRIP_PASSWORD);
      caster.print(String("GET /") + NTRIP_MOUNT + " HTTP/1.0\r\n"
                   "User-Agent: NTRIP TrekkerGPS/" FW_VERSION "\r\n"
                   "Authorization: Basic " + auth + "\r\n\r\n");
      headerLen = 0;
      ntripTimer = now;
      ntripState = HEADER_WAIT;
      break;
    }

    case HEADER_WAIT:
      // NTRIP v1 antwoordt "ICY 200 OK\r\n", HTTP-casters "HTTP/1.x 200 ...\r\n\r\n".
      while (caster.available() && headerLen < sizeof header - 1) {
        header[headerLen++] = (char)caster.read();
        header[headerLen] = '\0';
        bool icyDone = !strncmp(header, "ICY", 3) && strstr(header, "\r\n");
        bool httpDone = !strncmp(header, "HTTP", 4) && strstr(header, "\r\n\r\n");
        if (icyDone || httpDone) {
          if (!strstr(header, " 200")) { ntripFail("caster weigert (mountpoint of login fout?)"); return; }
          DBG("NTRIP verbonden met %s", NTRIP_MOUNT);
          ntripState = STREAMING;
          lastRtcmMillis = now;
          lastGgaSent = 0;
          return;
        }
      }
      if (headerLen >= sizeof header - 1) ntripFail("onverwacht antwoord");
      else if (now - ntripTimer > 5000) ntripFail("geen antwoord");
      break;

    case STREAMING: {
      uint8_t buf[512];
      while (caster.available()) {
        int n = caster.read(buf, sizeof buf);
        if (n <= 0) break;
        GNSS.write(buf, n);
        lastRtcmMillis = now;
      }
      if (lastGGA[0] && (lastGgaSent == 0 || now - lastGgaSent > NTRIP_GGA_INTERVAL_MS)) {
        caster.print(lastGGA);
        lastGgaSent = now;
      }
      if (!caster.connected() || now - lastRtcmMillis > 15000) ntripFail("geen correcties meer");
      break;
    }

    case RETRY_WAIT:
      if (now - ntripTimer > 5000) ntripState = CASTER_CONNECT;
      break;
  }
}
#endif

// ---------------------------------------------------------------------------
void setup() {
  pinMode(STATUS_LED_PIN, OUTPUT);

#if TABLET_USB_ENABLED || DEBUG_OUTPUT
  Serial.begin(TABLET_USB_BAUD);
#endif

  GNSS.setRxBufferSize(8192);  // marge als wifi even blokkeert
  GNSS.begin(GNSS_BAUD, SERIAL_8N1, GNSS_RX_PIN, GNSS_TX_PIN);

#if AMATRON_ENABLED
  nmea::AmatronConfig cfg;
  cfg.gga = AMATRON_SEND_GGA;
  cfg.vtg = AMATRON_SEND_VTG;
  cfg.gsa = AMATRON_SEND_GSA;
  cfg.rmc = AMATRON_SEND_RMC;
  cfg.zda = AMATRON_SEND_ZDA;
  cfg.rewriteTalkerToGP = AMATRON_TALKER_GP;
  cfg.stripGsaSystemId = AMATRON_STRIP_GSA_SYSID;
  amatronFilter = new nmea::AmatronFilter(cfg);
  AMATRON.setTxBufferSize(1024);
  AMATRON.begin(AMATRON_BAUD, SERIAL_8N1, AMATRON_RX_PIN, AMATRON_TX_PIN);
#endif

#if TABLET_BT_ENABLED
  SerialBT.begin(TABLET_BT_NAME);
#endif

#if BLE_ENABLED
  setupBle();
#endif

#if WIFI_SERVER
  setupWifi();
#endif
#if HOTSPOT_ENABLED
  xTaskCreatePinnedToCore(announceTask, "drive", 8192, nullptr, 1, nullptr, 0);
#endif

  delay(500);  // module laten opstarten
  configureGnss();
  DBG("Trekker-GPS " FW_VERSION " gestart");
}

void loop() {
  while (GNSS.available()) {
    if (assembler.feed((char)GNSS.read())) handleLine(assembler.line(), assembler.length());
  }

  forwardFromTablet();

#if HOTSPOT_ENABLED
  hotspotLoop();
#endif

#if NTRIP_ENABLED
  ntripLoop();
#endif

  // Amatron leest niets terug; inkomende bytes gewoon weggooien.
#if AMATRON_ENABLED
  while (AMATRON.available()) AMATRON.read();
#endif

  updateLed();

#if BLE_ENABLED
  static unsigned long lastBleFlush = 0;
  if (millis() - lastBleFlush >= 100) { lastBleFlush = millis(); bleFlush(); }
#endif

#if WIFI_SERVER
  static unsigned long lastEvFlush = 0;
  if (millis() - lastEvFlush >= 100) { lastEvFlush = millis(); evFlush(); }
#endif

#if DEBUG_OUTPUT
  static unsigned long lastReport = 0;
  if (millis() - lastReport > 5000) {
    lastReport = millis();
    DBG("GGA/s=%.1f fix=%d naarAmatron=%lu overgeslagen=%lu fouteZinnen=%lu",
        ggaCount / 5.0, fixQuality, amatronSent, amatronDropped, assembler.badLines);
    ggaCount = 0;
  }
#endif
}
