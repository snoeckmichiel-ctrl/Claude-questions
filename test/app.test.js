// Tests voor de rekenmodules van de app:  node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nmea = require('../app/src/nmea.js');
const geo = require('../app/src/geo.js');
const isoxml = require('../app/src/isoxml.js');
const zip = require('../app/src/zip.js');
const demo = require('../app/src/demo.js');

test('NMEA: checksum en coördinaten', () => {
  const gga = '$GPGGA,092750.000,5321.6802,N,00630.3372,W,1,8,1.03,61.7,M,55.2,M,,*76';
  assert.ok(nmea.checksumOk(gga));
  assert.ok(!nmea.checksumOk(gga.replace('*76', '*77')));
  const s = nmea.parseSentence(gga);
  assert.strictEqual(s.type, 'GGA');
  assert.ok(Math.abs(s.lat - 53.361336667) < 1e-8);
  assert.ok(Math.abs(s.lon - -6.50562) < 1e-8);
  assert.strictEqual(s.quality, 1);
  assert.strictEqual(s.sats, 8);
  assert.strictEqual(s.timeUtc, ((9 * 60 + 27) * 60 + 50) * 1000);
  assert.strictEqual(nmea.withChecksum('PAIR050,1000'), '$PAIR050,1000*12');
});

test('NMEA: stroom met gebroken regels en rommel', () => {
  const got = [];
  const p = new nmea.NmeaParser(pos => got.push(pos));
  const rmc = nmea.withChecksum('GNRMC,120000.00,A,5103.2580,N,00343.0440,E,6.48,90.0,161026,,,R,V');
  const gga = nmea.withChecksum('GNGGA,120000.00,5103.2580,N,00343.0440,E,4,20,0.6,15.0,M,46.0,M,1.0,0000');
  const vtg = nmea.withChecksum('GNVTG,90.0,T,,M,6.48,N,12.00,K,R');
  const text = 'rommel\r\n' + rmc + '\r\n' + gga.slice(0, 20);
  p.feed(text);
  p.feed(gga.slice(20) + '\r\n$GNGGA,kapot*00\r\n' + vtg + '\r\n');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].quality, 4);
  assert.strictEqual(got[0].date, '2026-10-16');
  assert.ok(Math.abs(got[0].speedKmh - 12.0) < 0.01);  // uit RMC
  assert.strictEqual(p.state.speedKmh, 12);           // daarna uit VTG
  assert.strictEqual(p.badLines, 1);
});

test('NMEA: GGA zonder fix geeft geen positie', () => {
  const got = [];
  const p = new nmea.NmeaParser(pos => got.push(pos));
  p.feed(nmea.withChecksum('GNGGA,120000.00,,,,,0,00,99.9,,M,,M,,') + '\r\n');
  assert.strictEqual(got.length, 0);
  assert.strictEqual(p.state.quality, 0);
});

test('Geo: oppervlakte van een rechthoek van 200 x 100 m', () => {
  const f = new geo.LocalFrame(51.05, 3.72);
  const corners = [[0, 0], [200, 0], [200, 100], [0, 100]].map(([x, y]) => f.toLatLon(x, y));
  const area = geo.areaLatLon(corners);
  assert.ok(Math.abs(area - 20000) < 1, 'oppervlakte ' + area);
  const back = f.toXY(corners[2].lat, corners[2].lon);
  assert.ok(Math.abs(back.x - 200) < 1e-6 && Math.abs(back.y - 100) < 1e-6);
});

test('Demo: rijdt aan de ingestelde snelheid en maakt geldige NMEA', () => {
  const got = [];
  const p = new nmea.NmeaParser(pos => got.push(pos));
  const d = new demo.DemoTractor(t => p.feed(t), { speedKmh: 18, hz: 5 });
  for (let i = 0; i < 50; i++) d.step(0.2);  // 10 seconden
  assert.strictEqual(got.length, 50);
  assert.strictEqual(p.badLines, 0);
  const f = new geo.LocalFrame(got[0].lat, got[0].lon);
  const a = f.toXY(got[0].lat, got[0].lon), b = f.toXY(got[49].lat, got[49].lon);
  assert.ok(Math.abs(geo.distance(a, b) - 49) < 0.5, 'afstand ' + geo.distance(a, b));  // 5 m/s x 9,8 s
});

