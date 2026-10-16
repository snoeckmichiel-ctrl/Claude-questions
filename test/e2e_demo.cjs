// Test van de hele app in een echte browser, met de demo-tractor en een nagebootste Drive-koppeling.
//   python3 tools/build_web.py && NODE_PATH=$(npm root -g) node test/e2e_demo.cjs [map-voor-uitvoer]
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const distDir = path.join(__dirname, '..', 'app', 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function check(cond, msg) {
  if (!cond) { console.error('FOUT: ' + msg); process.exitCode = 1; } else console.log('ok: ' + msg);
}

// Nagebootste Apps Script: zelfde acties, met een omleiding zoals Google die doet.
function driveMock() {
  const saved = new Map();
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/exec') && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const id = 'r' + calls.length;
        calls.push({ id, contentType: req.headers['content-type'], body: JSON.parse(body) });
        res.writeHead(302, { Location: '/echo?id=' + id, 'Access-Control-Allow-Origin': '*' });
        res.end();
      });
      return;
    }
    if (req.url.startsWith('/echo')) {
      const call = calls.find(c => c.id === new URL(req.url, 'http://x').searchParams.get('id'));
      const b = call.body;
      let out;
      if (b.key !== 'geheim') out = { ok: false, error: 'Verkeerde sleutel' };
      else if (b.action === 'ping') out = { ok: true };
      else if (b.action === 'save') { saved.set(b.job.id, b); out = { ok: true }; }
      else if (b.action === 'list') out = { ok: true, jobs: [...saved.values()].map(s => s.summary) };
      else if (b.action === 'get') out = { ok: true, job: saved.get(b.id).job };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(out));
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, saved, calls };
}

