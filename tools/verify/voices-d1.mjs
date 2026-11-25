// /voices/ and the home page's いま話題 against the real Worker code (docs/design/voices-db.md). Seeds a throwaway SQLite
// database with the real importer from the made-up gate snapshots (tools/verify/voices-fixtures.mjs, the last one on
// --today; never the owner's data), serves dist/ and the API with api/scripts/dev-node.mjs, and drives both pages in
// headless Chrome at desktop and mobile widths. (tools/verify/browser.mjs covers the page's interactions with the
// same snapshots served by its own server.)
//
//   VOICES_ENABLED=1 .venv/bin/python -I scripts/verify_release.py --today YYYY-MM-DD   # builds dist/
//   node tools/verify/voices-d1.mjs --today YYYY-MM-DD [--out .verify]                  # needs api/node_modules
//
// Checks: the API answers the imported snapshots; one /api/v1/voices request; list sections and cards, この日のまとめ → /voices/#d=,
// the calendar, #t= deep links, loading and error states (an HTTP error, a malformed answer) with 再読み込み; the home
// block makes one /api/v1/voices/latest request and lists that snapshot's topics.
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshots as voiceSnapshots, writeSnapshots } from './voices-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'api');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TODAY = arg('--today', new Date().toISOString().slice(0, 10));
const OUT = path.resolve(ROOT, arg('--out', '.verify'));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(arg('--port', '8797'));
const BASE = `http://localhost:${PORT}`;