test('ISOXML: TimeLog-records hebben de juiste bytes', () => {
  const t = new Date(2026, 9, 16, 14, 5, 9, 250).getTime();  // lokale tijd
  const bin = isoxml.buildTimeLogBin([{ t, lat: 51.0543123, lon: 3.7174456, quality: 4 }]);
  assert.strictEqual(bin.length, 16);
  const v = new DataView(bin.buffer);
  assert.strictEqual(v.getUint32(0, true), ((14 * 60 + 5) * 60 + 9) * 1000 + 250);
  assert.strictEqual(v.getUint16(4, true), Math.round((Date.UTC(2026, 9, 16) - Date.UTC(1980, 0, 1)) / 86400000));
  assert.strictEqual(v.getInt32(6, true), 510543123);
  assert.strictEqual(v.getInt32(10, true), 37174456);
  assert.strictEqual(v.getUint8(14), 4);
  assert.strictEqual(v.getUint8(15), 0);
});

test('ISOXML: volledige taak met grens en spoor', () => {
  const boundary = [{ lat: 51.0, lon: 3.7 }, { lat: 51.001, lon: 3.7 }, { lat: 51.001, lon: 3.702 }];
  const t0 = new Date(2026, 9, 16, 10, 0, 0).getTime();
  const log = [0, 1, 2].map(i => ({ t: t0 + i * 1000, lat: 51.0005, lon: 3.701 + i * 1e-5, quality: 4 }));
  const files = isoxml.buildTaskData({ customer: 'Jan & Zoon', farm: 'Hoeve "De Linde"', field: 'Achter de schuur',
    boundary, areaM2: 12345.6, log });
  assert.deepStrictEqual(Object.keys(files).sort(),
    ['TASKDATA/TASKDATA.XML', 'TASKDATA/TLG00001.BIN', 'TASKDATA/TLG00001.XML']);
  const xml = files['TASKDATA/TASKDATA.XML'];
  assert.match(xml, /VersionMajor="3"/);
  assert.match(xml, /<CTR A="CTR1" B="Jan &amp; Zoon"\/>/);
  assert.match(xml, /<FRM A="FRM1" B="Hoeve &quot;De Linde&quot;" I="CTR1"\/>/);
  assert.match(xml, /<PFD A="PFD1" C="Achter de schuur" D="12346" E="CTR1" F="FRM1">/);
  assert.strictEqual((xml.match(/<PNT /g) || []).length, 4);  // 3 punten + sluiting
  assert.match(xml, /<TSK A="TSK1" B="Achter de schuur" C="CTR1" D="FRM1" E="PFD1" G="4">/);
  assert.match(xml, /<TIM A="2026-10-16T10:00:00" B="2026-10-16T10:00:02" D="4"\/>/);
  assert.strictEqual(files['TASKDATA/TLG00001.BIN'].length, 48);

  // XML moet goed gevormd zijn.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isoxml-'));
  fs.writeFileSync(path.join(dir, 'TASKDATA.XML'), xml);
  fs.writeFileSync(path.join(dir, 'TLG00001.XML'), files['TASKDATA/TLG00001.XML']);
  execFileSync('python3', ['-I', '-c',
    'import sys, xml.etree.ElementTree as E\nfor f in sys.argv[1:]: E.parse(f)',
    path.join(dir, 'TASKDATA.XML'), path.join(dir, 'TLG00001.XML')]);
});

test('ISOXML: taak zonder spoor en zonder klant', () => {
  const files = isoxml.buildTaskData({ field: 'Weide' });
  assert.deepStrictEqual(Object.keys(files), ['TASKDATA/TASKDATA.XML']);
  const xml = files['TASKDATA/TASKDATA.XML'];
  assert.doesNotMatch(xml, /<CTR|<FRM|<PLN|<TLG/);
  assert.match(xml, /<TSK A="TSK1" B="Weide" E="PFD1" G="1">/);
});

test('ZIP: bestand is leesbaar met een standaard unzip', () => {
  const files = isoxml.buildTaskData({ field: 'Test', log: [{ t: Date.now(), lat: 51, lon: 3.7, quality: 1 }] });
  const z = zip.makeZip(files);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const file = path.join(dir, 'taak.zip');
  fs.writeFileSync(file, z);
  const out = execFileSync('python3', ['-I', '-c',
    'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n' +
    'print("\\n".join(sorted(z.namelist())))', file]).toString().trim().split('\n');
  assert.deepStrictEqual(out, ['TASKDATA/TASKDATA.XML', 'TASKDATA/TLG00001.BIN', 'TASKDATA/TLG00001.XML']);
  assert.strictEqual(zip.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});
