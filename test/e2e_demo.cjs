// Test van de hele app in een echte browser, met de demo-tractor.
//   python3 tools/build_web.py && NODE_PATH=$(npm root -g) node test/e2e_demo.cjs [map-voor-uitvoer]
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'dist', 'index.html'));

function check(cond, msg) {
  if (!cond) { console.error('FOUT: ' + msg); process.exitCode = 1; } else console.log('ok: ' + msg);
}

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/';

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.accept());
  await page.clock.install();
  await page.goto(url);

  await page.click('#btnSettings');
  await page.fill('#setField', 'Achter de schuur');
  await page.fill('#setCustomer', 'Snoeck');
  await page.fill('#setWidth', '12');
  await page.click('#connDemo');
  await page.clock.runFor(2000);
  check(await page.textContent('#fix') === 'RTK fix', 'demo geeft RTK fix');

  // Grens: de demo rijdt eerst rond een perceel van 200 x 120 m aan 12 km/u (192 s).
  await page.click('#btnBoundary');
  await page.clock.runFor(191000);
  await page.click('#btnBoundary');
  const st1 = await page.evaluate(() => TG.appState());
  const area = await page.evaluate(() => TG.geo.areaLatLon(TG.appState().field.boundary));
  check(Math.abs(area - 24000) < 600, 'perceeloppervlakte ' + Math.round(area) + ' m², verwacht ongeveer 24000');
  check(st1.field.boundary.length > 400, 'grens heeft ' + st1.field.boundary.length + ' punten');

  // Werken: 2 minuten aan 12 km/u met 12 m werkbreedte.
  await page.click('#btnWork');
  await page.clock.runFor(120000);
  await page.click('#btnWork');
  const st2 = await page.evaluate(() => TG.appState());
  check(Math.abs(st2.field.workedM2 - 400 * 12) < 300, 'bewerkt ' + Math.round(st2.field.workedM2) + ' m², verwacht ongeveer 4800');
  check(Math.abs(st2.field.log.length - 120) <= 2, 'spoor heeft ' + st2.field.log.length + ' punten');
  check(await page.textContent('#areaField') === '2,40 ha', 'scherm toont ' + await page.textContent('#areaField'));

  // Blijft bewaard na herladen.
  await page.reload();
  await page.clock.runFor(1000);
  const st3 = await page.evaluate(() => TG.appState());
  check(st3.field.boundary.length === st1.field.boundary.length && st3.field.log.length === st2.field.log.length,
    'perceel blijft bewaard na herladen');
  await page.clock.runFor(30000);
  await page.click('#btnWork');
  await page.clock.runFor(20000);

  await page.screenshot({ path: path.join(outDir, 'trekker-gps-demo.png') });
  await page.click('#btnWork');  // werk uit, zodat het spoor niet meer groeit tijdens de export

  // Export
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  const zipPath = path.join(outDir, download.suggestedFilename());
  await download.saveAs(zipPath);
  check(/^TASKDATA_Achter_de_schuur_\d{8}\.zip$/.test(download.suggestedFilename()), 'bestandsnaam ' + download.suggestedFilename());
  const info = JSON.parse(execFileSync('python3', ['-I', '-c', `
import sys, json, zipfile, xml.etree.ElementTree as E
z = zipfile.ZipFile(sys.argv[1])
root = E.fromstring(z.read("TASKDATA/TASKDATA.XML"))
E.fromstring(z.read("TASKDATA/TLG00001.XML"))
print(json.dumps({
  "names": sorted(z.namelist()),
  "pnt": len(root.findall("./PFD/PLN/LSG/PNT")),
  "area": int(root.find("PFD").get("D")),
  "customer": root.find("CTR").get("B"),
  "binLen": len(z.read("TASKDATA/TLG00001.BIN")),
}))`, zipPath]).toString());
  const st4 = await page.evaluate(() => TG.appState());
  check(info.names.join() === 'TASKDATA/TASKDATA.XML,TASKDATA/TLG00001.BIN,TASKDATA/TLG00001.XML', 'zip bevat ' + info.names.join(', '));
  check(info.pnt === st4.field.boundary.length + 1, 'grens in ISOXML: ' + info.pnt + ' punten');
  check(Math.abs(info.area - 24000) < 600, 'oppervlakte in ISOXML: ' + info.area + ' m²');
  check(info.customer === 'Snoeck', 'klant in ISOXML');
  check(info.binLen === st4.field.log.length * 16, 'TimeLog: ' + info.binLen + ' bytes voor ' + st4.field.log.length + ' punten');

  check(errors.length === 0, 'geen JavaScript-fouten' + (errors.length ? ': ' + errors.join('; ') : ''));

  // Ook op een tablet in staande stand
  await page.setViewportSize({ width: 800, height: 1280 });
  await page.clock.runFor(500);
  await page.screenshot({ path: path.join(outDir, 'trekker-gps-staand.png') });

  await browser.close();
  server.close();
  console.log('Uitvoer in ' + outDir);
})().catch(e => { console.error(e); process.exit(1); });
