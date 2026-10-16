// config.h - Pas hier alles aan voor jouw tractor. De rest hoef je niet te wijzigen.
#pragma once

// ---------------------------------------------------------------------------
// GPS-module (Quectel LC29H, bv. de Waveshare LC29H GPS/RTK HAT)
// ---------------------------------------------------------------------------
#define GNSS_RX_PIN      16       // ESP32 ontvangt hier: naar HAT-headerpin 10 (module TX)
#define GNSS_TX_PIN      17       // ESP32 zendt hier:    naar HAT-headerpin 8  (module RX)
#define GNSS_BAUD        115200   // fabrieksinstelling van de LC29H

// Bij het opstarten stuurt de ESP32 instellingen naar de module.
#define GNSS_SEND_CONFIG 1
// Tijd tussen metingen in ms. 200 = 5 Hz (minimum voor Amatron 3), 100 = 10 Hz.
// Let op: de LC29H(DA) doet RTK maar aan 1 Hz. Neem de (EA) voor RTK aan 10 Hz.
#define GNSS_FIX_INTERVAL_MS 200
// GSV (satellietlijst voor de tablet) één keer per zoveel metingen. 0 = uit.
#define GNSS_GSV_EVERY   5

// ---------------------------------------------------------------------------
// Amatron 3 (RS232 via een MAX3232-module, NOOIT rechtstreeks aansluiten)
// ---------------------------------------------------------------------------
#define AMATRON_ENABLED  1
#define AMATRON_TX_PIN   26       // naar MAX3232 TXD/T1IN
#define AMATRON_RX_PIN   27       // van MAX3232 RXD/R1OUT (niet echt nodig)
#define AMATRON_BAUD     19200    // moet gelijk zijn aan de instelling in de Amatron
#define AMATRON_SEND_GGA 1
#define AMATRON_SEND_VTG 1
#define AMATRON_SEND_GSA 1
#define AMATRON_SEND_RMC 0
#define AMATRON_SEND_ZDA 0
#define AMATRON_TALKER_GP 1       // $GNGGA -> $GPGGA, voor oudere terminals
#define AMATRON_STRIP_GSA_SYSID 1 // NMEA 4.10-extra veld in GSA weglaten

// ---------------------------------------------------------------------------
// Tablet
// ---------------------------------------------------------------------------
#define TABLET_USB_ENABLED 1
#define TABLET_USB_BAUD    115200 // zelfde waarde instellen in de tablet-app

// Bluetooth werkt alleen op een gewone ESP32 (ESP32-WROOM-32 / DevKitC),
// niet op ESP32-S3, -C3 of -C6. Standaard uit: wifi en Bluetooth samen
// vragen veel geheugen. Zet aan als je een andere tablet-app via Bluetooth gebruikt.
#define TABLET_BT_ENABLED  0
#define TABLET_BT_NAME     "Trekker-GPS"

// RTCM-correcties die de tablet terugstuurt (bv. AgIO NTRIP-client in
// AgOpenGPS) worden doorgegeven aan de GPS-module.
#define TABLET_FORWARD_RTCM 1

// ---------------------------------------------------------------------------
// Bluetooth Low Energy voor de online Trekker-GPS app (aanbevolen).
// De tablet houdt zo zijn eigen internet voor Google Drive.
// Werkt met Chrome op Android, Windows en Chromebook. Geen koppeling nodig in
// de instellingen van de tablet: de app vraagt het kastje zelf.
// ---------------------------------------------------------------------------
#define BLE_ENABLED      1
#define BLE_NAME         "Trekker-GPS"

// ---------------------------------------------------------------------------
// Reserve: de app via het eigen wifinetwerk van het kastje (http://192.168.4.1).
// Handig zonder internet of op een iPad, maar dan geen Google Drive.
// Vraagt de bibliotheken "ESPAsyncWebServer" en "AsyncTCP" van ESP32Async.
// ---------------------------------------------------------------------------
#define WIFI_APP_ENABLED 0
#define WIFI_AP_SSID     "Trekker-GPS"
#define WIFI_AP_PASSWORD "trekker123"  // minstens 8 tekens, verander dit

// ---------------------------------------------------------------------------
// Ingebouwde NTRIP-client via wifi (bv. hotspot van je gsm).
// Gebruik dit OF de NTRIP-client van de tablet, niet allebei tegelijk.
// ---------------------------------------------------------------------------
#define NTRIP_ENABLED    0
#define WIFI_SSID        "mijn-hotspot"
#define WIFI_PASSWORD    "wachtwoord"
#define NTRIP_HOST       "caster.centipede.fr"  // FLEPOS of een andere caster mag ook
#define NTRIP_PORT       2101
#define NTRIP_MOUNT      "MOUNTPOINT"           // dichtstbijzijnde basisstation
#define NTRIP_USER       "centipede"
#define NTRIP_PASSWORD   "centipede"
#define NTRIP_GGA_INTERVAL_MS 10000             // positie terugsturen (nodig voor VRS)

// ---------------------------------------------------------------------------
// Diversen
// ---------------------------------------------------------------------------
#define STATUS_LED_PIN   2        // ingebouwde led op de meeste DevKits
// 1 = statusregels beginnend met "#" op USB. Laat op 0 tijdens gebruik met de tablet.
#define DEBUG_OUTPUT     0
