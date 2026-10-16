# Trekker-GPS voor tablet en Amatron 3

Een zelfbouw-GPS voor de tractor. Eén GPS-ontvanger voedt twee schermen tegelijk:

- **De Android-tablet** draait de Trekker-GPS app. Het kastje verbindt met de hotspot van de tablet. De app tekent de kaart, neemt perceelgrenzen op, bewaart alle percelen en zet ze in je Google Drive.
- **De Amazone Amatron 3** krijgt GGA, VTG en GSA via RS232 aan 19200 baud, zoals de handleiding vraagt.

```
                 dual-band antenne (op het dak)
                          │
                 ┌────────┴────────┐
                 │  Quectel LC29H  │  GPS-module
                 └────────┬────────┘
                          │ 3,3V seriëel, 115200 baud
                 ┌────────┴────────┐
 tablet ◄─hotspot┤      ESP32      ├──via hotspot──► NTRIP (RTK-correcties)
   │             │                 │
   └─4G──► internet, Google Drive
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

## De Trekker-GPS app

![De Trekker-GPS app tijdens het werk](docs/app-werken.png)

De app staat online en werkt daarna ook zonder internet:

**https://snoeckmichiel-ctrl.github.io/Claude-questions/**

1. Open dit adres in Chrome op de tablet.
2. Kies in het menu van Chrome "App installeren" of "Toevoegen aan startscherm". Dan opent ze als een gewone app, ook zonder internet.

**Werken met de app:**

- **Percelen:** elk perceel wordt apart bewaard. Maak een nieuw perceel, open een ouder perceel, exporteer of verwijder het.
- **Instellingen:** naam van het perceel, klant, bedrijf, werkbreedte en de Drive-koppeling.
- **Grens:** rij rond het perceel en druk op "Klaar". De app toont de oppervlakte.
- **Start werk / Stop werk:** tekent de bewerkte stroken in de werkbreedte en houdt het rijspoor bij. Overlap wordt donkerder.
- **ISOXML:** in de percelenlijst. Je krijgt een zip met de map `TASKDATA` voor de Amatron of je bedrijfssoftware.
- **Demo:** een gesimuleerde tractor, om de app zonder GPS uit te proberen.
- **Weergave:** dag, nacht of automatisch.

| Verbinden | Percelen |
|---|---|
| ![Welkomstscherm](docs/app-welkom.png) | ![Percelen](docs/app-percelen.png) |

## Verbinden via de hotspot van de tablet

Het kastje verbindt met de hotspot van de Android-tablet. De tablet houdt zijn mobiele internet voor Google Drive. Het kastje krijgt via de hotspot internet voor de RTK-correcties.

### Eén keer instellen

**Op de tablet,** bij Instellingen, Verbindingen, Mobiele hotspot:

1. Kies een naam en een wachtwoord voor de hotspot.
2. Zet de frequentieband op **2,4 GHz**. De ESP32 kan geen 5 GHz.
3. Kies als beveiliging **WPA2**. Alleen WPA3 werkt niet met elk kastje.
4. Zet "Automatisch uitschakelen" uit, als je tablet die optie heeft.

**In de firmware,** in `config.h`:

1. Vul bij `HOTSPOT_SSID` en `HOTSPOT_PASSWORD` dezelfde naam en hetzelfde wachtwoord in.
2. Vul bij `DRIVE_URL` en `DRIVE_KEY` het adres en de sleutel van je Drive-koppeling in. Dat is optioneel, maar dan vindt de app het kastje meteen.
3. Upload de firmware.

### Elke dag

1. Zet de mobiele data en de hotspot van de tablet aan.
2. Zet de tractor en dus het kastje aan.
3. Open de app en tik op **Hotspot**. De volgende keren verbindt de app vanzelf.

De eerste keer vraagt Chrome of de app apparaten in je lokale netwerk mag gebruiken. Kies **Toestaan**.

### Hoe de app het kastje vindt

Android kiest bij elke start van de hotspot een ander adresbereik. Het kastje neemt daarin altijd het adres dat eindigt op **.200**. De app zoekt in deze volgorde:

1. Het adres dat je zelf invulde bij Instellingen.
2. Het laatst gekende adres.
3. Het adres dat het kastje meldde aan je Drive-koppeling.
4. Alle adressen van 192.168.0.200 tot 192.168.255.200. Dat duurt hooguit een halve minuut.

Valt de verbinding weg, dan verbindt de app vanzelf opnieuw.

### Andere manieren om te verbinden

- **Eigen wifinetwerk van het kastje:** verbind de tablet met het netwerk "Trekker-GPS" en open `http://192.168.4.1`. Dit werkt als de hotspot niet lukt, maar zonder internet en dus zonder Drive.
- **Bluetooth:** zet `BLE_ENABLED` op 1 en tik in de app op Bluetooth.
- **USB-kabel:** in Chrome of Edge op een Windows-tablet of computer.
- **Andere apps zoals AgOpenGPS:** zet `TABLET_BT_ENABLED` op 1 of gebruik de USB-kabel.

