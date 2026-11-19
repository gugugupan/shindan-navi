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

const pages = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/.pages.json'), 'utf8')).map(p => p.path)
  .filter(p => p !== '/events/'); // needs the Worker API; see api/scripts/preview-check.mjs
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
      const visibleCards = [...document.querySelectorAll('.pk')].filter(e => e.offsetParent).length;
      const brokenImgs = [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src'));
      return { month: document.getElementById('monthLabel').textContent,
        noneUpcoming: (document.querySelector('.ptitle p')?.textContent || '').includes('発売予定の新弾はありません'),
        visibleCards, brokenImgs, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    const m = /^\/(\d{4})-(\d{2})\/$/.exec(p);
    const [wy, wm] = m ? [m[1], m[2]] : TODAY.split('-');
    const want = `${+wy}年${+wm}月`;
    if (st.month !== want) fail(where, `calendar opens on ${st.month}, expected ${want}`);
    let shown = st.visibleCards;
    if (!shown && !st.noneUpcoming && !m) {
      // a title can have nothing this month; its upcoming items must then be a few 次月 clicks away
      for (let i = 0; i < 3 && !shown; i++) {
        if (await page.locator('#nextM').isDisabled()) break;
        await page.locator('#nextM').click();
        shown = await page.evaluate(() => [...document.querySelectorAll('.pk')].filter(e => e.offsetParent).length);
      }
      if (shown) await page.locator('#goToday').click();
    }
    if (!shown && !st.noneUpcoming) fail(where, 'no visible release cards');
    if (st.brokenImgs.length) fail(where, `broken images ${st.brokenImgs.slice(0, 3).join(', ')}`);
    if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
    for (const b of [...new Set(bad)]) fail(where, b);

    if (p === '/releases/') try {
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
    await page.screenshot({ path: path.join(OUT, `${vp}-${p.replace(/\//g, '')}.png`), fullPage: false });
    console.log(`  ${where.padEnd(22)} month=${st.month} cards=${st.visibleCards}`);
    await page.close();
  }
  await ctx.close();
}
// / is the today page: today (Asia/Tokyo) from the embedded releases, favourites first, the saved location's events
// from at most 2 API requests (stubbed here; none without a location), and day deep links into /releases/.
for (const [vp, opt] of Object.entries(VIEWPORTS)) {
  const where = `${vp} /`;
  const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
    hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
  const bad = [], api = [];
  page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
  page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.url().startsWith(BASE) && r.status() >= 400) bad.push(`HTTP ${r.status()}: ${r.url().slice(BASE.length)}`); });
  await page.route('**/api/v1/**', route => {
    const u = new URL(route.request().url());
    api.push(u.pathname + u.search);
    const body = u.pathname.endsWith('/days') ? { days: [{ date: TODAY, count: 7 }] }
      : { events: Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, name: `テスト大会 ${i + 1}`, game_code: 'OPCG', game_codes: ['OPCG'],
        starts_on: TODAY, time_precision: 'datetime', starts_at: `${TODAY}T${String(10 + i).padStart(2, '0')}:00:00+09:00`, timezone: 'Asia/Tokyo',
        attendance_mode: 'offline', venue: { name: `テスト店 ${i + 1}` }, source_url: 'https://example.com/', event_status: 'scheduled' })) };
    route.fulfill({ json: body });
  });
  const res = await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  if (!res || res.status() !== 200) fail(where, `status ${res && res.status()}`);
  const H = await page.evaluate(() => JSON.parse(/const H = (\{.*?\});\n/s.exec(document.documentElement.innerHTML)[1]));
  const todays = H.items.filter(d => d.date === TODAY);
  const hasEvents = await page.locator('#evBody').count() > 0;
  const st = await page.evaluate(() => ({ date: document.getElementById('hDate').textContent, cards: document.querySelectorAll('#relBody a.pk').length,
    none: !!document.querySelector('#relBody .none'), days: document.querySelectorAll('#wkBody .wd').length,
    prompt: !!document.querySelector('#evBody .none a[href="/events/"]'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  const [, m, d] = TODAY.split('-').map(Number);
  if (!st.date.startsWith(`${m}月${d}日`)) fail(where, `date ${st.date}`);
  if (st.cards !== todays.length || (!todays.length && !st.none)) fail(where, `today shows ${st.cards} releases, data has ${todays.length}`);
  if (st.days !== 6) fail(where, `week shows ${st.days} days`);
  if (hasEvents && !st.prompt) fail(where, 'no location: the pick-a-location prompt is missing');
  if (api.length) fail(where, `API called without a location: ${api.join(' ')}`);
  if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
  await page.screenshot({ path: path.join(OUT, `${vp}-home-nopref.png`), fullPage: true });

  // a favourite and a saved location
  const fav = todays[todays.length - 1];
  await page.evaluate(([id]) => { localStorage.setItem('tcg.stars', JSON.stringify(id ? [id] : []));
    localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13,JP-14', game: 'OPCG', days: 'weekend' })); }, [fav && fav.id]);
  await page.reload({ waitUntil: 'networkidle' });
  if (fav) {
    const first = await page.locator('#relBody a.pk').first().getAttribute('href');
    if (first !== `/releases/#i=${fav.id}`) fail(where, `favourite not first: ${first}`);
  }
  if (hasEvents) {
    const ym = TODAY.slice(0, 7), next = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 1)).toISOString().slice(0, 10);
    const want = [`/api/v1/events/days?from=${ym}-01&until=${next}&game=OPCG&pref=JP-13`, `/api/v1/events?from=${TODAY}&until=${next}&game=OPCG&pref=JP-13&limit=50`];
    if (JSON.stringify([...api].sort()) !== JSON.stringify(want.sort())) fail(where, `API requests ${api.join(' ')}`);
    const ev = await page.evaluate(() => ({ rows: document.querySelectorAll('#evBody .ev').length, more: document.querySelector('#evBody a.go')?.getAttribute('href'),
      where: document.getElementById('evWhere').textContent }));
    if (ev.rows !== 5) fail(where, `today's events show ${ev.rows} rows`);
    if (ev.more !== `/events/?game=OPCG&pref=JP-13&range=custom&from=${TODAY}&to=${TODAY}`) fail(where, `day view link ${ev.more}`);
    if (!ev.where.startsWith('東京都')) fail(where, `location ${ev.where}`);
  }
  await page.screenshot({ path: path.join(OUT, `${vp}-home.png`), fullPage: true });
  for (const b of [...new Set(bad)]) fail(where, b);

  // deep links into the release calendar
  if (todays.length) {
    await page.goto(`${BASE}/releases/#d=${TODAY}`, { waitUntil: 'load' });
    const dlg = await page.evaluate(() => ({ open: document.getElementById('dlg').open, n: document.querySelectorAll('#dlgBody .dl-item').length, hash: location.hash }));
    if (!dlg.open || dlg.n !== todays.length || dlg.hash) fail(`${vp} /releases/#d=`, `dialog ${JSON.stringify(dlg)}`);
  }
  console.log(`  ${where.padEnd(22)} today=${todays.length} events=${hasEvents} api=${api.length}`);
  await ctx.close();
}
await browser.close();
server.close();
for (const f of fails) console.log('FAIL', f);
console.log('RESULT', fails.length ? 'FAIL' : 'PASS', `(${fails.length} fail) screenshots: ${OUT}`);
process.exit(fails.length ? 1 : 0);
