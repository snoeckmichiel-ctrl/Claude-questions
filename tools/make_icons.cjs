// Maakt de app-pictogrammen.  NODE_PATH=$(npm root -g) node tools/make_icons.cjs
const { chromium } = require('playwright');
const path = require('node:path');

const mark = (size, inset) => `<!doctype html><html><body style="margin:0">
<div style="width:${size}px;height:${size}px;background:#14532d;border-radius:${inset ? 0 : size * 0.22}px;display:grid;place-items:center">
<svg viewBox="0 0 24 24" width="${size * (inset ? 0.5 : 0.62)}" height="${size * (inset ? 0.5 : 0.62)}" fill="none" stroke="#fff"
 stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/></svg></div></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const out = path.join(__dirname, '..', 'app', 'static');
  for (const [name, size, inset] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(mark(size, inset));
    await page.screenshot({ path: path.join(out, name), omitBackground: true });
    await page.close();
  }
  await browser.close();
  console.log('Pictogrammen gemaakt in app/static');
})();