## Zo wordt alles bewaard

| Waar | Wat | Wanneer |
|---|---|---|
| Op de tablet | Alle percelen met grens, stroken en rijspoor | Elke 3 seconden, ook zonder internet |
| In Google Drive | ISOXML per perceel, reservekopie en overzicht | Bij stoppen, na een grens, elke 10 minuten en zodra er weer internet is |

De lijst met percelen toont per perceel "In Drive" of "Wacht op Drive". Zonder internet wacht de app gewoon, en stuurt alles later door.

Op een nieuwe tablet haal je de percelen terug via **Percelen**, dan **Percelen uit Drive tonen**.

### Google Drive instellen

Dit doe je één keer, op een computer, met het Google-account waar de gegevens moeten komen.

1. Ga naar [script.google.com](https://script.google.com) en kies **Nieuw project**.
2. Wis de voorbeeldcode en plak de inhoud van `drive/Code.gs` uit deze repo.
3. Vervang bovenaan `verander-dit-in-een-eigen-geheim` door een eigen geheim woord. Dat is je **sleutel**.
4. Klik op **Implementeren**, dan **Nieuwe implementatie**. Kies als type **Web-app**.
5. Kies bij "Uitvoeren als" **Ik** en bij "Wie heeft toegang" **Iedereen**. De sleutel zorgt dat alleen jullie app kan opslaan.
6. Klik op **Implementeren** en geef toestemming voor Drive en Sheets.
7. Kopieer de **web-app-URL**. Die eindigt op `/exec`.
8. Vul in de app bij Instellingen onder Google Drive de URL en de sleutel in. Tik op **Verbinding testen**.

In je Drive verschijnt een map **Trekker-GPS** met:

- **ISOXML:** per perceel een TASKDATA-zip.
- **_gegevens:** volledige reservekopie per perceel, om terug te zetten op een tablet.
- **Trekker-GPS overzicht:** een Google Sheet met één regel per perceel, met datum, klant, oppervlakte en een link naar de ISOXML.

Pas je later `Code.gs` aan, kies dan **Implementaties beheren** en maak een nieuwe versie. De URL blijft dezelfde.

## Productnaam en vermelding

De productnaam, versie, bedrijfsnaam en vermeldingen staan samen in `app/src/brand.js`. Pas ze daar aan en bouw de app opnieuw. Ze verschijnen in de bovenbalk, bij Instellingen onder "Over" en in de ISOXML-bestanden.

Deze app en firmware zijn ontwikkeld met hulp van Claude, een AI-assistent van Anthropic.

## Op weg naar verkoop

Voor je het product verkoopt, moeten deze punten nog geregeld worden:

- **CE-markering:** een toestel met wifi valt onder de Europese richtlijn voor radioapparatuur. Sinds augustus 2025 horen daar ook cyberbeveiligingseisen bij.
- **Wachtwoord per toestel:** een vast standaardwachtwoord zoals `trekker123` mag dan niet meer. Elk kastje heeft een eigen wachtwoord nodig, bijvoorbeeld op een sticker.
- **Licenties:** de ESP32-software en de webserverbibliotheken gebruiken open-sourcelicenties zoals de LGPL. Laat nakijken wat dat betekent voor de verkoop van de firmware.
- **Eigen licentie:** kies onder welke voorwaarden jullie eigen code verkocht of gedeeld wordt.
- **Compatibiliteit:** test de ISOXML-export met de Amatron 3 en met de bedrijfssoftware van jullie klanten.
- **Behuizing:** stof- en waterdicht, bestand tegen trillingen, met een stevige aansluiting op 12V.

## ISOXML-bestanden

ISOXML-taakbestanden heten `TASKDATA.XML` en volgen de norm ISO 11783-10. Het GPS-kastje maakt zelf geen bestanden. Het levert alleen de positie. Er zijn twee plaatsen waar de ISOXML-bestanden gemaakt kunnen worden.

### Op de Amatron 3, de eenvoudigste weg

De Amatron 3 heeft standaard een Task Controller voor taakbeheer in ISO-XML. Zodra hij GPS krijgt van dit kastje, kan hij taken registreren en taakkaarten afwerken.

1. Maak een taak, perceel of taakkaart in je bedrijfssoftware en zet de map `TASKDATA` op een USB-stick.
2. Importeer de taak op de Amatron 3 en start ze.
3. Rijd op het perceel. De Amatron registreert de bewerkte oppervlakte en hoeveelheden met de GPS-positie.
4. Exporteer de taak terug naar de USB-stick en lees ze in je bedrijfssoftware in.

Optionele licenties breiden dit uit. GPS-Switch zorgt voor automatische sectieschakeling. GPS-Maps leest taakkaarten in shapefile-formaat.

### Met de Trekker-GPS app

De app maakt een ISOXML-taak in versie 3. Versie 3 is de versie die oudere terminals zoals de Amatron 3 lezen. De export bevat:

| Bestand | Inhoud |
|---|---|
| `TASKDATA.XML` | klant, bedrijf, perceel met grens en de taak |
| `TLG00001.XML` en `TLG00001.BIN` | het rijspoor met tijd, positie en GPS-kwaliteit, één punt per seconde |

Machinegegevens zoals hoeveelheden of de werkstand zitten er nog niet in. Daarvoor is een apparaatbeschrijving nodig, en dat is een volgende stap.

## RTK-correcties

Voor centimeternauwkeurigheid heb je een LC29H(DA/EA) of ZED-F9P nodig, plus correcties van een basisstation via internet. Dat heet NTRIP. Er zijn twee manieren:

1. **Via de hotspot van de tablet:** zet `NTRIP_ENABLED` op 1 en vul de gegevens van de caster in `config.h` in. Het kastje gebruikt het internet van de tablet. Dit is de manier met de Trekker-GPS app.
2. **Via AgOpenGPS:** de NTRIP-client in AgIO stuurt de correcties over USB of Bluetooth terug. De ESP32 geeft ze door aan de GPS.

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
5. Kies bij Partition Scheme **Huge APP (3MB No OTA)**. Wifi, de webserver en de beveiligde verbinding met Drive passen niet in de standaardindeling.
6. Installeer via Bibliotheken beheren **ESPAsyncWebServer** en **AsyncTCP**, allebei van ESP32Async.
7. Klik op uploaden.

Zonder tablet kan je testen met `DEBUG_OUTPUT` op 1. Open de seriële monitor aan 115200 baud. Elke 5 seconden verschijnt dan een regel met het aantal posities per seconde, de fix-kwaliteit en hoeveel zinnen naar de Amatron gingen. Zet de optie terug op 0 voor gebruik met de tablet.

De led op de ESP32 knippert bij elke positie en brandt continu bij een RTK-fix.

## Voor ontwikkelaars

De app staat in `app/src`: `brand.js` voor naam en versie, `app.js` voor het scherm, `store.js` voor de opslag op de tablet, `sync.js` voor Google Drive, `box.js` om het kastje in de hotspot te vinden en losse modules voor NMEA, geometrie, ISOXML en ZIP. Na een wijziging bouw je ze opnieuw. Dat maakt `app/dist` en `firmware/trekker_gps/web_app.h`:

```
python3 tools/build_web.py
```

Tests:

```
g++ -std=c++17 -Wall -Wextra -I firmware/trekker_gps test/test_nmea.cpp -o test_nmea && ./test_nmea
node --test test/app.test.js test/drive_script.test.js
NODE_PATH=$(npm root -g) node test/e2e_demo.cjs
```

De laatste test rijdt met de demo-tractor door de app in een echte browser. Hij controleert de percelen, het bewaren na herladen, de ISOXML-export, de opslag in een nagebootste Drive en de verbinding met een nagebootst kastje via de hotspot. Daarvoor is Playwright nodig.

Bij elke push naar GitHub draaien de tests automatisch. Op de hoofdbranch wordt de app daarna gepubliceerd op GitHub Pages. Zet dat één keer aan via Settings, Pages, Source: **GitHub Actions**.

## Nog na te kijken op de echte hardware

- De pinnen van de seriële aansluiting op jouw Amatron 3-kabel.
- Of je Amatron-versie `$GNGGA` aanvaardt of `$GPGGA` nodig heeft.
- Of de Amatron 3 of je bedrijfssoftware de ISOXML-export van de app zonder fouten inleest.
- De hotspot-verbinding met je eigen tablet, en of Chrome daar om toestemming voor het lokale netwerk vraagt.
- Of het kastje zijn adres aan Drive kan melden.
- De Drive-koppeling met een echt Google-account.
- De LC29H-instelcommando's (`PAIR050` en `PAIR062`). Ze volgen de Quectel-documentatie, maar zijn nog niet op een echte module getest.
