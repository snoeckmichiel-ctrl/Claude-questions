// trekker_gps.ino
//
// Leest NMEA van een Quectel LC29H en verdeelt het over:
//   - de tablet via USB en/of Bluetooth (alle zinnen),
//   - de Amazone Amatron 3 via RS232 (GGA, VTG, GSA aan 19200 baud).
// RTCM-correcties komen van de tablet of van de ingebouwde NTRIP-client.
//
// Bord: gewone ESP32 (ESP32 Dev Module) in de Arduino IDE.

#include <Arduino.h>
#include "config.h"
#include "nmea.h"

#if TABLET_BT_ENABLED
#include <BluetoothSerial.h>
BluetoothSerial SerialBT;
#endif

#if NTRIP_ENABLED
#include <WiFi.h>
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
// Uitvoer
// ---------------------------------------------------------------------------
static void sendToTablet(const char* line, size_t len) {
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
// Correcties van de tablet naar de GPS-module
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
      DBG("wifi verbroken");
    }
    return;
  }

  switch (ntripState) {
    case WIFI_WAIT:
      DBG("wifi verbonden, IP %s", WiFi.localIP().toString().c_str());
      ntripState = CASTER_CONNECT;
      break;

    case CASTER_CONNECT: {
      if (!caster.connect(NTRIP_HOST, NTRIP_PORT, 2000)) { ntripFail("caster onbereikbaar"); break; }
      String auth = base64::encode(String(NTRIP_USER) + ":" + NTRIP_PASSWORD);
      caster.print(String("GET /") + NTRIP_MOUNT + " HTTP/1.0\r\n"
                   "User-Agent: NTRIP TrekkerGPS/1.0\r\n"
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

#if NTRIP_ENABLED
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
#endif

  delay(500);  // module laten opstarten
  configureGnss();
  DBG("Trekker-GPS gestart");
}

void loop() {
  while (GNSS.available()) {
    if (assembler.feed((char)GNSS.read())) handleLine(assembler.line(), assembler.length());
  }

  forwardFromTablet();

#if NTRIP_ENABLED
  ntripLoop();
#endif

  // Amatron leest niets terug; inkomende bytes gewoon weggooien.
#if AMATRON_ENABLED
  while (AMATRON.available()) AMATRON.read();
#endif

  updateLed();

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
