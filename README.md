# Trekker-GPS voor tablet en Amatron 3

Een zelfbouw-GPS voor de tractor. Eén GPS-ontvanger voedt twee schermen tegelijk:

- **De tablet** krijgt alle NMEA-zinnen via USB of Bluetooth. De tablet-app maakt daarmee de kaarten, perceelgrenzen en bestanden.
- **De Amazone Amatron 3** krijgt GGA, VTG en GSA via RS232 aan 19200 baud, zoals de handleiding vraagt.

```
                 dual-band antenne (op het dak)
                          │
                 ┌────────┴────────┐
                 │  Quectel LC29H  │  GPS-module
                 └────────┬────────┘
                          │ 3,3V seriëel, 115200 baud
                 ┌────────┴────────┐
 tablet ◄─USB/BT─┤      ESP32      ├──wifi──► NTRIP (RTK-correcties, optioneel)
 (RTCM terug) ──►│                 │
                 └────────┬────────┘
                          │ 3,3V
                 ┌────────┴────────┐
                 │     MAX3232     │  zet 3,3V om naar echte RS232
                 └────────┬────────┘
                          │ RS232, 19200 baud, GGA + VTG + GSA aan 5 Hz
                     Amatron 3
```

## Eerst lezen: welke GPS-module?

De Amatron 3 wil **minstens 5 posities per seconde**. Niet elke LC29H-variant kan dat.

| Variant | Nauwkeurigheid | Snelheid | Geschikt? |
|---|---|---|---|
| LC29H(BS) | basisstation | n.v.t. | **Nee.** Dient om zelf een RTK-basisstation te bouwen. |
| LC29H(DA) | cm met RTK | RTK maar 1 Hz | **Liever niet.** Te traag voor de Amatron in RTK. |
| LC29H(AA) | ongeveer 1 m met SBAS/EGNOS | tot 10 Hz | **Ja**, goedkoopste optie. |
| LC29H(EA) | cm met RTK | RTK tot 10 Hz | **Beste LC29H-keuze**, als je hem vindt. |
| u-blox ZED-F9P | cm met RTK | 10 Hz+ | **Ja**, de standaard bij AgOpenGPS, maar duurder. |

De firmware werkt met elke ontvanger die NMEA uitstuurt. Alleen het automatische instellen bij het opstarten is specifiek voor de LC29H. Zet `GNSS_SEND_CONFIG` op 0 bij een andere ontvanger.

## Onderdelen

| Onderdeel | Opmerking |
|---|---|
| GPS-module LC29H(AA) of (EA) | bv. de Waveshare LC29H GPS/RTK HAT |
| Dual-band L1/L5 actieve antenne | met magneetvoet, midden op het cabinedak |
| ESP32 DevKit (ESP32-WROOM-32) | gewone ESP32, **geen** S3/C3, anders werkt Bluetooth niet |
| MAX3232-module met Sub-D 9 | RS232-omzetter, werkt op 3,3V |
| DC-DC omvormer 12V naar 5V, 2A | voor auto/tractor, met zekering ervoor |
| Kabel naar de Amatron 3 | seriële aansluiting van de Amatron, Sub-D 9 |
| Behuizing, kabelwartels | stof en trillingen in de cabine |

## Aansluiten

**Belangrijk:** de Amatron werkt met echte RS232, dat is ±5 tot ±12V. Sluit hem nooit rechtstreeks op de ESP32 aan, altijd via de MAX3232.

### Voeding

```
tractor 12V ── zekering 2A ── DC-DC 12V→5V ──┬── ESP32 pin 5V/VIN
                                             └── HAT headerpin 2 (5V)
tractor massa ───────────────────────────────── GND van alles samen
```

### GPS-module (Waveshare HAT) naar ESP32

Zet de schakelaar op de HAT op **B** (Pi ↔ LC29H). De pinnummers zijn die van de Raspberry Pi-header. Controleer ze met de opdruk op het bordje.

| HAT-headerpin | Functie | ESP32 |
|---|---|---|
| 2 | 5V | 5V |
| 6 | GND | GND |
| 10 | module TX | GPIO16 |
| 8 | module RX | GPIO17 |

De ESP32 en de LC29H werken allebei op 3,3V. Een levelshifter is dus niet nodig, in tegenstelling tot bij een Arduino Uno.

### ESP32 naar MAX3232 naar Amatron 3