(async () => {
  const app = http.createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0].slice(1));
    const file = path.join(distDir, path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + app.address().port + '/';
  const drive = driveMock();
  await new Promise(r => drive.server.listen(0, '127.0.0.1', r));
  const driveUrl = 'http://127.0.0.1:' + drive.server.address().port + '/exec';

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.clock.install();
  await page.goto(url);
  await page.evaluate(() => TG.ready);
  await page.clock.runFor(300);
  check(await page.isVisible('#welcome'), 'welkomstscherm bij eerste start');
  check(await page.isVisible('#welBle'), 'Bluetooth staat bij de keuzes');
  await page.screenshot({ path: path.join(outDir, '1-welkom.png') });

  await page.click('#welDemo');
  await page.clock.runFor(2000);
  check(!(await page.isVisible('#welcome')), 'welkomstscherm verdwijnt bij GPS-positie');
  check(await page.textContent('#fix') === 'RTK fix', 'demo geeft RTK fix');

  await page.click('#btnSettings');
  await page.fill('#setField', 'Achter de schuur');
  await page.fill('#setCustomer', 'Snoeck');
  await page.fill('#setFarm', 'Hoeve De Linde');
  await page.fill('#setWidth', '12');
  await page.clock.runFor(300);
  await page.click('#settings button[value="close"]');
  await page.clock.runFor(200);
  check(await page.textContent('#fieldName') === 'Achter de schuur', 'perceelnaam in de bovenbalk');

  // Grens: de demo rijdt eerst rond een perceel van 200 x 120 m aan 12 km/u (192 s).
  await page.click('#btnBoundary');
  await page.clock.runFor(100000);
  check(await page.isVisible('#banner'), 'melding tijdens grens opnemen');
  await page.screenshot({ path: path.join(outDir, '2-grens-opnemen.png') });
  await page.clock.runFor(91000);
  await page.click('#bannerDone');
  const st1 = await page.evaluate(() => TG.appState().job);
  const area = await page.evaluate(() => TG.geo.areaLatLon(TG.appState().job.boundary));
  check(Math.abs(area - 24000) < 600, 'perceeloppervlakte ' + Math.round(area) + ' m², verwacht ongeveer 24000');

  // Werken: 2 minuten aan 12 km/u met 12 m werkbreedte.
  await page.click('#btnWork');
  await page.clock.runFor(120000);
  await page.screenshot({ path: path.join(outDir, '3-werken.png') });
  await page.click('#btnWork');
  const st2 = await page.evaluate(() => TG.appState().job);
  check(Math.abs(st2.workedM2 - 4800) < 300, 'bewerkt ' + Math.round(st2.workedM2) + ' m², verwacht ongeveer 4800');
  check(Math.abs(st2.log.length - 120) <= 2, 'spoor heeft ' + st2.log.length + ' punten');
  check(await page.textContent('#areaField') === '2,40 ha', 'scherm toont ' + await page.textContent('#areaField'));

  // Opslag in de databank van de tablet overleeft herladen.
  await page.clock.runFor(4000);
  await page.reload();
  await page.evaluate(() => TG.ready);
  await page.clock.runFor(1000);
  const st3 = await page.evaluate(() => TG.appState().job);
  check(st3.id === st1.id && st3.boundary.length === st1.boundary.length && st3.log.length === st2.log.length,
    'perceel blijft bewaard na herladen');
  check(await page.textContent('#fieldName') === 'Achter de schuur', 'naam blijft bewaard');

  // Tweede perceel aanmaken, daarna terug naar het eerste.
  await page.click('#btnJobs');
  await page.clock.runFor(300);
  await page.click('#newJob');
  await page.clock.runFor(300);
  await page.fill('#setField', 'Weide');
  await page.click('#settings button[value="close"]');
  await page.clock.runFor(4000);
  await page.click('#btnJobs');
  await page.clock.runFor(300);
  const rows = await page.$$eval('#jobList .job h4', els => els.map(e => e.childNodes[0].textContent));
  check(rows.length === 2 && rows.includes('Weide') && rows.includes('Achter de schuur'), 'percelenlijst: ' + rows.join(', '));
  await page.screenshot({ path: path.join(outDir, '4-percelen.png') });
  await page.click('#jobList .job:not(.current) .open');
  await page.clock.runFor(500);
  check(await page.textContent('#fieldName') === 'Achter de schuur', 'eerste perceel terug geopend');
  check(await page.evaluate(() => TG.appState().job.log.length) === st2.log.length, 'rijspoor terug geladen');

  // Export van het actieve perceel vanuit de lijst.
  await page.click('#btnJobs');
  await page.clock.runFor(300);
  await page.click('#jobList .job.current .exp');
  await page.clock.runFor(300);
  await page.screenshot({ path: path.join(outDir, '5-export.png') });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportDownload')]);
  const zipPath = path.join(outDir, download.suggestedFilename());
  await download.saveAs(zipPath);
  const info = JSON.parse(execFileSync('python3', ['-I', '-c', `
import sys, json, zipfile, xml.etree.ElementTree as E
z = zipfile.ZipFile(sys.argv[1])
root = E.fromstring(z.read("TASKDATA/TASKDATA.XML"))
print(json.dumps({"names": sorted(z.namelist()), "pnt": len(root.findall("./PFD/PLN/LSG/PNT")),
  "customer": root.find("CTR").get("B"), "binLen": len(z.read("TASKDATA/TLG00001.BIN"))}))`, zipPath]).toString());
  check(info.names.length === 3, 'zip bevat ' + info.names.join(', '));
  check(info.pnt === st1.boundary.length + 1, 'grens in ISOXML: ' + info.pnt + ' punten');
  check(info.customer === 'Snoeck', 'klant in ISOXML');
  check(info.binLen === st2.log.length * 16, 'TimeLog: ' + info.binLen + ' bytes');

  // Google Drive instellen, testen en opslaan.
  await page.click('#btnSettings');
  await page.fill('#setDriveUrl', driveUrl);
  await page.fill('#setDriveKey', 'fout');
  await page.click('#driveTest');
  await page.waitForFunction(() => /Geen verbinding/.test(document.getElementById('driveStatus').textContent));
  const wrongKeyText = await page.textContent('#driveStatus');
  check(/Verkeerde sleutel/.test(wrongKeyText), 'verkeerde sleutel wordt gemeld: ' + wrongKeyText);
  await page.fill('#setDriveKey', 'geheim');
  await page.click('#driveTest');
  await page.waitForFunction(() => /Verbonden/.test(document.getElementById('driveStatus').textContent));
  check(drive.calls.every(c => /^text\/plain/.test(c.contentType)), 'Drive-verzoeken als text/plain, zonder CORS-voorcontrole');
  await page.click('#driveSync');
  await page.waitForFunction(() => /percelen opgeslagen in Drive|perceel opgeslagen in Drive|staat al in Drive/.test(document.getElementById('driveStatus').textContent));
  await page.screenshot({ path: path.join(outDir, '6-drive.png') });
  await page.click('#settings button[value="close"]');
  check(drive.saved.size === 2, 'beide percelen in Drive: ' + drive.saved.size);
  const savedFirst = drive.saved.get(st1.id);
  check(savedFirst && savedFirst.job.boundary.length === st1.boundary.length && savedFirst.zipBase64.length > 100,
    'Drive kreeg grens, rijspoor en ISOXML-zip');
  const pending = await page.evaluate(() => TG.appState().sync.pendingCount());
  check(pending === 0, 'niets meer te synchroniseren');
  await page.click('#btnJobs');
  await page.clock.runFor(300);
  check((await page.$$('#jobList .badge.ok')).length === 2, 'lijst toont "In Drive" bij beide percelen');
  await page.click('#jobsDialog button[value="close"]');

  check(errors.length === 0, 'geen JavaScript-fouten' + (errors.length ? ': ' + errors.join('; ') : ''));

  // Nieuwe tablet: lege browser haalt de percelen terug uit Drive.
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page2 = await ctx2.newPage();
  page2.on('pageerror', e => errors.push('tablet 2: ' + e));
  await page2.goto(url);
  await page2.evaluate(() => TG.ready);
  await page2.click('#fieldBtn');
  await page2.fill('#setDriveUrl', driveUrl);
  await page2.fill('#setDriveKey', 'geheim');
  await page2.click('#settings button[value="close"]');
  await page2.click('#welDemo');
  await page2.waitForTimeout(500);
  await page2.click('#btnJobs');
  await page2.click('#driveRestore');
  await page2.waitForSelector('#remoteList .restore');
  const remoteCount = (await page2.$$('#remoteList .restore')).length;
  check(remoteCount === 2, 'nieuwe tablet ziet ' + remoteCount + ' percelen in Drive');
  await page2.click('#remoteList .job:has-text("Achter de schuur") .restore');
  await page2.waitForFunction(() => [...document.querySelectorAll('#jobList h4')].some(h => h.textContent.startsWith('Achter de schuur')));
  await page2.click('#jobList .job:has-text("Achter de schuur") .open');
  await page2.waitForTimeout(300);
  const restored = await page2.evaluate(() => TG.appState().job);
  check(restored.boundary.length === st1.boundary.length && restored.log.length === st2.log.length,
    'teruggehaald perceel is volledig');
  await ctx2.close();

  // Nachtmodus en andere schermen
  await page.click('#btnSettings');
  await page.click('#themeSel button[data-theme="dark"]');
  await page.click('#settings button[value="close"]');
  await page.clock.runFor(500);
  await page.screenshot({ path: path.join(outDir, '7-nacht.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.runFor(500);
  await page.screenshot({ path: path.join(outDir, '8-gsm.png') });
  check(errors.length === 0, 'geen JavaScript-fouten op het einde' + (errors.length ? ': ' + errors.join('; ') : ''));

  await browser.close();
  app.close();
  drive.server.close();
  console.log('Uitvoer in ' + outDir);
})().catch(e => { console.error(e); process.exit(1); });