const page0 = path.join(ROOT, 'dist/voices/index.html');
if (!fs.existsSync(page0)) {
  console.error('voices-d1: dist/ has no /voices/; run VOICES_ENABLED=1 scripts/verify_release.py first');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const db = path.join(OUT, 'voices-d1.sqlite3');
for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
const dataDir = path.join(OUT, 'voices-d1-data');
writeSnapshots(dataDir, TODAY);
const imp = spawnSync(process.execPath, ['scripts/import-voices.mjs', '--data', dataDir, '--today', TODAY, '--target', 'sqlite', '--sqlite', db, '--yes'], { cwd: API, encoding: 'utf8' });
process.stdout.write(imp.stdout);
if (imp.status !== 0) { console.error(imp.stderr); process.exit(1); }

const server = spawn(process.execPath, ['scripts/dev-node.mjs', '--port', String(PORT), '--sqlite', db], { cwd: API, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, no) => {
  server.stdout.on('data', (b) => { if (String(b).includes('dev-node: http://')) ok(); });
  server.on('exit', (c) => no(new Error(`dev-node exited ${c}`)));
});

const want = await (await fetch(`${BASE}/api/v1/voices`)).json();
const files = voiceSnapshots(TODAY);
const fails = [];
const fail = (where, msg) => fails.push(`${where}: ${msg}`);
if (JSON.stringify(want.snapshots) !== JSON.stringify(files.map((s) => ({ date: s.date, window: s.window, topics: s.topics })))) fail('api', '/api/v1/voices differs from the imported snapshots');

const VIEWPORTS = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true } };
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  for (const [vp, opt] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile, hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const open = async (where) => {
      const page = await ctx.newPage();
      await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
      const api = [];
      page.on('console', (m) => { if (m.type() === 'error' && !/503|Failed to load resource/.test(m.text())) fail(where, `console: ${m.text()}`); });
      page.on('pageerror', (e) => fail(where, `pageerror: ${e.message}`));
      page.on('request', (r) => { if (r.url().includes('/api/')) api.push(new URL(r.url()).pathname + new URL(r.url()).search); });
      return { page, api };
    };
    const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${vp}-d1-${name}.png`), fullPage: true });

    // /voices/ from the API, list and calendar
    let where = `${vp} /voices/`;
    let { page, api } = await open(where);
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await page.goto(`${BASE}/voices/?view=list`, { waitUntil: 'networkidle' });
    if (JSON.stringify(api) !== JSON.stringify(['/api/v1/voices'])) fail(where, `API requests ${JSON.stringify(api)}`);
    const sections = await page.$$eval('#list section.vsnap h2', (hs) => hs.map((h) => h.id));
    if (JSON.stringify(sections) !== JSON.stringify(files.map((s) => `s-${s.date}`).reverse())) fail(where, `list sections ${sections}`);
    const links = await page.$$eval('#list a.vsl', (as) => as.map((a) => a.getAttribute('href')));
    if (JSON.stringify(links) !== JSON.stringify(files.map((s) => `/voices/#d=${s.date}`).reverse())) fail(where, `この日のまとめ links ${links}`);
    const ids = await page.$$eval('#list article.tc', (as) => as.map((a) => a.dataset.topic));
    if (ids.length !== files.reduce((n, s) => n + s.topics.length, 0)) fail(where, `${ids.length} cards in the list`);
    if (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) > 1) fail(where, 'scrolls horizontally');
    await shot(page, 'voices-list');
    await page.locator('#list a.vsl').first().click();
    await page.waitForFunction(() => document.getElementById('vDlg').open);
    if (await page.evaluate(() => location.hash) !== `#d=${files.at(-1).date}`) fail(where, 'この日のまとめ did not open its day');
    await page.goto(`${BASE}/voices/?view=cal`, { waitUntil: 'networkidle' });
    if (!(await page.locator('#calv [data-day]').count())) fail(where, 'calendar not rendered');
    await shot(page, 'voices');
    const t0 = files.at(-1).topics[0];
    await page.goto(`${BASE}/voices/#t=${t0.id}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('vDlg').open);
    if (!(await page.locator('#vBody').textContent()).includes(t0.title)) fail(where, `#t=${t0.id} did not open the topic`);
    await page.close();

    // loading, then an error with 再読み込み
    where = `${vp} /voices/ (states)`;
    ({ page, api } = await open(where));
    let release;
    const gate = new Promise((ok) => { release = ok; });
    let mode = 'slow';
    await page.route('**/api/v1/voices', async (r) => {
      if (mode === 'slow') { await gate; return r.continue(); }
      if (mode === 'down') return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' });
      if (mode === 'noid') {
        const one = structuredClone(want.snapshots.at(-1));
        delete one.topics[0].id;
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: '1', snapshots: [one] }) });
      }
      if (mode === 'bad') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: '1', snapshots: [{ date: '"><img src=x>', window: {}, topics: [] }] }) });
      return r.continue();
    });
    await page.goto(`${BASE}/voices/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#calv .state[role="status"]');
    if (!(await page.locator('#calv').textContent()).includes('読み込んでいます')) fail(where, 'no loading state');
    release();
    await page.waitForSelector('#calv [data-day]');
    mode = 'down';
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#vRetry');
    if (!(await page.locator('#calv').textContent()).includes('読み込めませんでした')) fail(where, 'no error state');
    await shot(page, 'voices-error');
    mode = 'bad';
    await page.locator('#vRetry').click();
    await page.waitForSelector('#vRetry');
    if (!(await page.locator('#calv').textContent()).includes('読み込めませんでした')) fail(where, 'a malformed answer did not end in the error state');
    if (await page.locator('#calv img').count()) fail(where, 'a malformed answer was rendered');
    // a topic without an id, opened in list view: the error state still shows
    mode = 'noid';
    await page.goto(`${BASE}/voices/?view=list`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#vRetry', { state: 'visible' });
    if (await page.locator('#list article.tc').count()) fail(where, 'a topic without an id was rendered');
    mode = 'up';
    await page.locator('#vRetry').click();
    await page.waitForSelector('#list article.tc');
    await page.goto(`${BASE}/voices/?view=cal`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#calv [data-day]');
    await page.close();

    // home いま話題 from /api/v1/voices/latest
    where = `${vp} / いま話題`;
    ({ page, api } = await open(where));
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    api.length = 0;
    await page.reload({ waitUntil: 'networkidle' });
    if (JSON.stringify(api) !== JSON.stringify(['/api/v1/voices/latest'])) fail(where, `API requests ${JSON.stringify(api)}`);
    const latest = files.at(-1);
    const st = await page.evaluate(() => ({ shown: !document.getElementById('vtr').hidden, asof: document.getElementById('vtAsOf').textContent,
      rows: [...document.querySelectorAll('#vtBody a.vt')].map((a) => a.getAttribute('href')) }));
    const fresh = (Date.parse(TODAY) - Date.parse(latest.date)) / 864e5 <= 7;
    if (st.shown !== fresh) fail(where, `block shown=${st.shown}, snapshot ${latest.date}`);
    if (fresh) {
      const [, m, d] = latest.date.split('-').map(Number);
      if (st.asof !== `${m}/${d} 時点・AI要約`) fail(where, `as-of "${st.asof}"`);
      if (!st.rows.length || st.rows.length > 5 || st.rows.some((h) => !latest.topics.some((t) => h === `/voices/#t=${t.id}`))) fail(where, `rows ${JSON.stringify(st.rows)}`);
      await page.locator('#vtr').screenshot({ path: path.join(OUT, `${vp}-d1-home-voices.png`) });
    }
    await page.close();
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
for (const f of fails) console.log(`FAIL ${f}`);
console.log(`voices-d1: ${fails.length ? `FAIL (${fails.length})` : 'PASS'} (${files.length} snapshots, screenshots in ${path.relative(ROOT, OUT)}/)`);
process.exit(fails.length ? 1 : 0);
