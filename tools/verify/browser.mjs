// Drives the built dist/ in headless Chrome at desktop and mobile widths.
// node tools/verify/browser.mjs [--today YYYY-MM-DD] [--out .verify]   (run verify_release.py first so dist/ matches --today)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TODAY = arg('--today', new Date().toISOString().slice(0, 10));
const OUT = path.resolve(ROOT, arg('--out', '.verify'));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.txt': 'text/plain' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = path.join(DIST, p);
  if (!f.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404, { 'content-type': TYPES['.html'] }).end(fs.readFileSync(path.join(DIST, '404.html'))); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const pages = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/.pages.json'), 'utf8')).map(p => p.path);
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true } };
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const fail = (where, msg) => fails.push(`${where}: ${msg}`);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

for (const [vp, opt] of Object.entries(VIEWPORTS)) {
  const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
    hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  for (const p of pages) {
    const where = `${vp} ${p}`;
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    const bad = [];
    page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    page.on('requestfailed', r => { if (r.url().startsWith(BASE)) bad.push(`request failed: ${r.url()}`); });
    page.on('response', r => { if (r.url().startsWith(BASE) && r.status() >= 400) bad.push(`HTTP ${r.status()}: ${r.url().slice(BASE.length)}`); });

    const res = await page.goto(BASE + p, { waitUntil: 'load' });
    if (!res || res.status() !== 200) fail(where, `status ${res && res.status()}`);
    await page.evaluate(() => { for (const i of document.images) i.loading = 'eager'; });
    await page.waitForLoadState('networkidle');

    const st = await page.evaluate(() => {
      const next = document.getElementById('next');
      const visibleCards = [...document.querySelectorAll('.pk')].filter(e => e.offsetParent).length;
      const brokenImgs = [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src'));
      return { nextHidden: next.hidden, nextDay: next.dataset.day, nextText: next.innerText.replace(/\s+/g, ' '),
        visibleCards, brokenImgs, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    if (st.nextHidden) fail(where, '次の発売日 card is hidden');
    else if (st.nextDay < TODAY) fail(where, `次の発売日 points to past date ${st.nextDay}`);
    if (!st.visibleCards && !st.nextHidden) {
      // the current month can be empty for a title; the next-release button opens that day's items instead
      await page.locator('#next').click();
      await page.waitForTimeout(300);
      const n = await page.evaluate(() => document.getElementById('dlg').open ? document.querySelectorAll('#dlgBody [data-star-id]').length : 0);
      if (!n) fail(where, 'month is empty and 次の発売日 opens no items');
      else await page.locator('#dlgClose').click();
    } else if (!st.visibleCards) fail(where, 'no visible release cards');
    if (st.brokenImgs.length) fail(where, `broken images ${st.brokenImgs.slice(0, 3).join(', ')}`);
    if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
    for (const b of [...new Set(bad)]) fail(where, b);

    if (p === '/') try {
      if (await page.locator('#filterBtn').isVisible()) await page.locator('#filterBtn').click();
      const chip = page.locator('#chips .chip:not(.all):not(.toggle):not(.starchip)').first();
      await chip.click();
      if (await chip.getAttribute('aria-pressed') !== 'true') fail(where, 'title chip did not toggle on');
      await chip.click();
      const star = page.locator('.pkw .star').filter({ visible: true }).first();
      if (await star.count()) {
        await star.click();
        await page.waitForTimeout(200);
        const starred = await page.locator('.pkw.on').count();
        const dlg = await page.evaluate(() => document.getElementById('dlg').open);
        if (!starred) fail(where, 'star click did not mark a card');
        if (dlg) await page.locator('#dlgClose').click();
      } else fail(where, 'no visible star button');
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    await page.screenshot({ path: path.join(OUT, `${vp}-${p.replace(/\//g, '') || 'home'}.png`), fullPage: false });
    console.log(`  ${where.padEnd(22)} next=${st.nextDay} cards=${st.visibleCards}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
server.close();
for (const f of fails) console.log('FAIL', f);
console.log('RESULT', fails.length ? 'FAIL' : 'PASS', `(${fails.length} fail) screenshots: ${OUT}`);
process.exit(fails.length ? 1 : 0);
