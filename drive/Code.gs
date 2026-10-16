/**
 * Trekker-GPS: percelen opslaan in je eigen Google Drive.
 *
 * Installatie: zie "Opslaan in Google Drive" in README.md.
 * Kort: plak dit in een nieuw project op script.google.com, kies een eigen SLEUTEL,
 * implementeer als web-app (uitvoeren als: ik, toegang: iedereen) en vul de URL
 * en de sleutel in bij Instellingen in de app.
 *
 * In Drive komt een map "Trekker-GPS" met:
 *   ISOXML/       per perceel een TASKDATA-zip voor de terminal of bedrijfssoftware
 *   _gegevens/    volledige reservekopie per perceel, om terug te zetten op een tablet
 *   Overzicht     Google Sheet met één regel per perceel
 *
 * Het GPS-kastje meldt hier ook zijn adres in de hotspot van de tablet, zodat de
 * app het kastje meteen vindt.
 */

const SLEUTEL = 'verander-dit-in-een-eigen-geheim';  // zelfde sleutel als in de app
const MAP_NAAM = 'Trekker-GPS';
const KOLOMMEN = ['Datum', 'Perceel', 'Klant', 'Bedrijf', 'Oppervlakte (ha)', 'Bewerkt (ha)',
  'Werkbreedte (m)', 'Laatst bijgewerkt', 'ISOXML', 'ID'];

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'announce') return antwoord(meldKastje(p));
  return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">De Drive-koppeling van Trekker-GPS werkt.</p>');
}

// Het kastje meldt zijn adres, bv. 192.168.57.200.
function meldKastje(p) {
  if (p.key !== SLEUTEL) return { ok: false, error: 'Verkeerde sleutel' };
  const ip = String(p.ip || '');
  if (!/^(10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return { ok: false, error: 'Ongeldig adres' };
  PropertiesService.getScriptProperties().setProperty('kastje',
    JSON.stringify({ ip: ip, version: String(p.version || '').slice(0, 20), at: Date.now() }));
  return { ok: true };
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.key !== SLEUTEL) return antwoord({ ok: false, error: 'Verkeerde sleutel' });
    switch (req.action) {
      case 'ping': return antwoord({ ok: true, folder: hoofdmap().getUrl() });
      case 'save': return antwoord(bewaar(req));
      case 'list': return antwoord({ ok: true, jobs: lijst() });
      case 'get': return antwoord(haalOp(req.id));
      case 'whereis': return antwoord({ ok: true, box: JSON.parse(PropertiesService.getScriptProperties().getProperty('kastje') || 'null') });
      default: return antwoord({ ok: false, error: 'Onbekende actie' });
    }
  } catch (err) {
    return antwoord({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function antwoord(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function hoofdmap() {
  const it = DriveApp.getFoldersByName(MAP_NAAM);
  return it.hasNext() ? it.next() : DriveApp.createFolder(MAP_NAAM);
}

function submap(ouder, naam) {
  const it = ouder.getFoldersByName(naam);
  return it.hasNext() ? it.next() : ouder.createFolder(naam);
}

function veiligeId(id) {
  if (!/^[a-z0-9]{6,40}$/.test(String(id))) throw new Error('Ongeldig perceel-ID');
  return String(id);
}

// Oude versies van hetzelfde perceel naar de prullenbak, zodat er geen dubbels ontstaan.
function vervang(map, deelNaam, blob) {
  const it = map.searchFiles('title contains "' + deelNaam + '" and trashed = false');
  while (it.hasNext()) it.next().setTrashed(true);
  return map.createFile(blob);
}

function bewaar(req) {
  const job = req.job;
  const id = veiligeId(job && job.id);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const root = hoofdmap();
    vervang(submap(root, '_gegevens'), id + '.json',
      Utilities.newBlob(JSON.stringify(job), 'application/json', id + '.json'));
    let zipUrl = '';
    if (req.zipBase64) {
      const naam = String(req.zipName || ('TASKDATA_' + id + '.zip')).replace(/[\\/]/g, '_');
      const bestand = vervang(submap(root, 'ISOXML'), id,
        Utilities.newBlob(Utilities.base64Decode(req.zipBase64), 'application/zip', naam));
      zipUrl = bestand.getUrl();
    }
    werkOverzichtBij(req.summary || {}, id, zipUrl);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function overzicht() {
  const props = PropertiesService.getScriptProperties();
  const bestaand = props.getProperty('overzichtId');
  if (bestaand) {
    try { return SpreadsheetApp.openById(bestaand).getSheets()[0]; } catch (e) { /* verwijderd, opnieuw maken */ }
  }
  const ss = SpreadsheetApp.create('Trekker-GPS overzicht');
  DriveApp.getFileById(ss.getId()).moveTo(hoofdmap());
  const sheet = ss.getSheets()[0];
  sheet.appendRow(KOLOMMEN);
  sheet.setFrozenRows(1);
  props.setProperty('overzichtId', ss.getId());
  return sheet;
}

function werkOverzichtBij(s, id, zipUrl) {
  const sheet = overzicht();
  const rij = [
    new Date(s.createdAt || Date.now()), s.name || '', s.customer || '', s.farm || '',
    Math.round((s.areaM2 || 0) / 100) / 100, Math.round((s.workedM2 || 0) / 100) / 100,
    s.workWidth || '', new Date(s.updatedAt || Date.now()), zipUrl, id,
  ];
  const waarden = sheet.getDataRange().getValues();
  for (let r = 1; r < waarden.length; r++) {
    if (waarden[r][9] === id) {
      sheet.getRange(r + 1, 1, 1, rij.length).setValues([rij]);
      return;
    }
  }
  sheet.appendRow(rij);
}

function lijst() {
  const waarden = overzicht().getDataRange().getValues();
  const uit = [];
  for (let r = 1; r < waarden.length; r++) {
    const w = waarden[r];
    if (!w[9]) continue;
    uit.push({
      id: String(w[9]), name: w[1], customer: w[2], farm: w[3],
      createdAt: w[0] instanceof Date ? w[0].getTime() : 0, areaM2: Number(w[4]) * 10000,
      workedM2: Number(w[5]) * 10000, updatedAt: w[7] instanceof Date ? w[7].getTime() : 0,
    });
  }
  return uit;
}

function haalOp(id) {
  const veilig = veiligeId(id);
  const it = submap(hoofdmap(), '_gegevens').getFilesByName(veilig + '.json');
  if (!it.hasNext()) return { ok: false, error: 'Perceel niet gevonden in Drive' };
  return { ok: true, job: JSON.parse(it.next().getBlob().getDataAsString()) };
}