| ESP32 | MAX3232-module | Amatron 3 Sub-D 9 |
|---|---|---|
| 3V3 | VCC | |
| GND | GND | pin 5 (GND) |
| GPIO26 | TXD / T1IN | uit T1OUT naar Amatron RX |
| GPIO27 | RXD / R1OUT | niet nodig |

Bij een standaard RS232-apparaat is pin 2 de ontvangst (RX) en pin 3 de zending (TX). Komt er niets aan, wissel dan pin 2 en 3, of gebruik een null-modemkabel.

**Tip om RX en TX te vinden:** meet met een multimeter tussen pin 5 en pin 2 en 3 terwijl de Amatron aanstaat. De pin met ongeveer -5 tot -12V is de TX van de Amatron. De andere is RX, en daar moet het GPS-signaal naartoe.

## Amatron 3 instellen

Volgens de handleiding MG4038 verwacht de Amatron 3:

| Instelling | Waarde |
|---|---|
| Baudrate | 19200 |
| Data | 8 bits, geen pariteit, 1 stopbit |
| Zinnen | GGA, VTG en GSA |
| Frequentie | 5 Hz |

1. Schakel de lightbar uit in de Setup van het terminal, onder Program Manager.
2. Stel de baudrate in op 19200 in het menu GPS-diagnose.
3. Herstart de Amatron.
4. Controleer in het menu GPS-diagnose of er een positie binnenkomt.
5. Vul de positie van de antenne op de tractor in bij de machinegegevens.

Oudere Amatron-software verwacht soms `$GPGGA` in plaats van `$GNGGA`. De firmware zet dat standaard om. Dat stel je in met `AMATRON_TALKER_GP` in `config.h`.

## Tablet

De ESP32 stuurt alle NMEA-zinnen naar de tablet. De tablet-app maakt de bestanden.

- **Windows-tablet met AgOpenGPS:** sluit aan met een USB-kabel. Kies in AgIO de juiste COM-poort aan 115200 baud. Bluetooth kan ook, dan verschijnt er een COM-poort voor "Trekker-GPS" na het koppelen.
- **Android-tablet:** koppel "Trekker-GPS" via Bluetooth. Gebruik een app die een externe Bluetooth-GPS als locatie doorgeeft aan andere apps, zoals "Bluetooth GNSS".

## RTK-correcties

Voor centimeternauwkeurigheid heb je een LC29H(DA/EA) of ZED-F9P nodig, plus correcties van een basisstation via internet. Dat heet NTRIP. Er zijn twee manieren:

1. **Via de tablet:** de NTRIP-client in AgIO stuurt de correcties over USB of Bluetooth terug. De ESP32 geeft ze door aan de GPS. Dit staat standaard aan.
2. **Via wifi op de ESP32:** zet `NTRIP_ENABLED` op 1 en vul de gegevens van je gsm-hotspot en caster in `config.h` in.

Gebruik er maar één van tegelijk.

Mogelijke correctiediensten:

- **FLEPOS:** RTK-netwerk van de Vlaamse overheid, voor Vlaanderen. Registratie nodig.
- **Centipede:** gratis netwerk van vrijwilligers, met basisstations in België en Nederland. Kies een mountpoint dicht bij je perceel.
- **06-GPS:** betalende dienst in Nederland.

## Firmware uploaden

1. Installeer de Arduino IDE en het bordpakket "esp32" van Espressif.
2. Open `firmware/trekker_gps/trekker_gps.ino`.
3. Pas `firmware/trekker_gps/config.h` aan.
4. Kies het bord "ESP32 Dev Module" en de juiste poort.
5. Klik op uploaden.

Zonder tablet kan je testen met `DEBUG_OUTPUT` op 1. Open de seriële monitor aan 115200 baud. Elke 5 seconden verschijnt dan een regel met het aantal posities per seconde, de fix-kwaliteit en hoeveel zinnen naar de Amatron gingen. Zet de optie terug op 0 voor gebruik met de tablet.

De led op de ESP32 knippert bij elke positie en brandt continu bij een RTK-fix.

## NMEA-logica testen op de computer

```
g++ -std=c++17 -Wall -Wextra -I firmware/trekker_gps test/test_nmea.cpp -o test_nmea && ./test_nmea
```

## Nog na te kijken op de echte hardware

- De pinnen van de seriële aansluiting op jouw Amatron 3-kabel.
- Of je Amatron-versie `$GNGGA` aanvaardt of `$GPGGA` nodig heeft.
- De LC29H-instelcommando's (`PAIR050` en `PAIR062`). Ze volgen de Quectel-documentatie, maar zijn nog niet op een echte module getest.
