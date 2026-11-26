// Drives the built dist/ in headless Chrome at desktop and mobile widths.
// node tools/verify/browser.mjs [--today YYYY-MM-DD] [--out .verify]   (run verify_release.py first so dist/ matches --today)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshots as voiceSnapshots } from './voices-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TODAY = arg('--today', new Date().toISOString().slice(0, 10));
// /api/v1/voices as the Worker answers it after importing the made-up gate snapshots (tools/verify/voices-fixtures.mjs,
// last one on --today); the server below serves it, so /voices/ and the home block work without the Worker (voices-d1.mjs runs the real one)
const VOICE_SNAPS = voiceSnapshots(TODAY).map(s => ({ date: s.date, window: s.window, topics: s.topics }));
const VOICES_API = { '/api/v1/voices': { version: 'local', snapshots: VOICE_SNAPS }, '/api/v1/voices/latest': { version: 'local', snapshot: VOICE_SNAPS.at(-1) || null } };
// page stubs of the events API leave the voices endpoints to the server
const EVENTS_API = u => u.pathname.startsWith('/api/v1/') && !VOICES_API[u.pathname];
// the official posts the voices snapshots react to: the only X links /voices/ may show
const OFFICIAL_X = new Set(VOICE_SNAPS.flatMap(s => s.topics.map(t => t.reacting_to).filter(Boolean)));
const OUT = path.resolve(ROOT, arg('--out', '.verify'));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.txt': 'text/plain' };

// dist/_redirects (static `from to 301` lines, as build.py writes them) applied the way the hosts do
const REDIRECTS = fs.existsSync(path.join(DIST, '_redirects')) ? Object.fromEntries(fs.readFileSync(path.join(DIST, '_redirects'), 'utf8')
  .split('\n').map(l => l.trim().split(/\s+/)).filter(x => x.length === 3).map(([a, b, c]) => [a, [b, +c]])) : {};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // no IP guess, as for visitors (and crawlers) outside Japan: hubs then send no events request
  if (p === '/api/v1/geo') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"region_code":null}'); return; }
  if (REDIRECTS[p]) { res.writeHead(REDIRECTS[p][1], { location: REDIRECTS[p][0] + new URL(req.url, 'http://x').search }).end(); return; }
  if (VOICES_API[p]) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(VOICES_API[p])); return; }
  let f = path.join(DIST, p);
  if (!f.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404, { 'content-type': TYPES['.html'] }).end(fs.readFileSync(path.join(DIST, '404.html'))); return; }
  // ?__maps=1 serves /events/ with a dummy Maps key (Google itself is stubbed per page) to exercise the map pane
  let body = fs.readFileSync(f);
  if (new URL(req.url, 'http://x').searchParams.has('__maps') && f.endsWith(path.join('events', 'index.html')))
    body = body.toString().replace('const MAPS_KEY = "";', 'const MAPS_KEY = "dummy-maps-key";');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const PAGES = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/.pages.json'), 'utf8'));
const pages = PAGES.map(p => p.path).filter(p => p !== '/events/'); // needs the Worker API; see api/scripts/preview-check.mjs
const pageGame = Object.fromEntries(PAGES.map(p => [p.path, p.js && p.js.game]));
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true } };
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const fail = (where, msg) => fails.push(`${where}: ${msg}`);
// /feedback/ is built only with FEEDBACK_ENABLED=1; Turnstile and the API are stubbed.
const HAS_FEEDBACK = fs.existsSync(path.join(DIST, 'feedback/index.html'));
// BUILD_EVENTS=0 builds have no /events/ and no tool tabs
const HAS_EVENTS = fs.existsSync(path.join(DIST, 'events/index.html'));
// /voices/ and the home page's いま話題 block: VOICES_ENABLED=1 Worker builds only
const HAS_VOICES = fs.existsSync(path.join(DIST, 'voices/index.html'));
// event landing pages (the Worker's shell): LANDING_ENABLED=1 builds only
const HAS_LANDING = fs.existsSync(path.join(DIST, '_landing.html'));
const TURNSTILE_STUB = `window.turnstile={_o:null,_n:0,
  render(el,o){this._o=o;setTimeout(()=>o.callback('tok-'+(++this._n)),0);return 'w1';},
  reset(){window.__tsResets=(window.__tsResets||0)+1;setTimeout(()=>this._o.callback('tok-'+(++this._n)),0);}};
window.snTurnstileReady&&window.snTurnstileReady();`;

async function checkFeedback(ctx, vp) {
  const where = `${vp} /feedback/`;
  const page = await ctx.newPage();
  const bad = [];
  page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('500')) bad.push(`console: ${m.text()}`); });
  await page.route('https://challenges.cloudflare.com/**', r => r.fulfill({ contentType: 'text/javascript', body: TURNSTILE_STUB }));
  const posts = [];
  let answer = 500;
  await page.route('**/api/v1/feedback', async r => {
    posts.push(JSON.parse(r.request().postData()));
    await r.fulfill({ status: answer, contentType: 'application/json', body: answer === 202 ? '{"ok":true,"id":"x"}' : '{"error":"internal error"}' });
  });
  try {
    await page.goto(`${BASE}/pokemon/`, { waitUntil: 'load' });
    const gear = await page.locator('#setPop a[data-feedback]').getAttribute('href');
    if (gear !== '/feedback/?from=/pokemon/') fail(where, `gear menu link ${gear}`);
    const res = await page.goto(`${BASE}/feedback/?from=/pokemon/`, { waitUntil: 'load' });
    if (!res || res.status() !== 200) fail(where, `status ${res && res.status()}`);
    if (await page.locator('#fbFrom').textContent() !== '/pokemon/') fail(where, '送信元ページ not shown');
    await page.locator('#fbSend').click();
    if (!(await page.locator('#fbKindErr').textContent())) fail(where, 'no error for a missing 種類');
    if (await page.evaluate(() => document.activeElement?.name) !== 'kind') fail(where, 'focus did not move to 種類');
    if (await page.locator('input[name="kind"][aria-invalid="true"]').count() !== 4) fail(where, '種類 radios not marked aria-invalid');
    await page.locator('input[name="kind"][value="data"]').check();
    const text = '発売日が間違っています\n2行目';
    await page.locator('#fbMessage').fill(text);
    await page.locator('#fbEmail').fill('not-an-address');
    await page.locator('#fbSend').click();
    if (!(await page.locator('#fbEmailErr').textContent())) fail(where, 'no error for a malformed address');
    await page.locator('#fbEmail').fill('me@example.com');
    await page.waitForFunction(() => window.turnstile && window.turnstile._n > 0);
    await page.locator('#fbSend').click();
    await page.locator('#fbStatus:not(:empty)').waitFor();
    if (!(await page.locator('#fbStatus').textContent()).includes('そのまま残っています')) fail(where, 'error message missing');
    if (await page.locator('#fbMessage').inputValue() !== text) fail(where, 'text lost after an error');
    if (!(await page.evaluate(() => window.__tsResets))) fail(where, 'Turnstile not reset after an error');
    answer = 202;
    await page.waitForFunction(() => window.turnstile._n > 1);
    await page.locator('#fbSend').click();
    await page.locator('#fbDone').waitFor({ state: 'visible' });
    const last = posts.at(-1);
    const want = { kind: 'data', message: text, reply_to: 'me@example.com', page: '/pokemon/' };
    for (const [k, v] of Object.entries(want)) if (last?.[k] !== v) fail(where, `posted ${k}=${JSON.stringify(last?.[k])}`);
    if (!/^tok-\d+$/.test(last?.turnstile ?? '') || last.turnstile === posts[0].turnstile) fail(where, 'Turnstile token not fresh');
    if (await page.locator('#fbBack').getAttribute('href') !== '/pokemon/') fail(where, 'back link does not return to ?from');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) fail(where, `page scrolls horizontally by ${overflow}px`);
    await page.screenshot({ path: path.join(OUT, `${vp}-feedback.png`), fullPage: true });
  } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
  for (const b of [...new Set(bad)]) fail(where, b);
  console.log(`  ${where.padEnd(22)} posts=${posts.length}`);
  await page.close();
}
// Table columns match their headers; a month page keeps its month in the table view; a month without upcoming
// releases for the chosen title points to the next one.
async function checkScopes(ctx, vp) {
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
  try {
    await page.goto(`${BASE}/releases/`, { waitUntil: 'load' });
    const ym = TODAY.slice(0, 7);
    const pick = await page.evaluate(([today, ym]) => {
      const gs = [...new Set(DATA.map(d => d.game))];
      const g = gs.find(g => DATA.some(d => d.game === g && d.date.startsWith(ym) && d.date < today)
        && !DATA.some(d => d.game === g && d.date.startsWith(ym) && d.date >= today) && DATA.some(d => d.game === g && d.date > today));
      return g ? { g, next: DATA.find(d => d.game === g && d.date > today).date } : null;
    }, [TODAY, ym]);
    const months = await page.evaluate(() => [...new Set(DATA.map(d => d.date.slice(0, 7)))].sort());
    const mp = months.find(m => m > ym) || ym;
    await page.evaluate(([g]) => { localStorage.setItem('tcg.view', '"tbl"'); localStorage.setItem('tcg.sel', JSON.stringify(g ? [g] : [])); }, [pick && pick.g]);
    if (vp === 'desktop') {
      await page.goto(`${BASE}/releases/`, { waitUntil: 'load' });
      const cols = await page.evaluate(() => ({ th: [...document.querySelectorAll('thead th')].map(t => t.dataset.k || t.className),
        td: [...document.querySelector('#tbody tr:not(.tl)').children].map(t => t.className) }));
      const want = [['nosort sc', 'sc'], ['date', 'd'], ['nosort', 'im'], ['game', 'gm'], ['name', 'nm'], ['packN', 'p p1'], ['boxN', 'p bx'], ['nosort', 'lk']];
      if (JSON.stringify(want.map(w => w[0])) !== JSON.stringify(cols.th) || JSON.stringify(want.map(w => w[1])) !== JSON.stringify(cols.td))
        fail(`${vp} /releases/ table`, `columns ${JSON.stringify(cols)}`);
    }
    await page.goto(`${BASE}/${mp}/`, { waitUntil: 'load' });
    const mt = await page.evaluate(() => ({ nav: !document.getElementById('monthNav').hidden, tbl: !document.getElementById('tblView').hidden,
      dates: [...document.querySelectorAll('#tbody tr:not(.tl) td.d')].map(t => t.textContent) }));
    const [y, m] = mp.split('-').map(Number);
    if (!mt.tbl || !mt.nav || mt.dates.some(d => !d.startsWith(`${y}/${m}/`))) fail(`${vp} /${mp}/ table`, `month page table not scoped: ${JSON.stringify({ ...mt, dates: mt.dates.slice(0, 3) })}`);
    if (pick) {
      await page.evaluate(() => localStorage.setItem('tcg.view', '"cal"'));
      await page.goto(`${BASE}/releases/`, { waitUntil: 'load' });
      const nn = page.locator('#nextnote');
      if (!(await nn.isVisible()) || !(await nn.textContent()).includes('この条件の発売予定はありません')) fail(`${vp} /releases/ ${pick.g}`, 'no next-release note');
      else {
        await nn.locator('button').click();
        const lab = await page.locator('#monthLabel').textContent();
        if (lab !== `${+pick.next.slice(0, 4)}年${+pick.next.slice(5, 7)}月`) fail(`${vp} /releases/ ${pick.g}`, `next-release jump opened ${lab}`);
      }
    }
  } catch (e) { fail(`${vp} scopes`, `interaction: ${e.message.split('\n')[0]}`); }
  await page.evaluate(() => localStorage.clear());
  await page.close();
}
// Logo row: the tool tabs on the right just before settings / user on desktop, a bottom bar on phones.
async function headerProblem(page, width) {
  const h = await page.evaluate(() => {
    const r = s => document.querySelector(s)?.getBoundingClientRect();
    const tabs = document.querySelector('header.top .tooltabs');
    return { tabs: !!tabs, fixed: tabs && getComputedStyle(tabs).position === 'fixed', brand: r('header.top .brand'), t: r('header.top .tooltabs'),
      corner: r('header.top .corner'), header: r('header.top') };
  });
  if (!h.tabs) return HAS_EVENTS ? 'no tool tabs in the logo row' : '';
  if (width <= 760) return h.fixed ? '' : 'tool tabs are not the bottom bar';
  if (h.fixed) return 'tool tabs fixed on desktop';
  if (h.t.left < h.brand.right) return 'tool tabs overlap the logo';
  if (h.t.right > h.corner.left || h.corner.left - h.t.right > 20) return `tool tabs not right before the corner (${Math.round(h.corner.left - h.t.right)}px)`;
  if (Math.abs((h.t.top + h.t.bottom) - (h.corner.top + h.corner.bottom)) > 2) return 'tool tabs not vertically aligned with the corner';
  if (Math.abs(h.corner.right - h.header.right) > 1) return 'corner not at the right end';
  return '';
}
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

    const st = await page.evaluate(game => {
      const gm = game ? [...new Set(DATA.filter(d => d.game === game).map(d => d.date.slice(0, 7)))].sort() : [];
      const visibleCards = [...document.querySelectorAll('.pk')].filter(e => e.offsetParent).length;
      const brokenImgs = [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src'));
      return { month: document.getElementById('monthLabel').textContent,
        noneUpcoming: (document.querySelector('.ptitle p')?.textContent || '').includes('発売予定の新弾はありません'),
        visibleCards, brokenImgs, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        gm, note: !document.getElementById('mnote').hidden };
    }, pageGame[p] || null);
    const m = /^\/(\d{4})-(\d{2})\/$/.exec(p);
    const [wy, wm] = m ? [m[1], m[2]] : TODAY.split('-');
    // a title page with nothing this month opens on the title's next month with releases (else its latest) and says so;
    // an events hub with nothing upcoming stays on this month (its event counts show there)
    const cur = `${wy}-${wm}`, gm = st.gm, evHubPage = !!PAGES.find(x => x.path === p)?.js?.eventsApi;
    const open = gm.length && !gm.includes(cur) ? gm.find(x => x > cur) || (evHubPage ? cur : gm.at(-1)) : cur;
    const want = `${+open.slice(0, 4)}年${+open.slice(5)}月`;
    if (st.month !== want) fail(where, `calendar opens on ${st.month}, expected ${want}`);
    if (st.note !== (open !== cur)) fail(where, `month note ${st.note ? 'shown' : 'missing'}`);
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
    const hdr = await headerProblem(page, opt.width);
    if (hdr) fail(where, hdr);
    if (st.brokenImgs.length) fail(where, `broken images ${st.brokenImgs.slice(0, 3).join(', ')}`);
    if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
    for (const b of [...new Set(bad)]) fail(where, b);

    if (!(await page.locator('#filterBtn').getAttribute('aria-label'))?.startsWith('絞り込み')) fail(where, '#filterBtn has no accessible name');
    const rowOver = await page.evaluate(() => { const r = document.querySelector('.panel>.row'), last = [...r.children].filter(e => e.offsetParent).at(-1);
      return Math.max(r.scrollWidth - r.clientWidth, last ? last.getBoundingClientRect().right - r.getBoundingClientRect().right : 0); });
    if (rowOver > 1) fail(where, `toolbar row overflows by ${Math.round(rowOver)}px`);
    // the static release list starts folded in a closed <details> and opens from its summary (before the
    // /releases/ interactions, which leave the phone filter sheet open)
    const fold = await page.evaluate(() => { const d = document.getElementById('seo-list'), lis = [...document.querySelectorAll('.seo-day li')];
      return { items: lis.length, has: !!d, open: d?.open, outside: lis.filter(li => li.closest('details') !== d).length,
        shown: lis.filter(li => li.checkVisibility()).length, heading: d?.previousElementSibling?.matches('h2#seo-h') && !d.querySelector('h2'),
        sumFont: d ? parseFloat(getComputedStyle(d.querySelector('summary')).fontSize) : 0 }; });
    if (fold.items) try {
      if (!fold.has) throw new Error('static list has no disclosure (#seo-list)');
      if (fold.outside) fail(where, `${fold.outside} of ${fold.items} static list entries outside #seo-list`);
      if (fold.open || fold.shown) fail(where, `static list is not folded (${fold.shown} entries shown)`);
      if (!fold.heading) fail(where, 'list h2 is not a heading right before the disclosure');
      if (fold.sumFont < 12) fail(where, `list summary font ${fold.sumFont}px`);
      await page.locator('#seo-list > summary').click();
      const opened = await page.evaluate(() => { const d = document.getElementById('seo-list'), lis = [...d.querySelectorAll('.seo-day li')];
        return d.open && lis.length && lis.every(li => li.checkVisibility()); });
      if (!opened) fail(where, 'static list does not open from its summary');
      await page.locator('#seo-list > summary').click();
      await page.evaluate(() => window.scrollTo(0, 0));
    } catch (e) { fail(where, `list fold: ${e.message.split('\n')[0]}`); }
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
  if (HAS_FEEDBACK) await checkFeedback(ctx, vp);
  await checkScopes(ctx, vp);
  await ctx.close();
}
// / is the today page: today (Asia/Tokyo) from the embedded releases, favourites first, the saved location's events
// from at most 2 API requests (stubbed here; none without a location), and day deep links into /releases/.
const WEEK1 = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
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
  // Stub API. Default: 7 OPCG events today, /days without by_game (the page then groups the list itself).
  // scenario 'busy': 50 OPCG events fill the first page; PTCG's 3 come only on the cursor page. by_game_type: OPCG has
  // four named types and untyped ones (2 named + ほか), PTCG two (both named).
  // scenario 'many': nine games today; the five busiest get columns, the other four chips.
  let scenario = 'plain';
  const MANY = { HOCG: 10, GCG: 9, OPCG: 8, PTCG: 7, DCG: 6, BS: 5, UATCG: 2, DBFW: 1, LLOCG: 1 };
  const evt = (i, code, hh, day = TODAY) => ({ id: `${code}${i}`, name: `テスト大会 ${code} ${i + 1}`, game_code: code, game_codes: [code],
    starts_on: day, time_precision: 'datetime', starts_at: `${day}T${String(hh).padStart(2, '0')}:00:00+09:00`, timezone: 'Asia/Tokyo',
    attendance_mode: 'offline', venue: { name: `テスト店 ${i + 1}` }, source_url: 'https://example.com/', event_status: 'scheduled' });
  await page.route(EVENTS_API, route => {
    const u = new URL(route.request().url());
    api.push(u.pathname + u.search);
    if (u.pathname.endsWith('/events/meta')) return route.fulfill({ json: { games: [], types: [],
      loc_counts: { months: [TODAY.slice(0, 7)], types: ['x'], rows: { 'JP-13': [1, 0, 0, 3, 4], 'JP-27': [8, 0, 0, 1, 1] } } } });
    if (scenario === 'busy') {
      if (u.pathname.endsWith('/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: 53, by_game: { OPCG: 50, PTCG: 3 },
        by_game_type: { OPCG: { '': 2, flagship_battle: 12, meetup: 5, other: 1, standard_battle: 30 }, PTCG: { city_league: 1, gym_battle: 2 } } },
        { date: WEEK1, count: 4, by_game: { UATCG: 1, CONAN: 3 } }] } });
      return route.fulfill({ json: u.searchParams.get('cursor') ? { events: [0, 1, 2].map(i => evt(i, 'PTCG', 20)), next_cursor: null }
        : { events: Array.from({ length: 50 }, (_, i) => evt(i, 'OPCG', 10 + (i % 9))), next_cursor: 'c1' } });
    }
    if (scenario === 'many') {
      if (u.pathname.endsWith('/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: 38, by_game: MANY,
        by_game_type: Object.fromEntries(Object.entries(MANY).map(([c, n]) => [c, { standard_battle: n }])) }] } });
      return route.fulfill({ json: { events: Object.entries(MANY).flatMap(([code, n]) => Array.from({ length: n }, (_, i) => evt(i, code, 13 + (i % 6)))), next_cursor: null } });
    }
    const body = u.pathname.endsWith('/days') ? { days: [{ date: TODAY, count: 7 }] }
      : { events: Array.from({ length: 7 }, (_, i) => evt(i, 'OPCG', 10 + i)) };
    route.fulfill({ json: body });
  });
  const res = await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  if (!res || res.status() !== 200) fail(where, `status ${res && res.status()}`);
  const H = await page.evaluate(() => JSON.parse(/const H = (\{.*?\});\n/s.exec(document.documentElement.innerHTML)[1]));
  const todays = H.items.filter(d => d.date === TODAY);
  const hasEvents = await page.locator('#evBody').count() > 0;
  // today's panel is the day view: its release rows, and without a location only the イベント block's 地域を設定 (no
  // 都道府県を選ぶ button outside the dialogs)
  const st = await page.evaluate(() => ({ date: document.getElementById('hDate').textContent, cards: document.querySelectorAll('#wkPanel .pk').length,
    none: !!document.querySelector('#wkPanel .wps .q'), days: document.querySelectorAll('#wkStrip [role="tab"]').length,
    prompt: !!document.getElementById('hsLocSet') && document.getElementById('evBody').textContent === '地域を設定'
      && ![...document.querySelectorAll('#home button')].some(b => b.textContent.includes('都道府県')),
    blocks: document.querySelectorAll('#relBody, #relH, #evH, #locBtn, #pickLoc').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  const [, m, d] = TODAY.split('-').map(Number);
  if (!st.date.startsWith(`${m}月${d}日`)) fail(where, `date ${st.date}`);
  if (st.cards !== todays.length || (!todays.length && !st.none)) fail(where, `today shows ${st.cards} releases, data has ${todays.length}`);
  if (st.days !== 7) fail(where, `the strip shows ${st.days} days`);
  if (hasEvents && !st.prompt) fail(where, 'no location: 地域を設定 / the muted line missing, or another location button');
  if (st.blocks) fail(where, 'the 今日発売 / 今日のイベント blocks or their location controls are back');
  if (api.length) fail(where, `API called without a location: ${api.join(' ')}`);
  if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
  await page.screenshot({ path: path.join(OUT, `${vp}-home-nopref.png`), fullPage: true });

  // a favourite and a saved location
  const fav = todays[todays.length - 1];
  await page.evaluate(([id]) => { localStorage.setItem('tcg.stars', JSON.stringify(id ? [id] : []));
    localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13,JP-14', game: 'OPCG', days: 'weekend' })); }, [fav && fav.id]);
  await page.reload({ waitUntil: 'networkidle' });
  if (fav) {
    const first = await page.locator('#wkPanel .pk a.pko').first().getAttribute('href');
    if (first !== `/releases/#i=${fav.id}`) fail(where, `favourite not first: ${first}`);
  }
  if (hasEvents) {
    const ym = TODAY.slice(0, 7), next = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 1)).toISOString().slice(0, 10);
    const want = [`/api/v1/events/days?from=${ym}-01&until=${next}&game=OPCG&pref=JP-13`, `/api/v1/events?from=${TODAY}&until=${next}&game=OPCG&pref=JP-13&limit=50`];
    if (JSON.stringify([...api].sort()) !== JSON.stringify(want.sort())) fail(where, `API requests ${api.join(' ')}`);
    const ev = await page.evaluate(() => ({ rows: document.querySelectorAll('#evBody .ev').length, more: document.querySelector('#evBody a.go')?.getAttribute('href'),
      cols: document.querySelectorAll('#evBody .gcol').length, types: document.querySelectorAll('#evBody .ty').length, where: document.getElementById('hsL').textContent }));
    if (ev.cols !== 1 || ev.rows !== 5) fail(where, `today's events show ${ev.cols} columns / ${ev.rows} rows`);
    // headings: 発売 / イベント h2, game rows h3
    if (await page.locator('#wkPanel .gcol h3').count() !== ev.cols || await page.locator('#wkPanel .gcol :is(h2, h4, h5)').count()) fail(where, 'game row headings are not h3');
    // /days without by_game_type (answers cached before it existed): no type line
    if (ev.types) fail(where, `${ev.types} type lines without by_game_type`);
    if (ev.more !== `/events/?game=OPCG&pref=JP-13&range=custom&from=${TODAY}&to=${TODAY}`) fail(where, `day view link ${ev.more}`);
    if (!ev.where.startsWith('東京都')) fail(where, `location ${ev.where}`);

    // the location picker (shared with /events/): the choice goes into the saved filters, the rest of them kept
    api.length = 0;
    await page.locator('#hsBtn').click();
    await page.locator('#hsLocBtn').click();
    await page.locator('#prefDlg[open] [data-pref="JP-27"]').waitFor();
    // counts from meta.loc_counts for the saved game filter (OPCG): Tokyo 3 + 4, Osaka's row is PTCG only
    await page.waitForFunction(() => document.querySelector('#prefDlg [data-pref="JP-13"] em')?.textContent === '7');
    if (await page.locator('#prefDlg [data-pref="JP-27"] em').textContent() !== '0') fail(where, 'picker counts ignore the game filter');
    await page.locator('#prefDlg [data-pref="JP-27"]').click();
    await page.waitForFunction(() => document.getElementById('hsL').textContent.startsWith('大阪府') && document.querySelector('#evBody .gcol'));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tcg.ev.filters')));
    if (saved.pref !== 'JP-27' || saved.game !== 'OPCG' || saved.days !== 'weekend') fail(where, `picker saved ${JSON.stringify(saved)}`);
    const want2 = ['/api/v1/events/meta', `/api/v1/events/days?from=${ym}-01&until=${next}&game=OPCG&pref=JP-27`, `/api/v1/events?from=${TODAY}&until=${next}&game=OPCG&pref=JP-27&limit=50`];
    if (JSON.stringify([...api].sort()) !== JSON.stringify(want2.sort())) fail(where, `API requests after the picker ${api.join(' ')}`);
    if (await page.locator('#prefDlg').evaluate(d => d.open)) fail(where, 'picker still open');
    await page.keyboard.press('Escape');

    // all games, one busy: per-game columns from /days by_game, one cursor page for the game the first page missed
    scenario = 'busy'; api.length = 0;
    await page.evaluate(() => localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13' })));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('wkStrip').textContent.includes('…') && !document.querySelector('#wkPanel .sk'), null, { timeout: 5000 }).catch(() => {});
    const busy = await page.evaluate(() => ({ cols: [...document.querySelectorAll('#evBody .gcol')].map(c => [c.getAttribute('aria-label'), c.querySelectorAll('.ev').length,
      c.querySelector('a.go')?.textContent]),       types: [...document.querySelectorAll('#evBody .gcol')].map(c => c.querySelector('.ty')?.textContent || null),
      tyLine: (() => { const t = document.querySelector('#evBody .gcol .ty'); return t ? { nowrap: getComputedStyle(t).whiteSpace === 'nowrap', h: t.getBoundingClientRect().height } : null; })(),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    if (JSON.stringify(busy.cols) !== JSON.stringify([['ONE PIECE', 5, 'ほか 45件 ›'], ['ポケモンカード', 3, '地図で見る ›']])) fail(where, `busy columns ${JSON.stringify(busy.cols)}`);
    if (api.length !== 3 || !api.some(a => a.includes('cursor=c1'))) fail(where, `busy: API requests ${api.join(' ')}`);
    // tomorrow (this month): its columns from /days by_game; the loaded pages reach the month's end, so no request
    if (WEEK1.slice(0, 7) === TODAY.slice(0, 7)) {
      const n0 = api.length;
      await page.locator('#wkT1').click();
      const tc = await page.evaluate(() => [...document.querySelectorAll('#evBody .gcol')].map(c => c.getAttribute('aria-label')));
      if (JSON.stringify(tc) !== JSON.stringify(['UNION ARENA', '名探偵コナン']) || api.length !== n0) fail(where, `busy: tomorrow's columns ${tc}, requests +${api.length - n0}`);
      await page.locator('#wkT0').click();
    }
    if (JSON.stringify(busy.types) !== JSON.stringify(['スタンダードバトル 30件・フラッグシップバトル 12件・ほか 8件', 'ジムバトル 2件・シティリーグ 1件'])) fail(where, `busy: type lines ${JSON.stringify(busy.types)}`);
    if (opt.width <= 760 && !(busy.tyLine && busy.tyLine.nowrap && busy.tyLine.h < 24)) fail(where, `busy: type line not one line on phones ${JSON.stringify(busy.tyLine)}`);
    if (busy.overflow > 1) fail(where, `busy: page scrolls horizontally by ${busy.overflow}px`);
    await page.screenshot({ path: path.join(OUT, `${vp}-home-busy.png`), fullPage: true });

    scenario = 'many'; api.length = 0;
    await page.reload({ waitUntil: 'networkidle' });
    const many = await page.evaluate(() => ({ cols: [...document.querySelectorAll('#evBody .gcol')].map(c => c.getAttribute('aria-label')),
      types: document.querySelectorAll('#evBody .ty').length,
      rest: [...document.querySelectorAll('#evBody .gmore a.gc')].map(a => { const t = a.cloneNode(true); t.querySelectorAll('.gi').forEach(e => e.remove()); return [t.textContent, a.getAttribute('href')]; }),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    if (JSON.stringify(many.cols) !== JSON.stringify(['ONE PIECE', 'ポケモンカード', 'ガンダム', 'デジモン', 'ホロライブ'])) fail(where, `many: columns ${JSON.stringify(many.cols)}`);
    const dayLink = g => `/events/?game=${g}&pref=JP-13&range=custom&from=${TODAY}&to=${TODAY}`;
    if (JSON.stringify(many.rest) !== JSON.stringify([['UNION ARENA2', dayLink('UATCG')], ['DBフュージョンワールド1', dayLink('DBFW')],
      ['バトルスピリッツ5', dayLink('BS')], ['ラブライブ！OCG1', dayLink('LLOCG')]])) fail(where, `many: other titles ${JSON.stringify(many.rest)}`);
    if (api.length !== 2) fail(where, `many: API requests ${api.join(' ')}`);
    if (many.overflow > 1) fail(where, `many: page scrolls horizontally by ${many.overflow}px`);
    // a type line per column; the ほかのタイトル chips carry totals only (checked above)
    if (many.types !== 5) fail(where, `many: ${many.types} type lines for 5 columns`);
    await page.screenshot({ path: path.join(OUT, `${vp}-home-many.png`), fullPage: true });
  }
  await page.screenshot({ path: path.join(OUT, `${vp}-home.png`), fullPage: true });
  for (const b of [...new Set(bad)]) fail(where, b);

  // deep links into the release calendar; a day without releases opens its month and says so
  const empty = Array.from({ length: 28 }, (_, i) => `${TODAY.slice(0, 8)}${String(i + 1).padStart(2, '0')}`).find(d => !H.items.some(x => x.date === d) && d >= H.from && d <= H.until);
  if (empty) {
    await page.goto(`${BASE}/releases/#d=${empty}`, { waitUntil: 'load' });
    // the note survives a rebuild of the open dialog (account sync re-renders it)
    const e = await page.evaluate(() => { localStorage.setItem('tcg.stars', JSON.stringify(['i-sync-test'])); document.dispatchEvent(new CustomEvent('sn:prefs'));
      return { open: document.getElementById('dlg').open, none: !!document.querySelector('#dlgBody .dl-none'), hash: location.hash }; });
    if (!e.open || !e.none || e.hash) fail(`${vp} /releases/#d=`, `day without releases ${empty}: ${JSON.stringify(e)}`);
  }
  if (todays.length) {
    // the page reads the hash once on load; from /releases/ a hash-only goto would not reload it
    await page.goto('about:blank');
    await page.goto(`${BASE}/releases/#d=${TODAY}`, { waitUntil: 'load' });
    const dlg = await page.evaluate(() => ({ open: document.getElementById('dlg').open, n: document.querySelectorAll('#dlgBody .dl-item').length, hash: location.hash }));
    if (!dlg.open || dlg.n !== todays.length || dlg.hash) fail(`${vp} /releases/#d=`, `dialog ${JSON.stringify(dlg)}`);
  }
  console.log(`  ${where.padEnd(22)} today=${todays.length} events=${hasEvents} api=${api.length}`);
  await ctx.close();
}
// / いま話題 (VOICES_ENABLED=1 builds only): the latest snapshot's topics, at most 5 cards and 2 per game unless one game
// is shown; read only: games from the /voices/ saved filter (tcg.voices), else the /events/ one, kept to games with
// topics, else all; nothing written. Hidden once the snapshot is more than 7 days old. Without a location the only API
// calls are the voices endpoints (/voices/latest, and /voices once a row opens /voices/). The clock is the latest
// snapshot's day, so the block shows whatever --today is; the 7 / 8-day checks below cover hiding it.
for (const [vp, opt] of HAS_VOICES ? Object.entries(VIEWPORTS) : []) {
  const where = `${vp} / いま話題`;
  const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
    hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`${VOICE_SNAPS.at(-1)?.date || TODAY}T12:00:00+09:00`));
  const bad = [], api = [];
  page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
  page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
  page.on('request', r => { if (r.url().includes('/api/')) api.push(r.url()); });
  const state = () => page.evaluate(() => {
    const sec = document.getElementById('vtr');
    return { shown: !!sec && !sec.hidden && sec.offsetParent !== null, label: sec && document.getElementById(sec.getAttribute('aria-labelledby'))?.textContent,
      sub: document.getElementById('vtSub')?.textContent, buttons: sec ? sec.querySelectorAll('button').length : 0,
      rows: [...document.querySelectorAll('#vtBody .vt a.tt')].map(a => a.getAttribute('href').replace('/voices/#t=', '')),
      asof: document.getElementById('vtAsOf')?.textContent, saved: [localStorage.getItem('tcg.voices'), localStorage.getItem('tcg.ev.filters')],
      cards: (() => {
        const lis = [...document.querySelectorAll('#vtBody ul.vts > li')], rs = lis.map(li => li.querySelector('.vt')?.getBoundingClientRect() || li.getBoundingClientRect());
        const rows = Object.values(rs.reduce((m, r) => ((m[Math.round(r.top)] ||= []).push(Math.round(r.height)), m), {}));
        const box = document.getElementById('vtr').getBoundingClientRect();
        return { n: lis.length, cols: new Set(rs.map(r => Math.round(r.left))).size, unequal: rows.some(h => Math.max(...h) - Math.min(...h) > 1),
          outside: rs.some(r => r.left < box.left - 0.5 || r.right > box.right + 0.5),
          links: lis.map(li => { const a = li.querySelectorAll('a.tt'), n = a[0] && a[0].textContent;
            // besides the card's link (the title, stretched over the card): only the game chip's hub link
            return { n: a.length, other: li.querySelectorAll('a:not(.tt):not(.gl)').length, name: n, title: li.querySelector('.tt')?.textContent, meta: Math.min(...[...li.querySelectorAll('.vh,.vh :not(.gi)')].map(e => parseFloat(getComputedStyle(e).fontSize))),
              // compact rows: no summary or 反応の傾向 line on the card, the summary is the link's title
              extra: li.querySelectorAll('.sm,.tr').length, tip: !!a[0]?.getAttribute('title') }; }) };
      })(),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // a day without releases puts いま話題 on the left: 6 topics there (two rows of 3), else 5
      max: document.querySelector('#wkPanel .rel0') && document.querySelector('#wkPanel .evb') ? 6 : 5 };
  });
  const setStore = o => page.evaluate(o => { localStorage.clear(); for (const [k, v] of Object.entries(o)) localStorage.setItem(k, JSON.stringify(v)); }, o);
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    const H = await page.evaluate(() => JSON.parse(/const H = (\{.*?\});\n/s.exec(document.documentElement.innerHTML)[1]));
    const last = VOICE_SNAPS.at(-1);
    if (!last) throw new Error('no voices fixture snapshot');
    const HV = { date: last.date, topics: last.topics, games: (H.voiceGames || []).filter(g => last.topics.some(t => t.game === g.code)) };
    const byId = Object.fromEntries(HV.topics.map(t => [t.id, t]));
    const short = Object.fromEntries(HV.games.map(g => [g.code, g.short || g.name]));
    const W = { high: 3, mid: 2, low: 1 };
    const order = ids => ids.every((id, i) => !i || W[byId[ids[i - 1]].volume] > W[byId[id].volume] || (W[byId[ids[i - 1]].volume] === W[byId[id].volume] && byId[ids[i - 1]].first_seen >= byId[id].first_seen));
    const perGame = ids => Math.max(0, ...Object.values(ids.reduce((m, id) => (m[byId[id].game] = (m[byId[id].game] || 0) + 1, m), {})));
    const allOk = st => st.sub === 'すべてのタイトル' && st.rows.length === Math.min(st.max, HV.topics.length) && perGame(st.rows) <= 2 && order(st.rows);
    // nothing saved: top topics across all games, no controls
    let st = await state();
    const [, mm, dd] = HV.date.split('-').map(Number);
    if (!st.shown || st.label !== 'いま話題') fail(where, `block not shown (${st.label})`);
    if (st.buttons) fail(where, `${st.buttons} buttons in the read-only block`);
    if (!allOk(st)) fail(where, `all games: sub "${st.sub}" rows ${st.rows.join(' ')}`);
    if (st.asof !== `${mm}/${dd} 時点・AI要約`) fail(where, `footer ${st.asof}`);
    // cards: one per row topic in a list, one link each named by the title, metadata >= 12px, equal heights per row,
    // inside the section; 1 column on phones (also at 280px) and in the right-hand column at 1366 and 1024, more on the left (desktop also
    // shot at those widths, light and dark)
    const cardsOk = (st, w, min, max) => {
      const c = st.cards;
      if (c.n !== st.rows.length) fail(where, `${w}px: ${c.n} cards for ${st.rows.length} links`);
      if (c.cols < min || c.cols > max) fail(where, `${w}px: ${c.cols} columns`);
      if (c.unequal) fail(where, `${w}px: cards in a row differ in height`);
      if (c.outside) fail(where, `${w}px: a card sticks out of the section`);
      if (c.links.some(l => l.n !== 1 || l.other || !l.title || l.name !== l.title)) fail(where, `${w}px: card links ${JSON.stringify(c.links.map(l => [l.n, l.name]))}`);
      if (c.links.some(l => !(l.meta >= 12))) fail(where, `${w}px: card metadata under 12px`);
      if (c.links.some(l => l.extra || !l.tip)) fail(where, `${w}px: a topic row shows its summary / trend line or lacks the summary title`);
      if (st.overflow > 1) fail(where, `${w}px: page scrolls horizontally by ${st.overflow}px`);
      if (st.rows.some(id => !byId[decodeURIComponent(id)])) fail(where, `${w}px: link targets ${st.rows.join(' ')}`);
    };
    const shot = async name => {
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.locator('#vtr').screenshot({ path: path.join(OUT, `home-voices-${name}${scheme === 'dark' ? '-dark' : ''}.png`) });
      }
      await page.emulateMedia({ colorScheme: 'light' });
    };
    if (opt.width <= 760) {
      cardsOk(st, opt.width, 1, 1); await shot(String(opt.width));
      // the narrowest phones: the 240px column minimum gives way to the section width
      await page.setViewportSize({ width: 280, height: opt.height });
      cardsOk(await state(), 280, 1, 1);
      await page.setViewportSize({ width: opt.width, height: opt.height });
    }
    else for (const w of [1366, 1024]) {
      await page.setViewportSize({ width: w, height: opt.height });
      const sw = await state();
      // the right-hand column: 1 column; on the left of a day without releases: 2 (1024) or 3 (1366)
      if (sw.max === 6) cardsOk(sw, w, w >= 1366 ? 3 : 2, w >= 1366 ? 3 : 2); else cardsOk(sw, w, 1, 1);
      await shot(String(w));
    }
    if (opt.width > 760) await page.setViewportSize({ width: opt.width, height: opt.height });
    // the /events/ games when tcg.voices has none; games without topics dropped
    const two = HV.games.slice(0, 2).map(g => g.code);
    const evf = { game: [...two, 'ZZZ'].join(',') };
    await setStore({ 'tcg.ev.filters': evf });
    await page.reload({ waitUntil: 'networkidle' });
    st = await state();
    if (st.sub !== `${two.map(c => short[c]).join('・')} の話題`) fail(where, `from /events/: sub "${st.sub}"`);
    if (!st.rows.length || st.rows.some(id => !two.includes(byId[id].game)) || perGame(st.rows) > 2 || !order(st.rows)) fail(where, `from /events/: rows ${st.rows.join(' ')}`);
    if (st.saved[0] !== null || st.saved[1] !== JSON.stringify(evf)) fail(where, `storage written: ${st.saved}`);
    // tcg.voices wins over /events/; one game: up to 5 of its topics
    const one = HV.games.find(g => HV.topics.filter(t => t.game === g.code).length > 2) || HV.games[0];
    const vf = { game: one.code, view: 'list' };
    await setStore({ 'tcg.voices': vf, 'tcg.ev.filters': evf });
    await page.reload({ waitUntil: 'networkidle' });
    st = await state();
    const n1 = HV.topics.filter(t => t.game === one.code).length;
    if (st.sub !== `${short[one.code]} の話題` || st.rows.length !== Math.min(st.max, n1) || st.rows.some(id => byId[id].game !== one.code) || !order(st.rows)) fail(where, `one game: sub "${st.sub}" rows ${st.rows.join(' ')}`);
    if (st.saved[0] !== JSON.stringify(vf)) fail(where, `tcg.voices written: ${st.saved[0]}`);
    // more than 4 games: 4 short names, then ほかN
    if (HV.games.length > 4) {
      const codes = HV.games.map(g => g.code);
      await setStore({ 'tcg.voices': { game: codes.join(',') } });
      await page.reload({ waitUntil: 'networkidle' });
      st = await state();
      if (st.sub !== `${codes.slice(0, 4).map(c => short[c]).join('・')} ほか${codes.length - 4} の話題`) fail(where, `many games: sub "${st.sub}"`);
    }
    // saved games none of which has topics now: /events/' games, else all
    await setStore({ 'tcg.voices': { game: 'ZZZ' }, 'tcg.ev.filters': evf });
    await page.reload({ waitUntil: 'networkidle' });
    st = await state();
    if (st.sub !== `${two.map(c => short[c]).join('・')} の話題`) fail(where, `absent /voices/ games: sub "${st.sub}"`);
    await setStore({ 'tcg.voices': { game: 'ZZZ' }, 'tcg.ev.filters': { game: 'ZZZ' } });
    await page.reload({ waitUntil: 'networkidle' });
    st = await state();
    if (!allOk(st)) fail(where, `absent games everywhere: sub "${st.sub}" rows ${st.rows.join(' ')}`);
    if (st.saved[0] !== JSON.stringify({ game: 'ZZZ' })) fail(where, `tcg.voices overwritten: ${st.saved[0]}`);
    // the row link opens that topic on /voices/
    const href = await page.locator('#vtBody .vt a.tt').first().getAttribute('href');
    await page.locator('#vtBody .vt a.tt').first().click();
    await page.waitForURL(u => u.pathname === '/voices/');
    await page.waitForFunction(() => document.getElementById('vDlg')?.open);
    if (await page.evaluate(() => location.hash) !== href.slice('/voices/'.length)) fail(where, `/voices/ hash after the row`);
    // more than 7 days after the snapshot: no block
    const stale = await ctx.newPage();
    await stale.clock.setFixedTime(new Date(Date.parse(`${HV.date}T12:00:00+09:00`) + 8 * 864e5));
    await stale.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    if (await stale.locator('#vtr').isVisible()) fail(where, 'shown with a snapshot 8 days old');
    await stale.clock.setFixedTime(new Date(Date.parse(`${HV.date}T12:00:00+09:00`) + 7 * 864e5));
    await stale.reload({ waitUntil: 'networkidle' });
    if (!(await stale.locator('#vtr').isVisible())) fail(where, 'hidden with a snapshot 7 days old');
    await stale.close();
  } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
  const other = api.filter(u => !VOICES_API[new URL(u).pathname]);
  if (other.length) fail(where, `API called: ${other.join(' ')}`);
  for (const b of [...new Set(bad)]) fail(where, b);
  console.log(`  ${where.padEnd(22)} checked`);
  await ctx.close();
}
// / 表示中 pill and the week strip. The pill names the saved titles (tcg.voices with VOICES builds, else /events/' game
// filter) and the /events/ location; 変更 opens a dialog that writes the titles to /events/' filter (its games) and to
// tcg.voices when it exists or holds a title /events/ has not, and the location through the shared picker. The strip is
// today + 6 days, one tab stop (arrow keys / Home / End), counting the titles' releases and, this month, their events
// from the same /days answer (2 API requests as before; next-month days show – and link the day view). Tomorrow is open
// at first. 今日発売 follows the titles too (favourites stay), with a link to the other titles' releases.
for (const [vp, opt] of Object.entries(VIEWPORTS)) {
  const where = `${vp} / strip`;
  const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
    hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
  const bad = [], api = [];
  page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
  page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
  page.on('request', r => { if (r.url().includes('/api/') && !VOICES_API[new URL(r.url()).pathname]) api.push(r.url()); });
  const day = n => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const week = Array.from({ length: 7 }, (_, i) => day(i)), WEEK2 = day(2);
  // Events by day: tomorrow OPCG ×2, PTCG ×1 and one shared OPCG + UATCG event; the day after PTCG ×4 and one shared
  // OPCG + UATCG; the 1st of next month a shared OPCG + PTCG event and one each (typed: their columns' type line comes
  // from the rows); one OPCG event on each of the next two days. The first /events page ends with tomorrow, the day
  // after's own page (this month) with the day after that and a cursor; /days answers this month only. The saved
  // game filter applies as on the API (rows matching any of its games). nmBusy: next month's 1st has more rows than
  // its page holds.
  const ym = TODAY.slice(0, 7), nm1Of = d => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 1)).toISOString().slice(0, 10), NM1 = nm1Of(TODAY);
  const EVTS = [[WEEK1, ['OPCG']], [WEEK1, ['OPCG']], [WEEK1, ['PTCG']], [WEEK1, ['OPCG', 'UATCG']],
    [WEEK2, ['PTCG']], [WEEK2, ['PTCG']], [WEEK2, ['PTCG']], [WEEK2, ['PTCG']], [WEEK2, ['OPCG', 'UATCG']],
    [NM1, ['OPCG', 'PTCG'], 'standard_battle'], [NM1, ['OPCG'], 'standard_battle'], [NM1, ['PTCG'], 'gym_battle'],
    [day(3), ['OPCG']], [day(4), ['OPCG']]]
    .map(([d, codes, type], i) => ({ d, codes, type, i }));
  const EV_ORDER = ['OPCG', 'UATCG', 'CONAN', 'PTCG', 'GCG', 'DBFW', 'BS', 'DCG', 'WS', 'VG', 'SVE', 'HOCG', 'LLOCG'];
  const EV_NAME = { OPCG: 'ONE PIECE', UATCG: 'UNION ARENA', PTCG: 'ポケモンカード' };
  const matches = (e, gf) => !gf.length || e.codes.some(c => gf.includes(c));
  // a day's columns: the games of its matching rows, kept to the filter (as /days by_game)
  const colsFor = (d, gf) => EV_ORDER.filter(c => (!gf.length || gf.includes(c)) && EVTS.some(e => e.d === d && matches(e, gf) && e.codes.includes(c))).map(c => EV_NAME[c]);
  // nobg: /days answers cached before by_game existed; hold: /days waits for it (a slow answer)
  let nobg = false, hold = null, metaHold = null, nmBusy = false;
  await page.route(EVENTS_API, async route => {
    const u = new URL(route.request().url()), gf = (u.searchParams.get('game') || '').split(',').filter(Boolean);
    if (u.pathname.endsWith('/events/meta')) { if (metaHold) await metaHold; return route.fulfill({ json: { games: [], types: [], prefectures: [{ code: 'JP-13', count: 7 }, { code: 'JP-27', count: 2 }] } }); }
    const rows = EVTS.filter(e => matches(e, gf));
    if (!u.pathname.endsWith('/days')) {
      const from = u.searchParams.get('from'), until = u.searchParams.get('until'), first = from === TODAY;
      const inRange = rows.filter(e => e.d >= from && e.d < until);
      const page = first ? inRange.filter(e => e.d <= WEEK1) : from === WEEK2 && WEEK2.slice(0, 7) === ym ? inRange.filter(e => e.d <= day(3))
        : nmBusy && from === NM1 ? inRange.filter(e => e.d === NM1).sort((a, b) => !!b.type - !!a.type).slice(0, 2) : inRange;
      return route.fulfill({ json: { events: page.map(e => ({ id: `s${e.i}`, name: `テスト大会 ${e.i}`,
        game_code: e.codes[0], game_codes: e.codes, starts_on: e.d, time_precision: 'date', timezone: 'Asia/Tokyo', attendance_mode: 'offline',
        venue: { name: 'テスト店' }, source_url: 'https://example.com/', event_status: 'scheduled', ...(e.type ? { group: { name: `テスト大会 ${e.i}`, event_type_code: e.type } } : {}) })),
        next_cursor: page.length < inRange.length || (nmBusy && from === NM1) ? 'c2' : null } });
    }
    if (hold) await hold;
    const days = [...new Set(rows.filter(e => e.d.slice(0, 7) === ym).map(e => e.d))].map(date => {
      const r = rows.filter(e => e.d === date), by_game = {};
      r.forEach(e => e.codes.forEach(c => { if (!gf.length || gf.includes(c)) by_game[c] = (by_game[c] || 0) + 1; }));
      return nobg ? { date, count: r.length } : { date, count: r.length, by_game };
    });
    route.fulfill({ json: { days } });
  });
  const setStore = o => page.evaluate(o => { localStorage.clear(); for (const [k, v] of Object.entries(o)) localStorage.setItem(k, JSON.stringify(v)); }, o);
  // the strip renders before the events answer is applied (… / a loading panel): read it once that has settled; a stuck
  // state then fails on its counts
  const settled = p => p.waitForFunction(() => !document.getElementById('wkStrip').textContent.includes('…') && !document.querySelector('#wkPanel .sk'), null, { timeout: 5000 }).catch(() => {});
  const state = async () => { await settled(page); return read(); };
  const read = () => page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#wkStrip [role="tab"]')], p = document.getElementById('wkPanel'), s = document.getElementById('wkStrip');
    // a tab's counts (data-rel / data-ev; '' = no events line); badges only for counts above 0
    const zeroBadge = tabs.some(t => (t.dataset.rel === '0' && t.querySelector('.cr')) || (t.dataset.ev === '0' && t.querySelector('.ce')));
    return { titles: document.getElementById('hsT').textContent, loc: document.getElementById('hsL')?.textContent ?? null, zeroBadge,
      // badge: the rendered number (the ★ left out), null without a badge
      tabs: tabs.map(t => ({ sel: t.getAttribute('aria-selected'), ti: t.tabIndex, rel: t.dataset.rel ?? null, ev: t.dataset.ev || null, label: t.getAttribute('aria-label'),
        relB: t.querySelector('.cr')?.firstChild?.textContent ?? null, evB: t.querySelector('.ce')?.textContent ?? null })),
      legend: document.getElementById('wkLg')?.textContent ?? null,
      by: p.getAttribute('aria-labelledby'), live: document.getElementById('wkLive')?.textContent ?? null,
      evHead: p.querySelector('.evb .blk-h') ? p.querySelector('.evb .blk-h .sub')?.textContent ?? '' : null, ty: [...p.querySelectorAll('.gcol .ty')].map(t => t.textContent), rels: [...p.querySelectorAll('.rels .pk')].map(e => e.closest('.rg').dataset.game),
      cols: [...p.querySelectorAll('.gcol')].map(c => c.getAttribute('aria-label')), others: p.querySelector('.relo .rl')?.textContent || null,
      foot: [...p.querySelectorAll('a.dayl')].map(a => [a.textContent, a.getAttribute('href')]),
      locSet: !!document.getElementById('hsLocSet'), evText: document.getElementById('evBody')?.textContent ?? null,
      saved: [localStorage.getItem('tcg.voices'), localStorage.getItem('tcg.ev.filters')], focus: document.activeElement?.id || null,
      dlg: document.getElementById('hsDlg').open, strip: s.scrollWidth - s.clientWidth,
      small: [...document.querySelectorAll('#home *')].filter(e => e.getClientRects().length && !e.closest('.sr,.gi') && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).map(e => e.textContent.trim()),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    const H = await page.evaluate(() => JSON.parse(/const H = (\{.*?\});\n/s.exec(document.documentElement.innerHTML)[1]));
    if (!H.titles || !H.titles.OPCG) throw new Error('no embedded title map');
    const EV13 = ['OPCG', 'UATCG', 'CONAN', 'PTCG', 'GCG', 'DBFW', 'BS', 'DCG', 'WS', 'VG', 'SVE', 'HOCG', 'LLOCG'];
    const short = c => ({ OPCG: 'ワンピ', UATCG: 'ユニアリ', CONAN: 'コナン', PTCG: 'ポケカ', GCG: 'ガンダム', DBFW: 'フュージョンワールド', BS: 'バトスピ', DCG: 'デジカ' })[c];
    const relN = (d, names) => d >= H.from && d <= H.until ? String(H.items.filter(x => x.date === d && (!names || names.includes(x.game))).length) : '–';
    // the strip's event count: the day's events under the saved /events/ game filter gf (the API's query), this month;
    // next month – until that day's rows are loaded
    const evN = (d, gf) => !HAS_EVENTS ? null : d.slice(0, 7) !== ym ? '–' : String(EVTS.filter(e => e.d === d && matches(e, gf)).length);
    const strip = (label, st, names, codes, loc = true, gf = codes || []) => {
      const want = week.map(d => [relN(d, names), loc ? evN(d, gf) : null]), got = st.tabs.map(t => [t.rel, t.ev]);
      if (JSON.stringify(got) !== JSON.stringify(want)) fail(where, `${label}: strip counts ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      if (st.tabs.length !== 7 || st.tabs.filter(t => t.ti === 0).length !== 1 || st.tabs.filter(t => t.sel === 'true').length !== 1) fail(where, `${label}: tabs ${JSON.stringify(st.tabs.map(t => [t.sel, t.ti]))}`);
      if (st.tabs.some(t => !t.label || !/^\d+月\d+日/.test(t.label))) fail(where, `${label}: tab labels`);
      if (st.overflow > 1) fail(where, `${label}: page scrolls horizontally by ${st.overflow}px`);
      if (st.small.length) fail(where, `${label}: text under 12px: ${st.small.slice(0, 3).join(' | ')}`);
      if (st.zeroBadge) fail(where, `${label}: a zero day shows a count badge`);
      // the shown badge and the tab's label say the same count as the data
      const shown = c => c === '0' ? null : c;
      const badBadge = st.tabs.filter(t => t.relB !== shown(t.rel) || t.evB !== (t.ev == null ? null : shown(t.ev))
        || (t.rel !== '–' && !t.label.includes(`発売${t.rel}件`)) || (t.ev != null && /^\d+$/.test(t.ev) && !/イベント\d+件（[^）]+）/.test(t.label)) || (t.ev != null && /^\d+$/.test(t.ev) && !t.label.includes(`イベント${t.ev}件（`)));
      if (badBadge.length) fail(where, `${label}: badge text / tab label ${JSON.stringify(badBadge.map(t => [t.rel, t.relB, t.ev, t.evB, t.label]))}`);
      // the event counts follow the /events/ game filter, not the pill: the legend always names it
      if (st.legend && st.legend.includes('イベント数') && !/イベント数（[^）]+）$/.test(st.legend)) fail(where, `${label}: legend "${st.legend}" does not name the event filter`);
    };
    const REL_LINK = '日別一覧（新弾カレンダーでこの日を見る） ›', EV_LINK = '日別一覧（イベントカレンダーでこの日を見る） ›';
    // a title with releases this week (an /events/ game, so the /events/ filter can hold it too)
    const inWeek = H.items.filter(x => week.includes(x.date));
    const code = ['OPCG', 'UATCG', 'CONAN', 'PTCG', 'GCG', 'DBFW', 'BS', 'DCG'].find(c => inWeek.some(x => x.game === H.titles[c])) || 'OPCG';

    // location only: every title, today open
    await setStore({ 'tcg.ev.filters': { pref: 'JP-13' } });
    api.length = 0;
    await page.reload({ waitUntil: 'networkidle' });
    let st = await state();
    if (st.titles !== 'すべてのタイトル' || st.loc !== (HAS_EVENTS ? '東京都' : null)) fail(where, `line "${st.titles}" "${st.loc}"`);
    strip('all titles', st, null, null);
    if (st.tabs[0].sel !== 'true' || st.by !== 'wkT0') fail(where, `today not open first (${st.by})`);
    const [, tm, td] = TODAY.split('-').map(Number), nT = +evN(TODAY, []);
    if (HAS_EVENTS && st.live !== (nT ? `${tm}月${td}日のイベント ${nT}件` : `${tm}月${td}日のイベントはありません`)) fail(where, `status "${st.live}"`);
    const todayRels = H.items.filter(x => x.date === TODAY);
    if (st.rels.length !== todayRels.length) fail(where, `today's panel shows ${st.rels.length} release cards, data has ${todayRels.length}`);
    const evDay = d => `/events/?pref=JP-13&range=custom&from=${d}&to=${d}`;
    if (JSON.stringify(st.foot) !== JSON.stringify([[REL_LINK, `/releases/#d=${TODAY}`]].concat(HAS_EVENTS ? [[EV_LINK, evDay(TODAY)]] : []))) fail(where, `today's links ${JSON.stringify(st.foot)}`);
    if (HAS_EVENTS && api.length !== 2) fail(where, `API requests ${api.join(' ')}`);
    // tomorrow: covered by the loaded rows (no request), one column per game
    if (HAS_EVENTS && WEEK1.slice(0, 7) === ym) {
      await page.locator('#wkT1').click();
      st = await state();
      if (JSON.stringify(st.cols) !== JSON.stringify(colsFor(WEEK1, [])) || api.length !== 2) fail(where, `tomorrow: columns ${st.cols}, requests ${api.length}`);
      // the day after: not covered (the first page ends with tomorrow): one request for its own page, kept for the visit
      await page.locator('#wkT2').click();
      st = await state();
      const want = `/api/v1/events?from=${WEEK2}&until=${nm1Of(WEEK2)}&pref=JP-13&limit=50`;
      if (api.length !== 3 || !api[2].endsWith(want) || JSON.stringify(st.cols) !== JSON.stringify(colsFor(WEEK2, []))) fail(where, `${WEEK2}: requests ${api.slice(2).join(' ')} columns ${st.cols}`);
      await page.locator('#wkT0').click();
      await page.locator('#wkT2').click();
      await state();
      if (api.length !== 3) fail(where, `${WEEK2} asked for again: ${api.slice(3).join(' ')}`);
      // the next day is in that page (it stops there with a cursor) and its rows reach its /days count: no request;
      // the day after that is not: one request
      if (week[4].slice(0, 7) === ym) {
        await page.locator('#wkT3').click();
        await state();
        if (api.length !== 3) fail(where, `${week[3]} asked for although ${WEEK2}'s page holds all of it: ${api.slice(3).join(' ')}`);
        await page.locator('#wkT4').click();
        await state();
        if (api.length !== 4 || !api[3].includes(`from=${week[4]}&`)) fail(where, `${week[4]}: requests ${api.slice(3).join(' ')}`);
      }
      await page.locator('#home').screenshot({ path: path.join(OUT, `${vp}-home-day-busy.png`) });
      await page.locator('#wkT0').click();
    }
    if (opt.width <= 760 && st.strip < 1) fail(where, 'the strip does not scroll on phones');
    if (opt.width > 760 && st.strip > 1) fail(where, `the strip scrolls on desktop by ${st.strip}px`);
    await page.screenshot({ path: path.join(OUT, `${vp}-home-top.png`) });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(OUT, `${vp}-home-top-dark.png`) });
    await page.emulateMedia({ colorScheme: 'light' });
    // keys: one tab stop, arrows move and open, Home / End, wrap
    await page.locator('#wkT1').click();
    await page.keyboard.press('ArrowRight');
    st = await state();
    if (st.focus !== 'wkT2' || st.by !== 'wkT2' || st.tabs[2].sel !== 'true' || st.tabs[2].ti !== 0 || st.tabs[1].ti !== -1) fail(where, `ArrowRight: focus ${st.focus} panel ${st.by}`);
    await page.keyboard.press('End');
    if ((await state()).focus !== 'wkT6') fail(where, 'End');
    await page.keyboard.press('Home');
    st = await state();
    if (st.focus !== 'wkT0' || st.foot[0]?.[1] !== `/releases/#d=${TODAY}`) fail(where, `Home: focus ${st.focus}, today's panel ${JSON.stringify(st.foot)}`);
    await page.keyboard.press('ArrowLeft');
    if ((await state()).focus !== 'wkT6') fail(where, 'ArrowLeft does not wrap');
    await page.keyboard.press('Tab');
    if ((await state()).focus === 'wkT0') fail(where, 'more than one tab stop in the strip');
    await page.locator('#wkT1').click();
    if ((await state()).by !== 'wkT1') fail(where, 'click does not open the day');

    // from /events/' saved game filter: strip and today's panel follow it
    const name = H.titles[code];
    await setStore({ 'tcg.ev.filters': { pref: 'JP-13', game: code } });
    await page.reload({ waitUntil: 'networkidle' });
    st = await state();
    if (st.titles !== short(code)) fail(where, `from /events/: line "${st.titles}"`);
    strip('from /events/', st, [name], [code]);
    if (st.rels.some(g => g !== name)) fail(where, `from /events/: panel releases ${st.rels}`);
    const todays = H.items.filter(x => x.date === TODAY), mine = todays.filter(x => x.game === name);
    if (st.rels.length !== mine.length) fail(where, `from /events/: today's cards ${st.rels}`);
    const hid = todays.length - mine.length;
    if ((hid ? `ほかのタイトルの発売 ${hid}件 ›` : null) !== st.others) fail(where, `from /events/: others "${st.others}"`);
    await page.locator('#home').screenshot({ path: path.join(OUT, `${vp}-home-strip-filtered.png`) });
    // tcg.voices wins over /events/ (VOICES builds)
    if (HAS_VOICES) {
      const evGame = code === 'PTCG' ? 'OPCG,PTCG' : `${code},PTCG`;
      await setStore({ 'tcg.voices': { game: code }, 'tcg.ev.filters': { pref: 'JP-13', game: evGame } });
      await page.reload({ waitUntil: 'networkidle' });
      st = await state();
      if (st.titles !== short(code)) fail(where, `from /voices/: line "${st.titles}"`);
      strip('from /voices/', st, [name], [code], true, evGame.split(','));
      // titles narrower than the /events/ filter: the event counts still follow the filter (the query), links too
      const two = ['OPCG', 'UATCG'];
      await setStore({ 'tcg.voices': { game: two.join(',') }, 'tcg.ev.filters': { pref: 'JP-13' } });
      await page.reload({ waitUntil: 'networkidle' });
      st = await state();
      strip('narrower selection', st, two.map(c => H.titles[c]), null, true, []);
      if (HAS_EVENTS && WEEK1.slice(0, 7) === ym) {
        await page.locator('#wkT1').click();
        st = await state();
        if (st.foot[1]?.[1] !== `/events/?pref=JP-13&range=custom&from=${WEEK1}&to=${WEEK1}`) fail(where, `narrower, ${WEEK1}: day-view link ${st.foot[1]?.[1]}`);
        // /days without by_game: the same counts (they are the day totals)
        nobg = true;
        await page.reload({ waitUntil: 'networkidle' });
        strip('without by_game', await state(), two.map(c => H.titles[c]), null, true, []);
        nobg = false;
      }
      // the pill names the /events/ filter; the panel's イベント header does not repeat it
      await setStore({ 'tcg.voices': { game: two.join(',') }, 'tcg.ev.filters': { pref: 'JP-13', game: 'OPCG,PTCG' } });
      await page.reload({ waitUntil: 'networkidle' });
      st = await state();
      strip('filtered query', st, two.map(c => H.titles[c]), null, true, ['OPCG', 'PTCG']);
      if (HAS_EVENTS && st.evHead !== '') fail(where, `panel heading names "${st.evHead}"`);
      // the legend names the event filter
      if (HAS_EVENTS && st.legend !== '発売数イベント数（ワンピ・ポケカ）') fail(where, `legend "${st.legend}"`);
      // the pill holds only a title /events/ has not (MTG): the counts cover every title, and both the legend and the tab labels say so
      if (HAS_EVENTS && HAS_VOICES) {
        await setStore({ 'tcg.voices': { game: 'MTG' }, 'tcg.ev.filters': { pref: 'JP-13' } });
        await page.reload({ waitUntil: 'networkidle' });
        st = await state();
        const evTabs = st.tabs.filter(t => /^\d+$/.test(t.ev || ''));
        if (st.legend !== '発売数イベント数（すべて）' || !evTabs.length || evTabs.some(t => !t.label.includes(`イベント${t.ev}件（すべて）`)))
          fail(where, `MTG only: legend "${st.legend}", labels ${JSON.stringify(evTabs.map(t => t.label))}`);
      }
    }

    // 変更: the dialog writes the titles (other saved filters kept), cancel writes nothing
    await setStore({ 'tcg.ev.filters': { pref: 'JP-13', days: 'weekend' } });
    await page.reload({ waitUntil: 'networkidle' });
    api.length = 0;
    await page.locator('#hsBtn').click();
    await page.locator('#hsDlg[open]').waitFor();
    const nChips = await page.locator('#hsTitles [data-t]:not([data-t=""])').count();
    const wantChips = Object.keys(H.titles).filter(c => HAS_VOICES || EV13.includes(c)).length;
    if (nChips !== wantChips) fail(where, `dialog offers ${nChips} titles, want ${wantChips}`);
    await page.locator(`#hsTitles [data-t="${code}"]`).click();
    if (await page.locator(`#hsTitles [data-t="${code}"]`).getAttribute('aria-pressed') !== 'true') fail(where, 'chip not pressed');
    await page.screenshot({ path: path.join(OUT, `${vp}-home-settings.png`) });
    await page.locator('#hsOk').click();
    await page.waitForLoadState('networkidle');
    st = await state();
    if (st.dlg || st.focus !== 'hsBtn' || st.titles !== short(code)) fail(where, `after この内容で表示: open ${st.dlg} focus ${st.focus} line "${st.titles}"`);
    if (st.saved[1] !== JSON.stringify({ pref: 'JP-13', days: 'weekend', game: code }) || st.saved[0] !== null) fail(where, `saved ${st.saved}`);
    if (HAS_EVENTS && (api.length !== 2 || api.some(u => !u.includes(`game=${code}&`)))) fail(where, `API after the title change ${api.join(' ')}`);
    strip('after the dialog', st, [name], [code]);
    await page.locator('#hsBtn').click();
    await page.locator('#hsTitles [data-t=""]').click();
    await page.locator('#hsCancel').click();
    st = await state();
    if (st.dlg || st.titles !== short(code) || st.saved[1] !== JSON.stringify({ pref: 'JP-13', days: 'weekend', game: code })) fail(where, `キャンセル: "${st.titles}" ${st.saved}`);
    if (HAS_VOICES) {
      // a title /events/ has not: into tcg.voices; /events/' filter unchanged
      await page.locator('#hsBtn').click();
      await page.locator('#hsTitles [data-t="MTG"]').click();
      await page.locator('#hsOk').click();
      st = await state();
      if (st.saved[0] !== JSON.stringify({ game: `${code},MTG` }) || st.saved[1] !== JSON.stringify({ pref: 'JP-13', days: 'weekend', game: code }) || st.titles !== `${short(code)}・MTG`) fail(where, `MTG: "${st.titles}" ${st.saved}`);
    }
    // すべてのタイトル clears both
    await page.locator('#hsBtn').click();
    await page.locator('#hsTitles [data-t=""]').click();
    await page.locator('#hsOk').click();
    st = await state();
    if (st.titles !== 'すべてのタイトル' || st.saved[1] !== JSON.stringify({ pref: 'JP-13', days: 'weekend' }) || st.saved[0] !== (HAS_VOICES ? '{}' : null)) fail(where, `すべて: "${st.titles}" ${st.saved}`);
    strip('すべて', st, null, null);
    // the location through the shared picker
    if (HAS_EVENTS) {
      // a title chip touched first stays a draft through the picker: Esc afterwards saves no title
      await page.locator('#hsBtn').click();
      await page.locator(`#hsTitles [data-t="${code}"]`).click();
      await page.locator('#hsLocBtn').click();
      await page.locator('#prefDlg[open] [data-pref="JP-27"]').click();
      await page.waitForFunction(() => document.getElementById('hsL').textContent === '大阪府');
      st = await state();
      const pressed = await page.locator(`#hsTitles [data-t="${code}"]`).getAttribute('aria-pressed');
      if (JSON.parse(st.saved[1]).pref !== 'JP-27' || JSON.parse(st.saved[1]).game || !st.dlg || st.focus !== 'hsLocBtn' || pressed !== 'true'
        || await page.locator('#hsLoc').textContent() !== '大阪府') fail(where, `location: ${st.saved[1]} dialog ${st.dlg} focus ${st.focus} chip ${pressed}`);
      if (!st.tabs.every(t => t.ev != null)) fail(where, 'location: no event counts');
      await page.keyboard.press('Escape');
      st = await state();
      if (st.dlg || st.titles !== 'すべてのタイトル' || JSON.parse(st.saved[1]).game) fail(where, `Esc after the picker saved the titles: "${st.titles}" ${st.saved[1]}`);
      // Esc in the picker closes only the picker; the draft is still confirmed by この内容で表示
      await page.locator('#hsBtn').click();
      await page.locator(`#hsTitles [data-t="${code}"]`).click();
      await page.locator('#hsLocBtn').click();
      await page.locator('#prefDlg[open]').waitFor();
      await page.keyboard.press('Escape');
      if (!(await state()).dlg) fail(where, 'Esc in the picker closed the settings dialog');
      await page.locator('#hsOk').click();
      st = await state();
      if (JSON.parse(st.saved[1]).game !== code || st.titles !== short(code)) fail(where, `confirm after the picker: "${st.titles}" ${st.saved[1]}`);
    }
    // the picker's counts arrive after it opened (first /events/meta): the focused location keeps focus
    if (HAS_EVENTS) {
      const p2 = page;
      await setStore({ 'tcg.ev.filters': { pref: 'JP-13' } });
      await page.reload({ waitUntil: 'networkidle' });
      let release; metaHold = new Promise(r => { release = r; });
      await p2.locator('#hsBtn').click();
      await p2.locator('#hsLocBtn').click();
      await p2.locator('#prefDlg[open] [data-pref="JP-27"]').focus();
      if (await p2.locator('#prefDlg [data-pref="JP-27"] em').count()) fail(where, 'meta: counts before the answer');
      release(); metaHold = null;
      await p2.waitForFunction(() => document.querySelector('#prefDlg [data-pref="JP-27"] em'));
      const f2 = await p2.evaluate(() => document.activeElement?.dataset?.pref || document.activeElement?.tagName);
      if (f2 !== 'JP-27') fail(where, `meta: focus moved to ${f2} when the counts arrived`);
      await p2.keyboard.press('Escape');
      await p2.keyboard.press('Escape');
    }
    // account sync while the dialog is open: confirming untouched titles keeps the synced ones; touched ones win
    {
      const sync = g => page.evaluate(g => { const o = JSON.parse(localStorage.getItem('tcg.ev.filters') || '{}'); o.game = g;
        localStorage.setItem('tcg.ev.filters', JSON.stringify(o)); document.dispatchEvent(new CustomEvent('sn:prefs')); }, g);
      const other = code === 'PTCG' ? 'OPCG' : 'PTCG';
      await setStore({ 'tcg.ev.filters': { pref: 'JP-13', game: code } });
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('#hsBtn').click();
      await sync(other);
      if (await page.locator(`#hsTitles [data-t="${other}"]`).getAttribute('aria-pressed') !== 'true') fail(where, 'sync: the open dialog did not follow the synced titles');
      await page.locator('#hsOk').click();
      st = await state();
      if (JSON.parse(st.saved[1]).game !== other || st.titles !== short(other)) fail(where, `sync, untouched: saved ${st.saved[1]} line "${st.titles}"`);
      await page.locator('#hsBtn').click();
      await page.locator(`#hsTitles [data-t="${code}"]`).click();
      await sync(code);
      if (await page.locator(`#hsTitles [data-t="${code}"]`).getAttribute('aria-pressed') !== 'true') fail(where, 'sync: the draft was replaced');
      await page.locator('#hsOk').click();
      st = await state();
      if (JSON.parse(st.saved[1]).game !== Object.keys(H.titles).filter(c => c === code || c === other).join(',')) fail(where, `sync, touched: saved ${st.saved[1]}`);
    }
    // a slow /days answer re-renders the panel: the focused panel link keeps focus
    if (HAS_EVENTS) {
      await setStore({ 'tcg.ev.filters': { pref: 'JP-13' } });
      let release; hold = new Promise(r => { release = r; });
      await page.reload({ waitUntil: 'load' });
      const i = week.findIndex((d, j) => j > 0 && relN(d, null) !== '0');
      if (i > 0) await page.locator(`#wkT${i}`).click();
      const target = page.locator('#wkPanel a.dayl').first();
      await target.focus();
      const before = await page.evaluate(() => { const a = document.activeElement; return a.id || a.getAttribute('href'); });
      if (!await page.locator('#wkPanel .sk').count()) fail(where, 'slow answer: the panel is not loading');
      release(); hold = null;
      await page.waitForFunction(() => !document.querySelector('#wkPanel .sk'));
      const after = await page.evaluate(() => { const a = document.activeElement; return a.id || a.getAttribute('href'); });
      if (after !== before) fail(where, `slow answer: focus moved from ${before} to ${after}`);
    }

    // next month's days: no count; the panel asks for the day's own page once (no /days for next month: counts from its
    // rows) and links the day view (one chosen game: its own)
    const nx = week.findIndex(d => d.slice(0, 7) !== ym);
    if (HAS_EVENTS && nx > 0) {
      await setStore({ 'tcg.ev.filters': { pref: 'JP-13', game: 'OPCG' } });
      await page.reload({ waitUntil: 'networkidle' });
      api.length = 0;
      await page.locator(`#wkT${nx}`).click();
      st = await state();
      const href = `/events/?game=OPCG&pref=JP-13&range=custom&from=${week[nx]}&to=${week[nx]}`;
      const nRows = EVTS.filter(e => e.d === week[nx] && matches(e, ['OPCG'])).length;
      // its rows are all loaded: the strip shows their count; the shared OPCG + PTCG row makes no PTCG column
      if (st.tabs[nx].ev !== String(nRows) || JSON.stringify(st.foot[1]) !== JSON.stringify([EV_LINK, href])) fail(where, `next month ${week[nx]}: ${st.tabs[nx].ev} ${JSON.stringify(st.foot)}`);
      if (api.length !== 1 || !api[0].endsWith(`/api/v1/events?from=${week[nx]}&until=${nm1Of(week[nx])}&game=OPCG&pref=JP-13&limit=50`)) fail(where, `next month ${week[nx]}: requests ${api.join(' ')}`);
      if (JSON.stringify(st.cols) !== JSON.stringify(['ONE PIECE']) || !st.ty.some(t => t.startsWith(`${H.types.standard_battle} 2件`))) fail(where, `next month ${week[nx]}: columns ${st.cols} type lines ${st.ty}`);
      // more rows than its page: no count in the strip, the type line's counts are minimums
      nmBusy = true;
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator(`#wkT${nx}`).click();
      st = await state();
      if (st.tabs[nx].ev !== '–' || !st.ty.length || !st.ty.every(t => t.includes('件以上'))) fail(where, `next month, more rows: ${st.tabs[nx].ev} type lines ${st.ty}`);
      nmBusy = false;
      await page.locator('#home').screenshot({ path: path.join(OUT, `${vp}-home-strip-nextmonth.png`) });
    } else if (HAS_EVENTS) console.log(`  ${where.padEnd(22)} no next-month day this week: next-month check skipped`);

    // no location: no request; the pill names no location, the イベント block is one 地域を設定 button
    api.length = 0;
    await setStore({ 'tcg.ev.filters': { game: code, type: 'standard_battle' } });
    await page.reload({ waitUntil: 'networkidle' });
    st = await state();
    if (api.length) fail(where, `API called without a location: ${api.join(' ')}`);
    if (HAS_EVENTS && (st.loc !== '' || !st.locSet || st.evText !== '地域を設定')) fail(where, `no location: "${st.loc}" ${st.locSet} "${st.evText}"`);
    if (HAS_EVENTS) {
      // 地域を設定 opens the picker; the choice shows in the pill and focus returns to it
      await page.locator('#hsLocSet').click();
      await page.locator('#prefDlg[open] [data-pref="JP-13"]').click();
      await page.waitForFunction(() => document.getElementById('hsL').textContent === '東京都');
      if ((await state()).focus !== 'hsBtn') fail(where, 'focus after 地域を設定');
    }
    strip('no location', st, [name], null, false);
    if (HAS_EVENTS && st.foot[1]?.[1] !== `/events/?game=${code}&type=standard_battle&range=custom&from=${TODAY}&to=${TODAY}`) fail(where, `no location: day-view link ${st.foot[1]?.[1]}`);
  } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
  for (const b of [...new Set(bad)]) fail(where, b);
  console.log(`  ${where.padEnd(22)} checked`);
  await ctx.close();
}
// /events/ with a stubbed API: today's events in Tokyo. The day view's 今日 returns to the calendar without saving
// リスト as the default view; phones show the count without opening 絞り込み.
for (const [vp, opt] of HAS_EVENTS ? Object.entries(VIEWPORTS) : []) {
  const where = `${vp} /events/`;
  const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
    hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
  const bad = [];
  page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
  page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
  const until = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 92 * 864e5).toISOString().slice(0, 10);
  await page.route(EVENTS_API, route => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith('/events/meta')) return route.fulfill({ json: { games: [{ code: 'OPCG', record_count: 7, complete: true,
      fetched_at: `${TODAY}T06:00:00+09:00`, window: { from: TODAY, until } }], types: [], prefectures: [{ code: 'JP-13', count: 7 }] } });
    if (u.pathname.endsWith('/events/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: 7, by_game: { OPCG: 7 } }] } });
    const from = u.searchParams.get('from');
    // e0 started at 10:00 (the clock says 12:00), e1 is cancelled: both go after the rest of the day
    route.fulfill({ json: { events: from > TODAY ? [] : Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, name: `テスト大会 ${i + 1}`, game_code: 'OPCG',
      game_codes: ['OPCG'], starts_on: TODAY, timezone: 'Asia/Tokyo', attendance_mode: 'offline',
      ...(i === 0 ? { time_precision: 'datetime', starts_at: `${TODAY}T10:00:00+09:00` } : { time_precision: 'date' }),
      venue: { name: `テスト店 ${i + 1}` }, source_url: 'https://example.com/', event_status: i === 1 ? 'cancelled' : 'scheduled' })), next_cursor: null } });
  });
  try {
    await page.goto(`${BASE}/events/?pref=JP-13`, { waitUntil: 'networkidle' });
    const hdr = await headerProblem(page, opt.width);
    if (hdr) fail(where, hdr);
    // 13 title chips stay inside the panel (phones: behind 絞り込み); 遊戯王 is a link to the official search only
    if (opt.width <= 760) await page.locator('#filterBtn').click();
    const ym = TODAY.slice(0, 7), monthEnd = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
    const gch = await page.evaluate(() => { const c = document.getElementById('games'), r = c.getBoundingClientRect(), y = document.querySelector('#frow a.ygo');
      return { n: c.querySelectorAll('.chip.g').length, out: [...c.children].filter(b => { const x = b.getBoundingClientRect(); return x.right > r.right + 1 || x.left < r.left - 1; }).length,
        scroll: c.scrollWidth - c.clientWidth, ygo: y && y.offsetParent ? y.href : null }; });
    if (gch.n !== 13 || gch.out || gch.scroll > 1) fail(where, `title chips ${JSON.stringify(gch)}`);
    if (gch.ygo !== `https://cardgame-network.konami.net/tournament_search?sDate=${TODAY}&eDate=${monthEnd}`) fail(where, `遊戯王 link ${gch.ygo}`);
    if (opt.width <= 760) await page.locator('#filterBtn').click();
    await page.locator(`.cd[data-day="${TODAY}"]`).click();
    await page.locator('#list .ev').first().waitFor();
    const order = await page.evaluate(() => [...document.querySelectorAll(`#list .list > *`)].map(e => e.classList.contains('evsep') ? '|' : e.querySelector('h4 .t').textContent.replace('テスト大会 ', '')));
    if (order.join(' ') !== '3 4 5 6 7 | 1 2') fail(where, `today's order ${order.join(' ')}`);
    const cl = await page.locator('#list .ev.off .ev-link').textContent();
    if (!cl.startsWith('公式で確認')) fail(where, `cancelled link reads ${cl}`);
    if (!(await page.locator('#filterBtn').getAttribute('aria-label'))?.startsWith('絞り込み')) fail(where, '#filterBtn has no accessible name');
    const rowOver = await page.evaluate(() => { const r = document.querySelector('.panel>.row'), last = [...r.children].filter(e => e.offsetParent).at(-1);
      return Math.max(r.scrollWidth - r.clientWidth, last ? last.getBoundingClientRect().right - r.getBoundingClientRect().right : 0); });
    if (rowOver > 1) fail(where, `toolbar row overflows by ${Math.round(rowOver)}px`);
    const mcount = page.locator('#rhead .mcount');
    if (opt.width <= 760 && !(await mcount.isVisible() && (await mcount.textContent()).includes('7'))) fail(where, 'day view: count not visible without 絞り込み');
    if (opt.width > 760 && await mcount.isVisible()) fail(where, 'count shown twice on desktop');
    await page.locator('#goToday').click();
    await page.waitForFunction(() => !location.search.includes('range=custom'));
    const after = await page.evaluate(() => ({ q: location.search, cal: !document.getElementById('calv').hidden, saved: JSON.parse(localStorage.getItem('tcg.ev.filters') || 'null'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    if (!after.cal || /view=list/.test(after.q) || after.saved?.view === 'list') fail(where, `今日 from the day view saved the list view: ${after.q} ${JSON.stringify(after.saved)}`);
    if (after.overflow > 1) fail(where, `page scrolls horizontally by ${after.overflow}px`);
    await page.screenshot({ path: path.join(OUT, `${vp}-events.png`), fullPage: false });
  } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
  for (const b of [...new Set(bad)]) fail(where, b);
  console.log(`  ${where.padEnd(22)} checked`);
  await ctx.close();
}
// /item/<id>/ product pages: a code + photo, a 参考画像 and a placeholder example at both widths (the first also dark):
// they render without errors or horizontal scroll, every internal link answers 200, 新弾カレンダーで見る opens the item and
// the detail dialog's 商品ページ link comes back.
{
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/items.json'), 'utf8'));
  const ov = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/overrides.json'), 'utf8'));
  const vis = items.map(i => ({ ...i, ...(ov[i.id] || {}) })).filter(i => !i.hide && fs.existsSync(path.join(DIST, 'item', i.id, 'index.html')));
  const picks = [...new Map([
    vis.find(i => i.thumb && !i.approx && /【[A-Z0-9-]+】/.test(i.name) && i.date >= TODAY) || vis.find(i => i.thumb && !i.approx),
    vis.find(i => i.approx && i.thumb), vis.find(i => !i.thumb)].filter(Boolean).map(i => [i.id, i])).values()];
  if (!picks.length) fail('/item/', 'no item pages built');
  const checked = new Set();
  for (const [vp, opt] of Object.entries(VIEWPORTS)) for (const [n, it] of picks.entries()) for (const dark of n === 0 ? [false, true] : [false]) {
    const where = `${vp} /item/${it.id}/${dark ? ' dark' : ''}`;
    const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
      hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: dark ? 'dark' : 'light' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    const bad = [];
    page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    page.on('requestfailed', r => { if (r.url().startsWith(BASE)) bad.push(`request failed: ${r.url()}`); });
    page.on('response', r => { if (r.url().startsWith(BASE) && r.status() >= 400) bad.push(`HTTP ${r.status()}: ${r.url().slice(BASE.length)}`); });
    try {
      const res = await page.goto(`${BASE}/item/${it.id}/`, { waitUntil: 'networkidle' });
      if (!res || res.status() !== 200) fail(where, `status ${res && res.status()}`);
      const st = await page.evaluate(() => ({
        h1: document.querySelector('h1')?.textContent, h1s: document.querySelectorAll('h1').length,
        brokenImgs: [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src')),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ap: !!document.querySelector('.pd-img .ap'), ph: !!document.querySelector('.pd-img .th.none'),
        links: [...new Set([...document.querySelectorAll('a[href^="/"]')].map(a => a.getAttribute('href').split('#')[0]))],
        thW: document.querySelector('.pd-img .th')?.getBoundingClientRect().width }));
      if (st.h1s !== 1 || st.h1 !== it.name) fail(where, `h1 ${JSON.stringify(st.h1)} != ${JSON.stringify(it.name)}`);
      if (st.ap !== !!it.approx) fail(where, `参考画像 label ${st.ap ? 'shown' : 'missing'}`);
      if (st.ph !== !it.thumb) fail(where, `placeholder ${st.ph ? 'shown' : 'missing'}`);
      if (!st.thW) fail(where, 'no product image');
      if (st.brokenImgs.length) fail(where, `broken images ${st.brokenImgs.join(', ')}`);
      if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
      const hdr = await headerProblem(page, opt.width);
      if (hdr) fail(where, hdr);
      for (const l of st.links) {
        if (checked.has(l)) continue;
        checked.add(l);
        const r = await page.request.get(BASE + l);
        if (r.status() !== 200) fail(where, `link ${l} answers ${r.status()}`);
      }
      await page.screenshot({ path: path.join(OUT, `${vp}-item-${it.id}${dark ? '-dark' : ''}.png`), fullPage: true });
      if (!dark) {
        await page.locator('.dl-links a.go').click();
        await page.waitForURL(u => u.pathname === '/releases/');
        await page.locator('#dlg[open] .dl-item h4').waitFor({ timeout: 5000 });
        const h4 = await page.locator('#dlg .dl-item h4').allTextContents();
        if (h4.length !== 1 || h4[0] !== it.name) fail(where, `新弾カレンダーで見る opened ${JSON.stringify(h4)}`);
        // and back: the dialog's 商品ページ link leads to this page
        const pl = page.locator('#dlg .dl-item a.itempg');
        if (await pl.count() !== 1 || (await pl.textContent()) !== '商品ページ' || (await pl.getAttribute('href')) !== `/item/${it.id}/`) fail(where, 'detail dialog lacks its 商品ページ link');
        else {
          await pl.click();
          await page.waitForURL(u => u.pathname === `/item/${it.id}/`, { timeout: 5000 });
        }
      }
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    for (const b of [...new Set(bad)]) fail(where, b);
    console.log(`  ${where.padEnd(22)} checked`);
    await ctx.close();
  }
}
// archived /item/<id>/ pages (data/items-archive.json): released items out of the calendar keep their page, marked
// 発売済み, with no link into the calendar; listed in the sitemap, absent from /releases/ and /.
{
  const ap = path.join(ROOT, 'data/items-archive.json');
  const items = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/items.json'), 'utf8')).map(i => i.id));
  const ov = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/overrides.json'), 'utf8'));
  const arch = (fs.existsSync(ap) ? JSON.parse(fs.readFileSync(ap, 'utf8')) : []).filter(a => !items.has(a.id) && !(ov[a.id] || {}).hide)
    .map(a => ({ ...a, ...(ov[a.id] || {}) }));
  const sitemap = fs.readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8');
  const cal = ['/', '/releases/'].map(p => fs.readFileSync(path.join(DIST, p.slice(1), 'index.html'), 'utf8'));
  for (const a of arch) {
    if (!fs.existsSync(path.join(DIST, 'item', a.id, 'index.html'))) fail(`/item/${a.id}/`, 'archived item has no page');
    if (!sitemap.includes(`<loc>https://shindan-navi.app/item/${a.id}/</loc>`)) fail(`/item/${a.id}/`, 'archived page not in the sitemap');
    if (cal.some(t => t.includes(a.id))) fail(`/item/${a.id}/`, 'archived item is on / or /releases/');
  }
  const picks = [...new Map([arch.find(a => a.thumb && fs.existsSync(path.join(DIST, a.thumb))), arch[arch.length - 1]].filter(Boolean).map(a => [a.id, a])).values()];
  const checked = new Set();
  for (const [vp, opt] of picks.length ? Object.entries(VIEWPORTS) : []) for (const it of picks) {
    const where = `${vp} /item/${it.id}/ archived`;
    const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
      hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    const bad = [];
    page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    page.on('requestfailed', r => { if (r.url().startsWith(BASE)) bad.push(`request failed: ${r.url()}`); });
    page.on('response', r => { if (r.url().startsWith(BASE) && r.status() >= 400) bad.push(`HTTP ${r.status()}: ${r.url().slice(BASE.length)}`); });
    try {
      const res = await page.goto(`${BASE}/item/${it.id}/`, { waitUntil: 'networkidle' });
      if (!res || res.status() !== 200) fail(where, `status ${res && res.status()}`);
      const st = await page.evaluate(() => {
        const sold = document.querySelector('.pd-tag .pd-sold'), r = sold && sold.getBoundingClientRect();
        return { h1: document.querySelector('h1')?.textContent, sold: sold && sold.textContent, soldShown: !!(r && r.width && r.height),
          cal: document.querySelectorAll('a[href^="/releases/#"]').length, go: document.querySelector('.dl-links a.go')?.getAttribute('href'),
          brokenImgs: [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src')),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ph: !!document.querySelector('.pd-img .th.none'),
          links: [...new Set([...document.querySelectorAll('a[href^="/"]')].map(a => a.getAttribute('href').split('#')[0]))] };
      });
      if (st.h1 !== it.name) fail(where, `h1 ${JSON.stringify(st.h1)} != ${JSON.stringify(it.name)}`);
      if (st.sold !== '発売済み' || !st.soldShown) fail(where, '発売済み not shown');
      if (st.cal) fail(where, `${st.cal} links into the calendar`);
      if (!st.go || st.go.startsWith('/releases/#')) fail(where, `call to action ${st.go}`);
      if (st.ph !== !(it.thumb && fs.existsSync(path.join(DIST, it.thumb)))) fail(where, `placeholder ${st.ph ? 'shown' : 'missing'}`);
      if (st.brokenImgs.length) fail(where, `broken images ${st.brokenImgs.join(', ')}`);
      if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
      const hdr = await headerProblem(page, opt.width);
      if (hdr) fail(where, hdr);
      for (const l of st.links) {
        if (checked.has(l)) continue;
        checked.add(l);
        const r = await page.request.get(BASE + l);
        if (r.status() !== 200) fail(where, `link ${l} answers ${r.status()}`);
      }
      await page.screenshot({ path: path.join(OUT, `${vp}-item-archived-${it.id}.png`), fullPage: true });
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    for (const b of [...new Set(bad)]) fail(where, b);
    console.log(`  ${where.padEnd(22)} checked`);
    await ctx.close();
  }
  console.log(`  /item/ archived       ${arch.length} pages`);
}
// /voices/ (VOICES_ENABLED=1 builds only): the snapshots of /api/v1/voices (VOICE_SNAPS) on the calendar (a chip per
// game on desktop, bars when one game is selected, a dot per game on phones) on the right days, the day, game and topic
// dialogs, the list view and its この日のまとめ links, the filters and safe X links; shares that add up to 100%, one freshness line per snapshot, the dialog in the URL hash
// and the copied topic link, 🆕 only with an older snapshot, one tab stop per day.
for (const [vp, opt] of HAS_VOICES ? Object.entries(VIEWPORTS) : []) {
  const where = `${vp} /voices/`;
  const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
    hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
  const bad = [], api = [];
  page.on('dialog', d => { bad.push(`unexpected ${d.type()}: ${d.message()}`); d.dismiss(); });
  page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
  page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
  page.on('request', r => { if (r.url().includes('/api/')) api.push(r.url()); });
  const narrow = opt.width <= 760;
  // topics per day as the page should show them: first_seen .. the last snapshot listing the id
  const expect = filter => page.evaluate(([f, snaps]) => {
    const tp = new Map();
    [...snaps].sort((a, b) => a.date < b.date ? -1 : 1).forEach(s => s.topics.forEach(t => {
      const x = tp.get(t.id) || { id: t.id, game: t.game, first: t.first_seen, att: t.attitude }; x.last = s.date; x.att = t.attitude;
      if (t.first_seen < x.first) x.first = t.first_seen; tp.set(t.id, x); }));
    const out = {};
    for (const x of tp.values()) {
      if (f.att && x.att !== f.att) continue;
      for (let d = x.first; d <= x.last; d = new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10)) (out[d] ||= []).push(x);
    }
    return out;
  }, [filter || {}, VOICE_SNAPS]);
  // per day: the visible game marks (chips / dots) as [game, topic count], or the number of bars covering it
  const shown = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.vd[data-day]')].map(b => [b.dataset.day,
    [...b.querySelectorAll('.vchip,.vg')].filter(e => e.offsetParent).map(e => [e.dataset.game || '', +(e.querySelector('.vn')?.textContent || 1)])])));
  const barsOn = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.vd[data-day]')].map(b => [b.dataset.day,
    [...document.querySelectorAll('.vbar')].filter(x => { const [c0, c1] = x.style.gridColumn.split('/').map(Number), c = [...b.parentNode.children].indexOf(b) + 1;
      return x.offsetParent && x.parentNode === b.parentNode && c >= c0 && c < c1; }).length])));
  const perGame = xs => xs.reduce((m, x) => (m[x.game] = (m[x.game] || 0) + 1, m), {});
  const marksOk = (got, xs) => { const pg = perGame(xs);
    return got && got.length === Object.keys(pg).length && (narrow || got.every(([g, n]) => pg[g] === n)); };
  try {
    await page.goto(`${BASE}/voices/`, { waitUntil: 'networkidle' });
    const hdr = await headerProblem(page, opt.width);
    if (hdr) fail(where, hdr);
    const want = await expect();
    const days = Object.keys(want).sort();
    const month = await page.locator('#monthLabel').textContent();
    const inView = days.filter(d => month === `${+d.slice(0, 4)}年${+d.slice(5, 7)}月`);
    if (!inView.length) fail(where, `calendar opens on ${month} without topics`);
    const got = await shown();
    for (const d of inView) if (!marksOk(got[d], want[d])) fail(where, `${d}: ${JSON.stringify(got[d])} ${narrow ? 'game dots' : 'game chips'}, expected ${JSON.stringify(perGame(want[d]))}`);
    if (!narrow && await page.locator('.vbar').count()) fail(where, 'topic bars without a single game selected');
    const extra = Object.keys(got).filter(d => !want[d]);
    if (extra.length) fail(where, `days with topics that have none: ${extra.join(' ')}`);
    // freshness: one entry for the snapshot most titles share, plus one per title on another snapshot
    const fr = await page.evaluate(snaps => {
      const last = {}; [...snaps].sort((a, b) => a.date < b.date ? -1 : 1).forEach(s => s.topics.forEach(t => last[t.game] = s.date));
      const n = {}; Object.values(last).forEach(d => n[d] = (n[d] || 0) + 1);
      return { want: 1 + Object.values(last).length - Math.max(...Object.values(n)), got: document.querySelectorAll('#fresh .frl>span:not(.lab)').length };
    }, VOICE_SNAPS);
    if (fr.got !== fr.want) fail(where, `freshness line has ${fr.got} entries, expected ${fr.want}`);
    // keyboard: one tab stop per day with topics (chips and bars are mouse / touch shortcuts)
    const stops = await page.evaluate(() => ({ n: [...document.querySelectorAll('#calv button, #calv a, #calv [tabindex]')].filter(e => e.tabIndex >= 0 && e.offsetParent).length,
      days: document.querySelectorAll('.vd[data-day]').length }));
    if (stops.n !== stops.days) fail(where, `${stops.n} tab stops in the calendar for ${stops.days} days with topics`);
    // day dialog
    const d0 = inView[0];
    await page.locator(`.vd[data-day="${d0}"] .vdn`).click();
    await page.locator('#vDlg[open]').waitFor();
    const dl = await page.evaluate(() => ({ n: document.querySelectorAll('#vBody .tc').length, title: document.getElementById('vTitle').textContent,
      links: [...document.querySelectorAll('#vBody a[data-x]')].map(a => [a.href, a.target, a.rel]), ai: document.querySelectorAll('#vBody .ai').length,
      xa: [...document.querySelectorAll('#vBody a')].filter(a => /^https?:\/\/(www\.)?(x|twitter)\.com\//.test(a.href)).map(a => [a.href, a.dataset.x, a.textContent]),
      players: document.getElementById('vBody').textContent.includes('関連する投稿') }));
    // owner decision 2026-11-20: a card links only its official reacting_to post, never the players who posted
    if (dl.players || dl.xa.some(([h, k, txt]) => k !== 'reacting' || !txt.startsWith('反応元の公式投稿') || !OFFICIAL_X.has(h))) fail(where, `day dialog links players' posts ${JSON.stringify(dl.xa.slice(0, 2))}`);
    if (dl.n !== want[d0].length || dl.ai !== dl.n) fail(where, `day dialog ${d0}: ${dl.n} cards (${dl.ai} AI labels), expected ${want[d0].length}`);
    if (dl.links.some(([h, t, r]) => !/^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/.test(h) || t !== '_blank' || !/noopener/.test(r) || !/noreferrer/.test(r))) fail(where, `unsafe X links ${JSON.stringify(dl.links.slice(0, 2))}`);
    const dlgOver = await page.evaluate(() => { const d = document.getElementById('vDlg'); return d.scrollWidth - d.clientWidth; });
    if (dlgOver > 1) fail(where, `day dialog scrolls horizontally by ${dlgOver}px`);
    await page.screenshot({ path: path.join(OUT, `${vp}-voices-day.png`) });
    // the open dialog is in the hash without a history entry; the topic's copied link opens that topic
    const hist0 = await page.evaluate(() => history.length);
    if (await page.evaluate(() => location.hash) !== `#d=${d0}`) fail(where, `day dialog hash ${await page.evaluate(() => location.hash)}`);
    const t0 = await page.locator('#vBody .tc').first().getAttribute('data-topic');
    await page.locator('#vBody .tc').first().locator('[data-copy]').click();
    await page.waitForFunction(() => document.getElementById('vLive').textContent);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (copied !== `${BASE}/voices/#t=${t0}`) fail(where, `copied link ${copied}`);
    // the game row in the day dialog filters it (keyboard and phones reach it here)
    const dg = page.locator('#vBody .dgames [data-k="dgame"]');
    if (new Set(want[d0].map(x => x.game)).size > 1) {
      const g1 = await dg.nth(1).getAttribute('data-v');
      await dg.nth(1).click();
      if (await page.locator('#vBody .tc').count() !== want[d0].filter(x => x.game === g1).length) fail(where, `dialog game filter ${g1}`);
    }
    await page.keyboard.press('Escape');
    if (await page.locator('#vDlg').evaluate(d => d.open)) fail(where, 'Escape did not close the day dialog');
    // the dialog's close event (which clears the hash) runs as a later task
    await page.waitForFunction(() => !location.hash, null, { timeout: 2000 }).catch(() => {});
    const h1 = await page.evaluate(() => [location.hash, history.length]);
    if (h1[0] !== '' || h1[1] !== hist0) fail(where, `after close: hash ${h1[0]}, history ${hist0} -> ${h1[1]}`);
    // Enter on a focused day opens it
    await page.locator(`.vd[data-day="${d0}"] .vdn`).focus();
    await page.keyboard.press('Enter');
    if (!await page.locator('#vDlg').evaluate(d => d.open)) fail(where, 'Enter on a day did not open it');
    await page.keyboard.press('Escape');
    if (!narrow) {
      // a game chip opens that day filtered to its game, with a button back to the whole day
      const chipEl = page.locator(`.vd[data-day="${d0}"] .vchip`).first(), cg = await chipEl.getAttribute('data-game');
      await chipEl.click();
      const cd = await page.evaluate(() => [...document.querySelectorAll('#vBody .tc')].map(e => e.dataset.topic));
      const wantG = want[d0].filter(x => x.game === cg).map(x => x.id);
      if (cd.length !== wantG.length || cd.some(id => !wantG.includes(id))) fail(where, `chip ${cg} on ${d0}: ${cd.length} cards, expected ${wantG.length}`);
      await page.screenshot({ path: path.join(OUT, `${vp}-voices-game.png`) });
      if (want[d0].length > wantG.length) {
        await page.locator('#vBody [data-allday]').click();
        if (await page.locator('#vBody .tc').count() !== want[d0].length) fail(where, 'この日のすべての話題 did not show the whole day');
      }
      await page.keyboard.press('Escape');
    }
    // attitude filter
    if (narrow) await page.locator('#filterBtn').click();
    await page.locator('#frow [data-k="att"][data-v="negative"]').click();
    const wantN = await expect({ att: 'negative' }), gotN = await shown();
    for (const d of inView) if (wantN[d] ? !marksOk(gotN[d], wantN[d]) : gotN[d] !== undefined) fail(where, `negative filter ${d}: ${JSON.stringify(gotN[d])}, expected ${JSON.stringify(wantN[d] && perGame(wantN[d]))}`);
    if (JSON.parse(await page.evaluate(() => localStorage.getItem('tcg.voices'))).att !== 'negative') fail(where, 'attitude filter not saved');
    // game filter: one game's chip (the first with topics under the attitude filter) leaves only its topics
    const g = await page.evaluate(() => [...document.querySelectorAll('#games .chip.g')].find(c => +c.querySelector('em').textContent > 0)?.dataset.v);
    await page.locator(`#games .chip.g[data-v="${g}"]`).click();
    const games = await page.evaluate(() => [...document.querySelectorAll('.vbar,.vg,.vchip')].filter(e => e.offsetParent).map(e => e.getAttribute('style')));
    const gs = await page.locator(`#games .chip.g[data-v="${g}"]`).getAttribute('style');
    if (!games.length || games.some(st => !st.startsWith(gs))) fail(where, `game filter ${g} shows other games`);
    if (!narrow) {
      // one game selected: its topics as bars over their days (at most 4 lanes), a bar opens its topic
      const wantG = await expect({ att: 'negative' }), gotB = await barsOn();
      for (const d of inView) { const n = (wantG[d] || []).filter(x => x.game === g).length;
        if (n && gotB[d] !== Math.min(n, 4)) fail(where, `${g} bars on ${d}: ${gotB[d]}, expected ${Math.min(n, 4)}`); }
      if (await page.locator('.vchip').count()) fail(where, 'game chips with one game selected');
      await page.locator('.vbar').first().click();
      if (await page.locator('#vBody .tc').count() !== 1) fail(where, 'topic bar did not open its topic');
      await page.locator('#vClose').click();
    }
    // phone toolbar with an active filter (badge on 絞り込み): nothing past the panel edge at common widths
    if (narrow) {
      for (const w of [344, 360, 375, 384, 390, 393]) {
        await page.setViewportSize({ width: w, height: opt.height });
        const o = await page.evaluate(() => { const r = document.querySelector('.panel>.row'), last = [...r.children].filter(e => e.offsetParent).at(-1);
          return Math.max(r.scrollWidth - r.clientWidth, last ? last.getBoundingClientRect().right - r.getBoundingClientRect().right : 0); });
        if (o > 1) fail(where, `toolbar row with a filter overflows by ${Math.round(o)}px at ${w}px`);
      }
      await page.setViewportSize({ width: opt.width, height: opt.height });
    }
    await page.locator('#resetAll').click();
    if (narrow) await page.locator('#filterBtn').click();
    const ov1 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (ov1 > 1) fail(where, `calendar scrolls horizontally by ${ov1}px`);
    const rowOver = await page.evaluate(() => { const r = document.querySelector('.panel>.row'), last = [...r.children].filter(e => e.offsetParent).at(-1);
      return Math.max(r.scrollWidth - r.clientWidth, last ? last.getBoundingClientRect().right - r.getBoundingClientRect().right : 0); });
    if (rowOver > 1) fail(where, `toolbar row overflows by ${Math.round(rowOver)}px`);
    await page.screenshot({ path: path.join(OUT, `${vp}-voices.png`), fullPage: true });
    // list view: snapshots newest first, every topic once per snapshot
    await page.locator('#vList').click();
    const li = await page.evaluate(snaps => ({ heads: [...document.querySelectorAll('#list .vsnap')].map(s => s.getAttribute('aria-labelledby').slice(2)),
      cards: document.querySelectorAll('#list .tc').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      want: [...snaps].filter(s => s.topics.length).map(s => s.date).sort().reverse(), n: snaps.reduce((t, s) => t + s.topics.length, 0) }), VOICE_SNAPS);
    if (JSON.stringify(li.heads) !== JSON.stringify(li.want) || li.cards !== li.n) fail(where, `list ${JSON.stringify(li)}`);
    if (li.overflow > 1) fail(where, `list scrolls horizontally by ${li.overflow}px`);
    const sl = await page.evaluate(() => [...document.querySelectorAll('#list .vsl')].map(a => a.getAttribute('href')));
    if (JSON.stringify(sl) !== JSON.stringify(li.want.map(d => `/voices/#d=${d}`))) fail(where, `この日のまとめ links ${JSON.stringify(sl)}`);
    // shares in 10% steps adding up to 100% on every card; 🆕 only once an older snapshot exists
    // (cards on fewer than 5 posts: no bar, no percentages, a tendency phrase)
    const sh = await page.evaluate(() => [...document.querySelectorAll('#list .tc .att:not([data-small]) .alg')].map(a => [...a.children].reduce((t, x) => t + (+(/約(\d+)%/.exec(x.textContent) || [0, 0])[1]), 0)));
    if (sh.some(n => n !== 100)) fail(where, `share labels add up to ${[...new Set(sh.filter(n => n !== 100))].join('/')}%`);
    const sm = await page.evaluate(snaps => [...document.querySelectorAll('#list .vsnap')].flatMap(sec => {
      const snap = snaps.find(x => x.date === sec.getAttribute('aria-labelledby').slice(2));
      return [...sec.querySelectorAll('.tc')].map(tc => { const t = snap.topics.find(x => x.id === tc.dataset.topic), n = t.share.positive + t.share.negative + t.share.neutral;
        const small = !!tc.querySelector('.att[data-small]'), pct = /\d+%/.test(tc.querySelector('.att').textContent) || !!tc.querySelector('.abar');
        return (n < 5) !== small || (small && pct) ? `${t.id} n=${n} small=${small} pct=${pct}` : ''; }).filter(Boolean); }), VOICE_SNAPS);
    if (sm.length) fail(where, `small-sample cards: ${sm.slice(0, 3).join(', ')}`);
    if (VOICE_SNAPS.length === 1 && await page.locator('.badge.new').count()) fail(where, '🆕 shown with a single snapshot');
    await page.screenshot({ path: path.join(OUT, `${vp}-voices-list.png`), fullPage: true });
    // deep links: a real day opens its dialog, an impossible date is ignored
    for (const [i, [h, open]] of [[`#d=${d0}`, true], ['#d=2026-02-31', false], ['#d=2026-13-01', false]].entries()) {
      await page.goto(`${BASE}/voices/?view=list&r=${i}${h}`, { waitUntil: 'networkidle' });
      if (await page.locator('#vDlg').evaluate(d => d.open) !== open) fail(where, `deep link ${h}: dialog ${open ? 'not opened' : 'opened'}`);
      if (await page.evaluate(() => location.hash) !== (open ? h : '')) fail(where, `deep link ${h}: hash ${await page.evaluate(() => location.hash)}`);
    }
    await page.goto(`${BASE}/voices/#t=${t0}`, { waitUntil: 'networkidle' });
    if (await page.locator('#vBody .tc').count() !== 1 || await page.locator('#vBody .tc').getAttribute('data-topic') !== t0) fail(where, `copied link #t=${t0} did not open its topic`);
    const other = api.filter(u => new URL(u).pathname !== '/api/v1/voices');
    if (other.length) fail(where, `API requests other than /api/v1/voices: ${other.join(' ')}`);
  } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
  for (const b of [...new Set(bad)]) fail(where, b);
  console.log(`  ${where.padEnd(22)} checked`);
  await ctx.close();
}
// /events/ list at 20:00 with 100 started and 30 upcoming events today (50 per page): the list loads today's pages by
// itself and puts the upcoming ones first, unless the reader already scrolled into today (then nothing above moves).
const GSTUB = `(()=>{class E{addListener(){return{remove(){}}}}
class Map extends E{constructor(el,o){super();this.z=o.zoom||10}fitBounds(){}setCenter(){}setZoom(z){this.z=z}getZoom(){return this.z}panTo(){}}
class Marker extends E{constructor(o){super();this.p=o.position}setMap(){}setLabel(){}setTitle(){}setIcon(){}setZIndex(){}getPosition(){return this.p}setAnimation(){}}
class Size{constructor(w,h){this.width=w;this.height=h}}class Point{constructor(x,y){this.x=x;this.y=y}}
window.google={maps:{importLibrary:async n=>n==='maps'?{Map}:n==='marker'?{Marker,Animation:{BOUNCE:1}}:{Size,Point}}};
setTimeout(()=>window.__snMapsReady&&window.__snMapsReady(),0);})();`;
async function eventsPage(vp, n, mk, delay = 0) {
  const opt = VIEWPORTS[vp];
  const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
    hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`${TODAY}T20:00:00+09:00`));
  const bad = [];
  page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
  const until = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 92 * 864e5).toISOString().slice(0, 10);
  const evs = Array.from({ length: n }, (_, i) => mk(i));
  await page.route('https://maps.googleapis.com/**', r => r.fulfill({ contentType: 'text/javascript', body: GSTUB }));
  await page.route(EVENTS_API, async route => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith('/events/meta')) return route.fulfill({ json: { games: [{ code: 'OPCG', record_count: n, complete: true,
      fetched_at: `${TODAY}T06:00:00+09:00`, window: { from: TODAY, until } }], types: [], prefectures: [{ code: 'JP-13', count: n }] } });
    if (u.pathname.endsWith('/events/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: n, by_game: { OPCG: n } }] } });
    if (u.searchParams.get('from') > TODAY) return route.fulfill({ json: { events: [], next_cursor: null } });
    const c = +(u.searchParams.get('cursor') || 0);
    if (c && delay) await new Promise(r => setTimeout(r, delay));
    route.fulfill({ json: { events: evs.slice(c, c + 50), next_cursor: c + 50 < n ? String(c + 50) : null } });
  });
  return { ctx, page, bad };
}
if (HAS_EVENTS) {
  const evt = i => ({ id: `t${i}`, name: `${i < 100 ? 'S' : 'U'}${i}`, game_code: 'OPCG', game_codes: ['OPCG'], starts_on: TODAY,
    time_precision: 'datetime', starts_at: `${TODAY}T${i < 100 ? String(10 + (i % 9)).padStart(2, '0') : '21'}:00:00+09:00`, timezone: 'Asia/Tokyo',
    attendance_mode: 'offline', venue: { name: `店 ${i}` }, source_url: 'https://example.com/', event_status: 'scheduled' });
  const sec = `#list .ag[data-day="${TODAY}"]`;
  for (const scroll of [false, true]) {
    const where = `desktop /events/ list today${scroll ? ' scrolled' : ''}`;
    const { ctx, page, bad } = await eventsPage('desktop', 130, evt, scroll ? 800 : 0);
    try {
      await page.goto(`${BASE}/events/?pref=JP-13&view=list`, { waitUntil: 'load' });
      let anchor = null;
      if (scroll) {
        await page.locator(`${sec} .ev >> nth=49`).waitFor();
        anchor = await page.evaluate(s => { const c = document.querySelectorAll(`${s} .ev`)[20]; window.scrollBy(0, c.getBoundingClientRect().top - 200);
          return { name: c.querySelector('h4').textContent, top: c.getBoundingClientRect().top }; }, sec);
      }
      await page.waitForFunction(s => document.querySelectorAll(`${s} .ev`).length === 130, sec, { timeout: 15000 });
      const r = await page.evaluate(([s, a]) => { const cs = [...document.querySelectorAll(`${s} .ev`)];
        const c = a && cs.find(x => x.querySelector('h4').textContent === a.name);
        return { first: cs[0].querySelector('h4').textContent, sep: !!document.querySelector(`${s} .evsep`), top: c ? c.getBoundingClientRect().top : null }; }, [sec, anchor]);
      if (!scroll && (!r.first.startsWith('U') || !r.sep)) fail(where, `upcoming not first: ${JSON.stringify(r)}`);
      if (scroll && (r.first !== 'S0' || Math.abs(r.top - anchor.top) > 2)) fail(where, `rows moved under the reader: ${JSON.stringify({ ...r, anchor })}`);
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    for (const b of [...new Set(bad)]) fail(where, b);
    console.log(`  ${where.padEnd(22)} checked`);
    await ctx.close();
  }
  // phone day view with a map: it sticks under the toolbar, a pin tap keeps the map and the card in view; short screens get a static map
  const geo = i => ({ ...evt(100 + i), id: `g${i}`, name: `G${i}`, venue: { name: `店 ${i}`, geo: { lat: 35.6 + i / 100, lng: 139.7 } } });
  const where = 'mobile /events/ day map';
  const { ctx, page, bad } = await eventsPage('mobile', 14, geo);
  try {
    await page.goto(`${BASE}/events/?pref=JP-13&range=custom&from=${TODAY}&to=${TODAY}&__maps=1`, { waitUntil: 'networkidle' });
    await page.locator('#mapTog').click();
    await page.locator('#mapv.open #gmap').waitFor();
    await page.locator('#list .ev >> nth=10').locator('.ev-pin').click();
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => { const v = document.getElementById('mapv').getBoundingClientRect(), bar = document.querySelector('.bar').getBoundingClientRect(),
      c = document.querySelector('#list .ev.hl')?.getBoundingClientRect();
      return { pos: getComputedStyle(document.getElementById('mapv')).position, vTop: v.top, vBottom: v.bottom, bar: bar.bottom, cTop: c && c.top, h: innerHeight, y: scrollY }; });
    if (m.pos !== 'sticky' || m.y < 1 || Math.abs(m.vTop - m.bar) > 2 || m.cTop == null || m.cTop < m.vBottom - 1 || m.cTop > m.h - 40) fail(where, `map/card not both in view: ${JSON.stringify(m)}`);
    await page.setViewportSize({ width: 740, height: 390 });
    if (await page.locator('#mapv').evaluate(v => getComputedStyle(v).position) !== 'static') fail(where, 'map sticky on a short screen');
  } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
  for (const b of [...new Set(bad)]) fail(where, b);
  console.log(`  ${where.padEnd(22)} checked`);
  await ctx.close();
}
// Event rows (src/evrow.html) on /events/ day views and the home page's columns: display names without month markers,
// identical events of a day as one row that expands to its stores (count from the loaded rows, 以上 while the day has
// more), a map pick opening the group of its card, no game tag under a one-title filter; and no metadata under 12px
// (event names 14-16px) on /events/, / and the /releases/ calendar.
const smallText = (sels, skip = '.sr,.gi,.tbadge,.tb,.lb') => document.querySelectorAll(sels).length === 0 ? ['none of ' + sels]
  : [...document.querySelectorAll(sels)].flatMap(el => [el, ...el.querySelectorAll('*')])
    .filter(e => e.getClientRects().length && !e.closest(skip) && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
      && parseFloat(getComputedStyle(e).fontSize) < 12)
    .map(e => `${e.className || e.tagName} ${getComputedStyle(e).fontSize} "${e.textContent.trim().slice(0, 20)}"`);
if (HAS_EVENTS) {
  const CITY = ['渋谷区', '新宿区', '豊島区', '八王子市'];
  const rev = (i, code, name, type, hh, x = {}) => ({ id: `r${code}${i}`, name, game_code: code, game_codes: [code], starts_on: TODAY,
    time_precision: 'datetime', starts_at: `${TODAY}T${String(hh).padStart(2, '0')}:00:00+09:00`, timezone: 'Asia/Tokyo', attendance_mode: 'in_person',
    venue: { name: `店舗 ${code}${i}`, region_code: 'JP-13', region_name: '東京都', city: CITY[i % 4], geo: { lat: 35.6 + i / 100, lng: 139.7 + i / 1000 } },
    group: { name, category: 'tournament', event_type_code: type }, registration_status: i % 3 ? 'open' : 'closed', registration_method: 'first_come',
    source_url: 'https://example.com/', event_status: 'scheduled', ...x });
  const REVS = [...Array.from({ length: 20 }, (_, i) => rev(i, 'OPCG', 'スタンダードバトル（11月開催）', 'standard_battle', 13 + (i % 6))),
    ...Array.from({ length: 3 }, (_, i) => rev(30 + i, 'OPCG', '交流会（11月開催）', 'meetup', 14 + i)),
    rev(40, 'OPCG', 'フラッグシップバトル（11月開催）', 'flagship_battle', 15),
    ...Array.from({ length: 4 }, (_, i) => rev(50 + i, 'PTCG', '【26/11】ポケモンカードジム　ジムバトル', 'gym_battle', 16 + i)),
    rev(60, 'CONAN', 'チャレンジ戦【2026年11月】', 'challenge', 18), rev(61, 'OPCG', 'スタンダードバトル（11月開催）', 'standard_battle', 19, { event_status: 'cancelled' })]
    .sort((a, b) => a.starts_at < b.starts_at ? -1 : 1);
  const MARK = /月開催|【26\/11】|【2026年/;
  const until = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 92 * 864e5).toISOString().slice(0, 10);
  for (const [vp, opt] of Object.entries(VIEWPORTS)) {
    const where = `${vp} event rows`;
    const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
      hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    const bad = [];
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    // extra: what /days claims beyond the loaded rows (the home check's columns have more than one page holds)
    let extra = 0, nobg = false;
    await page.route('https://maps.googleapis.com/**', r => r.fulfill({ contentType: 'text/javascript', body: GSTUB }));
    await page.route(EVENTS_API, route => {
      const u = new URL(route.request().url()), g = u.searchParams.get('game');
      const evs = REVS.filter(e => !g || g.split(',').includes(e.game_code));
      const bg = {}; evs.forEach(e => bg[e.game_code] = (bg[e.game_code] || 0) + 1); if (bg.OPCG) bg.OPCG += extra;
      if (u.pathname.endsWith('/events/meta')) return route.fulfill({ json: { games: ['OPCG', 'PTCG', 'CONAN'].map(code => ({ code, record_count: 9, complete: true,
        fetched_at: `${TODAY}T06:00:00+09:00`, window: { from: TODAY, until } })), types: [], prefectures: [{ code: 'JP-13', count: 30 }] } });
      if (u.pathname.endsWith('/events/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: evs.length + extra, ...(nobg ? {} : { by_game: bg }) }] } });
      route.fulfill({ json: { events: u.searchParams.get('from') > TODAY ? [] : evs, next_cursor: null } });
    });
    try {
      const day = `range=custom&from=${TODAY}&to=${TODAY}`;
      await page.goto(`${BASE}/events/?pref=JP-13&${day}&__maps=1`, { waitUntil: 'networkidle' });
      await page.locator('#list .evg').first().waitFor();
      const r = await page.evaluate(() => ({ text: document.getElementById('list').textContent,
        groups: [...document.querySelectorAll('#list .evg')].map(g => [g.querySelector(':scope>.ev-n').textContent, g.querySelector('.evg-tog').getAttribute('aria-expanded'),
          g.querySelector('.evg-l').hidden, g.querySelectorAll('.evg-l .ev').length]),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
      if (MARK.test(r.text)) fail(where, 'month marker left in an event name');
      const want = [['スタンダードバトル — 20店舗', 'false', true, 20], ['交流会 — 3店舗', 'false', true, 3], ['ポケモンカードジム　ジムバトル — 4店舗', 'false', true, 4]];
      if (JSON.stringify(r.groups.map(g => [g[0].replace(/大会$/, ''), g[1], g[2], g[3]]).sort()) !== JSON.stringify(want.sort())) fail(where, `/events/ groups ${JSON.stringify(r.groups)}`);
      if (r.overflow > 1) fail(where, `/events/ scrolls horizontally by ${r.overflow}px`);
      const tog = page.locator('#list .evg .evg-tog').first();
      await tog.click();
      const open = await page.evaluate(() => { const g = document.querySelector('#list .evg'); return [g.querySelector('.evg-tog').getAttribute('aria-expanded'),
        [...g.querySelectorAll('.evg-l .ev')].filter(e => e.getClientRects().length).length, g.querySelectorAll('.evg-l .ev-m .tag, .evg-l .ev-n').length]; });
      if (open[0] !== 'true' || open[1] !== 20 || open[2]) fail(where, `expand: ${JSON.stringify(open)}`);
      if (await tog.getAttribute('aria-expanded') !== 'true') fail(where, 'expanded group closed again on its own');
      await tog.click();
      if (await tog.getAttribute('aria-expanded') !== 'false' || await page.locator('#list .evg-l').first().isVisible()) fail(where, 'collapse failed');
      // snEv on its own: names, grouping, counts, links
      const u = await page.evaluate(T => {
        const N = (name, starts_on = T) => snEv.name({ name, starts_on });
        const E = (id, name, x = {}) => ({ id, name, game_code: 'OPCG', game_codes: ['OPCG'], starts_on: T, time_precision: 'date', timezone: 'Asia/Tokyo',
          attendance_mode: 'in_person', group: { name, category: 'casual', event_type_code: 'meetup' }, source_url: 'https://example.com/', event_status: 'scheduled', ...x });
        const y = T.slice(2, 4), ny = String(+y + 1);
        const txt = h => { const d = document.createElement('div'); d.innerHTML = h; return d; };
        const grpText = (rows, o = {}) => txt(snEv.grp({ key: 'k' + Math.random(), rows }, o)).querySelector('.evg-c').textContent;
        const bad = txt(snEv.row(E('x', '<b>交流会</b>', { source_url: 'javascript:alert(1)' }), {}));
        const badC = txt(snEv.row(E('y', '交流会', { source_url: 'http://example.com/' }), { compact: true }));
        return {
          names: [N('交流会（11月開催）'), N('交流会(12月開催)'), N('チャレンジ戦【2026年11月】'), N(`【${y}/11】ジムバトル`), N(`【${y}/11-12月】教室`), N('【10_11月開催】グランプリ'),
            N('交流会【10/30】'), N('交流会【10/31】'), N(`【${ny}/11】ジムバトル`), N('交流会（13月開催）'), N('（11月開催）'), N('【2026年11月】'),
            N('チャンピオンシップ 11月度 予選'), N('11月度 ジムバトル'), N('11月度王者決定戦')],
          days: snEv.group([E('a', '交流会【10/30】'), E('b', '交流会【10/31】')]).length,
          months: snEv.group([E('a', '交流会（11月開催）'), E('b', '交流会（11月開催）')]).length,
          post: snEv.group([E('a', '交流会'), E('b', '交流会', { event_status: 'postponed' })]).length,
          started: txt(snEv.grp({ key: 's', rows: [E('a', '交流会'), E('b', '交流会')] }, { compact: true, started: true })).textContent.includes('開始済み'),
          stores: [grpText([E('a', 'X', { venue: { name: '店', city: '渋谷区' } }), E('b', 'X', { venue: { name: '店', city: '新宿区' } })]),
            grpText([E('a', 'X', { venue: { name: '店', source_id: '1' } }), E('b', 'X', { venue: { name: '店', source_id: '1' } })]),
            grpText([E('a', 'X', { venue: { name: '店', source_id: '1' } }), E('b', 'X', { venue: { name: '店', source_id: '1' } })], { more: true }),
            grpText([E('a', 'X', { venue: { name: '店', source_id: '1' } }), E('b', 'X', { venue: { name: '店', source_id: '2' } })], { more: true }),
            grpText([E('a', 'X', { venue: { name: '店', city: '渋谷区', source_id: '1' } }), E('b', 'X', { venue: { name: '店', city: '渋谷区' } })]),
            grpText([E('a', 'X', { venue: { name: '店', city: '渋谷区', source_id: '1' } }), E('b', 'X', { venue: { name: '店', city: '新宿区' } })], { more: true }),
            grpText([E('a', 'X', { venue: { name: '店', city: '渋谷区', source_id: '1' } }), E('b', 'X', { venue: { name: '店', city: '渋谷区', source_id: '2' } }), E('c', 'X', { venue: { name: '店', city: '渋谷区' } })])],
          ids: (() => { const id = (key, day = T) => txt(snEv.grp({ key, rows: [E('a', 'X'), E('b', 'X')] }, { day })).querySelector('.evg-tog').getAttribute('aria-controls');
            return [id('0|OPCG|tournament|大会ar') !== id('0|OPCG|tournament|大会c0'), id('0|OPCG|tournament|大会ar') === id('0|OPCG|tournament|大会ar'),
              id('0|OPCG|tournament|大会ar') !== id('0|OPCG|tournament|大会ar', 'other')]; })(),
          labels: [[E('a', 'X', { venue: { name: '店', source_id: '1' } }), E('b', 'X', { venue: { name: '店', source_id: '2' } })], [E('a', 'X', { attendance_mode: 'online' }), E('b', 'X', { attendance_mode: 'online' })]]
            .map(rows => { const b = txt(snEv.grp({ key: 'l' + Math.random(), rows })).querySelector('.evg-tog'); return b.getAttribute('aria-label').startsWith(b.textContent + '（'); }),
          links: [bad.querySelectorAll('a:not(.gl)').length, badC.querySelectorAll('a:not(.gl)').length, !!bad.querySelector('b'), bad.querySelector('.ev-n .t').textContent],
        };
      }, TODAY);
      const wantNames = ['交流会', '交流会', 'チャレンジ戦', 'ジムバトル', '教室', 'グランプリ', '交流会【10/30】', '交流会【10/31】', `【${String(+TODAY.slice(2, 4) + 1)}/11】ジムバトル`,
        '交流会（13月開催）', '（11月開催）', '【2026年11月】', 'チャンピオンシップ 11月度 予選', 'ジムバトル', '11月度王者決定戦'];
      if (JSON.stringify(u.names) !== JSON.stringify(wantNames)) fail(where, `names ${JSON.stringify(u.names)}`);
      if (u.days !== 2 || u.months !== 1) fail(where, `day markers grouped (${u.days}) / month markers not (${u.months})`);
      if (u.post !== 2) fail(where, 'a postponed event joined a group');
      if (!u.started) fail(where, 'a started group does not say 開始済み');
      if (JSON.stringify(u.stores) !== JSON.stringify(['— 2店舗', '— 1店舗・2件', '— 2件以上', '— 2店舗以上', '— 1店舗・2件', '— 2件以上', '— 3件'])) fail(where, `store counts ${JSON.stringify(u.stores)}`);
      if (u.ids.some(x => !x)) fail(where, `group ids collide or drift ${JSON.stringify(u.ids)}`);
      if (u.labels.some(x => !x)) fail(where, 'a group toggle label does not start with its visible text');
      if (JSON.stringify(u.links) !== JSON.stringify([0, 0, false, '<b>交流会</b>'])) fail(where, `unsafe links / markup ${JSON.stringify(u.links)}`);
      const small = await page.evaluate(smallText, '#list .ev, .rhead, .ag h3');
      if (small.length) fail(where, `/events/ text under 12px: ${small.slice(0, 3).join(' | ')}`);
      const names = await page.evaluate(() => [...document.querySelectorAll('#list .ev-n .t')].map(e => parseFloat(getComputedStyle(e).fontSize)));
      if (!names.length || names.some(s => s < 14 || s > 16)) fail(where, `event name sizes ${[...new Set(names)].join(',')}`);
      // a map pick on a store of a collapsed group opens the group and highlights the store
      if (opt.width > 760) {
        await page.locator('#mapv.open #gmap').waitFor();
        const mk = await page.evaluate(() => { const c = document.querySelector('#list .evg .evg-l .ev[data-mk]'); selectVenue(c.dataset.mk, 'map'); return c.dataset.mk; });
        const hl = await page.evaluate(k => { const c = document.querySelector(`#list .evg-l .ev[data-mk="${k}"]`); return [c.classList.contains('hl'), !!c.getClientRects().length]; }, mk);
        if (!hl[0] || !hl[1]) fail(where, `map pick in a group: ${JSON.stringify(hl)}`);
      }
      await page.screenshot({ path: path.join(OUT, `${vp}-events-rows.png`), fullPage: true });
      // one title chosen: its name is not on every row
      await page.goto(`${BASE}/events/?game=OPCG&pref=JP-13&${day}`, { waitUntil: 'networkidle' });
      await page.locator('#list .ev').first().waitFor();
      if (await page.locator('#list .ev-m .tag').count()) fail(where, 'game tag repeated under a one-title filter');
      // calendar cells and chips
      await page.goto(`${BASE}/events/?pref=JP-13`, { waitUntil: 'networkidle' });
      await page.locator(`.cd[data-day="${TODAY}"]`).waitFor();
      const smallCal = await page.evaluate(smallText, '.ecal, #games');
      if (smallCal.length) fail(where, `/events/ calendar text under 12px: ${smallCal.slice(0, 3).join(' | ')}`);

      // home: OPCG has 10 more events today than the page holds: the group count is a minimum, ほか counts the rest
      extra = 10;
      await page.evaluate(() => localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13' })));
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await page.locator('#evBody .gcol').first().waitFor();
      // several games: every row starts closed; its button opens it
      const opTog = page.locator('#evBody .gcol[aria-label="ONE PIECE"] .gt');
      if (await opTog.getAttribute('aria-expanded') !== 'false' || await page.locator('#evBody .gcol[aria-label="ONE PIECE"] .gb').isVisible()) fail(where, 'home: a game row of several starts open');
      await opTog.click();
      if (await opTog.getAttribute('aria-expanded') !== 'true' || !(await page.locator('#evBody .gcol[aria-label="ONE PIECE"] .gb').isVisible())) fail(where, 'home: the game row did not open');
      const h = await page.evaluate(() => { const c = document.querySelector('#evBody .gcol[aria-label="ONE PIECE"]');
        return { text: document.getElementById('evBody').textContent, rows: [...c.querySelectorAll(':scope .evs>.ev')].map(e => e.querySelector(':scope>.ev-n').textContent.replace('（外部サイト）', '')),
          more: c.querySelector('a.go.more')?.textContent, tags: c.querySelectorAll('.ev-m .tag').length,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
      if (MARK.test(h.text)) fail(where, 'home: month marker left in an event name');
      // 24 OPCG rows loaded (one cancelled), 3 shown on 3 columns: the groups, then the flagship battle
      if (h.rows[0] !== 'スタンダードバトル — 20店舗以上' || h.rows[1] !== '交流会 — 3店舗以上') fail(where, `home rows ${JSON.stringify(h.rows)}`);
      if (h.more !== 'ほか 11件 ›') fail(where, `home: more link ${h.more}`);
      if (h.tags) fail(where, 'home: the column game repeated on its rows');
      if (h.overflow > 1) fail(where, `home scrolls horizontally by ${h.overflow}px`);
      const ht = page.locator('#evBody .evg-tog').first();
      await ht.click();
      const ho = await page.evaluate(() => [...document.querySelectorAll('#evBody .evg')[0].querySelectorAll('.evg-l a.ev-venue')].filter(a => a.getClientRects().length).length);
      if (await ht.getAttribute('aria-expanded') !== 'true' || ho !== 20) fail(where, `home expand: ${ho} store links`);
      const hs = await page.evaluate(smallText, '#home');
      if (hs.length) fail(where, `home text under 12px: ${hs.slice(0, 3).join(' | ')}`);
      await page.screenshot({ path: path.join(OUT, `${vp}-home-rows.png`), fullPage: true });
      await ht.click();
      if (await ht.getAttribute('aria-expanded') !== 'false') fail(where, 'home collapse failed');
      const wk = await page.evaluate(() => [...document.querySelectorAll('#wkPanel li a')].filter(a => a.getClientRects().length).map(a => parseFloat(getComputedStyle(a).fontSize)));
      if (wk.some(x => x < 14)) fail(where, `week names under 14px: ${[...new Set(wk)].join(',')}`);
      // /days without by_game: the column counts come from the loaded rows, the day total says more are coming
      nobg = true;
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('#evBody .evg').first().waitFor({ state: 'attached' });
      const nb = await page.evaluate(() => document.querySelector('#evBody .evg .evg-c').textContent);
      if (!nb.endsWith('以上')) fail(where, `home without by_game: group count ${nb}`);
      nobg = false; extra = 0;

      await page.goto(`${BASE}/releases/`, { waitUntil: 'networkidle' });
      const rs = await page.evaluate(smallText, opt.width > 760 ? '.cal .dow, .cal .dn, .cal .pk, #chips, .chips' : '.agenda .ag, .chips');
      if (rs.length) fail(where, `/releases/ text under 12px: ${rs.slice(0, 3).join(' | ')}`);
      const ap = await page.evaluate(() => [...document.querySelectorAll('.ap')].map(e => parseFloat(getComputedStyle(e).fontSize)).filter(x => x < 12));
      if (ap.length) fail(where, `参考画像 label under 12px`);
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    for (const b of [...new Set(bad)]) fail(where, b);
    console.log(`  ${where.padEnd(22)} checked`);
    await ctx.close();
  }
}
// /events/ list at 20:00: 50 started stores of one event on the first page, 10 upcoming on the second (delayed). A group
// opened (and focused) before the last page keeps open and focused when the order switches to upcoming-first.
if (HAS_EVENTS) {
  const where = 'desktop event group paging';
  const mk = i => ({ id: `p${i}`, name: 'スタンダードバトル（11月開催）', game_code: 'OPCG', game_codes: ['OPCG'], starts_on: TODAY, time_precision: 'datetime',
    starts_at: `${TODAY}T${i < 50 ? '10' : '21'}:00:00+09:00`, timezone: 'Asia/Tokyo', attendance_mode: 'in_person', venue: { name: `店 ${i}` },
    group: { name: 'スタンダードバトル', category: 'tournament', event_type_code: 'standard_battle' }, source_url: 'https://example.com/', event_status: 'scheduled' });
  const { ctx, page, bad } = await eventsPage('desktop', 60, mk, 1500);
  try {
    await page.goto(`${BASE}/events/?pref=JP-13&view=list`, { waitUntil: 'load' });
    const tog = page.locator('#list .evg .evg-tog').first();
    await tog.waitFor();
    const before = await page.locator('#list .evg .evg-c').first().textContent();
    await tog.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#list .evg').length === 2, null, { timeout: 15000 });
    const r = await page.evaluate(() => { const gs = [...document.querySelectorAll('#list .evg')], a = document.activeElement;
      return { counts: gs.map(g => g.querySelector('.evg-c').textContent), open: gs.map(g => g.querySelector('.evg-tog').getAttribute('aria-expanded')),
        sep: !!document.querySelector('#list .evsep'), focus: a && a.matches('.evg-tog') ? a.closest('.evg').querySelector('.evg-c').textContent : a && a.tagName }; });
    if (before !== '— 50店舗以上') fail(where, `first page count ${before}`);
    if (JSON.stringify(r.counts) !== JSON.stringify(['— 10店舗', '— 50店舗']) || !r.sep) fail(where, `groups after paging ${JSON.stringify(r)}`);
    if (JSON.stringify(r.open) !== JSON.stringify(['false', 'true'])) fail(where, `open group closed by paging ${JSON.stringify(r.open)}`);
    if (r.focus !== '— 50店舗') fail(where, `focus lost by paging: ${r.focus}`);
  } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
  for (const b of [...new Set(bad)]) fail(where, b);
  console.log(`  ${where.padEnd(22)} checked`);
  await ctx.close();
}
// Focus across a re-render where a row joins a group: on /events/ a focused source link of a page-1 row, on / a focused
// name link; page 2 brings a second store of the same event, so the row moves into a new group: the group opens and the
// row's source link (on / the venue link) keeps focus. On / a shared event has a row in two columns: a re-render keeps
// focus in the column it was in.
if (HAS_EVENTS) {
  const SAME = { name: '交流会（11月開催）', group: { name: '交流会', category: 'casual', event_type_code: 'meetup' } };
  {
    const where = 'desktop event row joins group';
    const mk = i => ({ id: `j${i}`, name: `S${i}`, game_code: 'OPCG', game_codes: ['OPCG'], starts_on: TODAY, time_precision: 'datetime',
      starts_at: `${TODAY}T${i < 50 ? '10' : '21'}:00:00+09:00`, timezone: 'Asia/Tokyo', attendance_mode: 'in_person', venue: { name: `店 ${i}` },
      source_url: 'https://example.com/', event_status: 'scheduled', ...(i === 3 || i === 55 ? { ...SAME, starts_at: `${TODAY}T10:00:00+09:00` } : {}) });
    const { ctx, page, bad } = await eventsPage('desktop', 60, mk, 1500);
    try {
      await page.goto(`${BASE}/events/?pref=JP-13&view=list`, { waitUntil: 'load' });
      const link = page.locator('#list [data-id="j3"] .ev-link');
      await link.waitFor();
      await link.focus();
      await page.waitForFunction(() => !!document.querySelector('#list .evg [data-id="j3"]'), null, { timeout: 15000 });
      await page.waitForTimeout(100);
      const r = await page.evaluate(() => { const a = document.activeElement, g = document.querySelector('#list .evg');
        return { focus: a && a.matches('.ev-link') ? a.closest('[data-id]').dataset.id : a && a.tagName, open: g.querySelector('.evg-tog').getAttribute('aria-expanded'), vis: !!a && !!a.getClientRects().length }; });
      if (r.focus !== 'j3' || r.open !== 'true' || !r.vis) fail(where, `focus after the row joined a group ${JSON.stringify(r)}`);
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    for (const b of [...new Set(bad)]) fail(where, b);
    console.log(`  ${where.padEnd(22)} checked`);
    await ctx.close();
  }
  {
    const where = 'desktop / focus on re-render';
    const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    const bad = [];
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    const ev = (id, codes, hh, x = {}) => ({ id, name: id, game_code: codes[0], game_codes: codes, starts_on: TODAY, time_precision: 'datetime',
      starts_at: `${TODAY}T${hh}:00:00+09:00`, timezone: 'Asia/Tokyo', attendance_mode: 'in_person', venue: { name: `店 ${id}` },
      source_url: 'https://example.com/', event_status: 'scheduled', ...x });
    const p1 = [ev('z', ['OPCG', 'PTCG'], 13), ev('y1', ['OPCG'], 14, SAME), ...Array.from({ length: 48 }, (_, i) => ev(`p${i}`, ['PTCG'], 15 + (i % 5)))];
    await page.route(EVENTS_API, async route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: 51, by_game: { OPCG: 3, PTCG: 49 } }] } });
      if (u.searchParams.get('cursor')) { await new Promise(r => setTimeout(r, 1500)); return route.fulfill({ json: { events: [ev('y2', ['OPCG'], 20, SAME)], next_cursor: null } }); }
      route.fulfill({ json: { events: p1, next_cursor: 'c1' } });
    });
    try {
      await page.goto(`${BASE}/`);
      await page.evaluate(() => localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13' })));
      await page.goto(`${BASE}/`, { waitUntil: 'load' });
      for (const g of ['ONE PIECE', 'ポケモンカード']) await page.locator(`#evBody .gcol[aria-label="${g}"] .gt`).click();
      const nm = page.locator('#evBody .gcol[aria-label="ONE PIECE"] [data-id="y1"] a.ev-n');
      await nm.waitFor();
      await nm.focus();
      await page.waitForFunction(() => !!document.querySelector('#evBody .evg [data-id="y1"]'), null, { timeout: 15000 });
      await page.waitForTimeout(100);
      const r = await page.evaluate(() => { const a = document.activeElement;
        return { focus: a && a.matches('a.ev-venue') ? a.closest('[data-id]').dataset.id : a && a.tagName, open: document.querySelector('#evBody .evg .evg-tog').getAttribute('aria-expanded') }; });
      if (r.focus !== 'y1' || r.open !== 'true') fail(where, `focus after the row joined a group ${JSON.stringify(r)}`);
      // the shared event: focused in the PTCG column, it stays there
      await page.locator('#evBody .gcol[aria-label="ポケモンカード"] [data-id="z"] a.ev-n').focus();
      await page.evaluate(() => document.dispatchEvent(new Event('sn:user')));
      const col = await page.evaluate(() => document.activeElement?.closest('.gcol')?.getAttribute('aria-label'));
      if (col !== 'ポケモンカード') fail(where, `shared event focus moved to ${col}`);
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    for (const b of [...new Set(bad)]) fail(where, b);
    console.log(`  ${where.padEnd(22)} checked`);
    await ctx.close();
  }
}
// Hubs (title pages in hub mode, docs/design/game-hub.md): the game switcher (links with the shown month), 話題 markers
// and the day dialog from /api/v1/voices (the gate fixtures, served locally), いま話題, a failed voices API, /<code>/ redirects;
// both themes, 1366 / 390 screenshots.
{
  const HUBS = PAGES.filter(p => p.js && p.js.hub);
  const latest = VOICE_SNAPS.at(-1);
  // a hub with topics in the latest snapshot, else the first one
  const pick = HUBS.find(h => latest && latest.topics.some(t => t.game === h.js.hub.code)) || HUBS[0];
  const code = pick.js.hub.code;
  const topics = new Map();
  for (const s of VOICE_SNAPS) for (const t of s.topics) if (t.game === code) {
    const x = topics.get(t.id) || { first: t.first_seen, last: s.date, vs: [] }; x.last = s.date; x.vs.push({ snap: s.date, t }); if (t.first_seen < x.first) x.first = t.first_seen; topics.set(t.id, x);
  }
  // a day dialog shows each topic as /voices/ does: the first snapshot on or after that day, else the latest
  const titlesOn = d => [...topics.values()].filter(t => t.first <= d && d <= t.last).map(x => (x.vs.find(v => v.snap >= d) || x.vs.at(-1)).t.title);
  // the bars a week shows, as the hub draws them: topics by first day (longer first), greedy lanes, lanes 4+ only counted
  // per day (list: [{id, first, last}] in the answer's order; weeks: [[first day, last day]])
  const laneBars = (list, weeks) => {
    const bars = [], hid = {};
    for (const [ws, we] of weeks) {
      const segs = list.filter(x => x.first <= we && x.last >= ws).sort((a, b) => a.first.localeCompare(b.first) || b.last.localeCompare(a.last))
        .map(x => ({ id: x.id, s: x.first > ws ? x.first : ws, e: x.last < we ? x.last : we }));
      const end = [];
      for (const sg of segs) {
        let l = end.findIndex(e => e < sg.s); if (l < 0) { l = end.length; end.push(''); } end[l] = sg.e;
        if (l < 4) bars.push([sg.id, sg.s, sg.e]); else for (let k = sg.s; k <= sg.e; k = addDay(k, 1)) hid[k] = (hid[k] || 0) + 1;
      }
    }
    return { bars, hid };
  };
  const onDay = d => [...topics.values()].filter(t => t.first <= d && d <= t.last).length;
  const addDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const nowN = HAS_VOICES && latest && (Date.parse(TODAY) - Date.parse(latest.date)) / 864e5 <= 7 ? latest.topics.filter(t => t.game === code).length : null;
  for (const [vp, opt] of Object.entries({ desktop: { width: 1366, height: 900 }, mobile: VIEWPORTS.mobile })) for (const scheme of ['light', 'dark']) {
    const where = `${vp} ${scheme} hub ${pick.path}`;
    const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
      hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: scheme });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    const bad = [], api = [];
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    page.on('request', r => { if (r.url().startsWith(BASE + '/api/')) api.push(r.url().slice(BASE.length)); });
    try {
      await page.goto(BASE + pick.path, { waitUntil: 'networkidle' });
      const wantApi = [...(HAS_VOICES ? ['/api/v1/voices'] : []), ...(HAS_EVENTS && pick.js.eventsApi ? ['/api/v1/geo'] : [])].sort();
      api.sort();
      if (JSON.stringify(api) !== JSON.stringify(wantApi)) fail(where, `API requests ${JSON.stringify(api)}, expected ${JSON.stringify(wantApi)}`);
      const st = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        month: state.month, cur: !!document.querySelector('.tooltabs a[aria-current]'),
        bars: [...document.querySelectorAll('.tbar')].filter(e => e.offsetParent).map(e => [e.dataset.topic, e.dataset.s, e.dataset.e]),
        rows: [...document.querySelectorAll('#tline .tlr')].filter(e => e.offsetParent).map(e => e.dataset.topic),
        grid: [...document.querySelectorAll('.day button.n')].map(b => b.dataset.openDay),
        sec: document.getElementById('hubTopics') ? { hidden: document.getElementById('hubTopics').hidden, n: document.querySelectorAll('#hubTopics .vt').length,
          xurl: /x\.com|twitter\.com/.test(document.getElementById('hubTopics').innerHTML.replace('X（旧Twitter）', '')) } : null }));
      if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
      if (st.cur) fail(where, 'a tool tab is marked current on a hub');
      // topics as a timeline: desktop one bar per topic and week of the grid (≤ 4 lanes), phones one row per topic of the month
      const want = HAS_VOICES ? days => days.filter(d => onDay(d)) : () => [];
      if (vp === 'desktop') {
        const weeks = Array.from({ length: st.grid.length / 7 }, (_, w) => [st.grid[w * 7], st.grid[w * 7 + 6]]);
        const exp = HAS_VOICES ? laneBars([...topics].map(([id, x]) => ({ id, ...x })), weeks).bars : [];
        const key = a => JSON.stringify([...a].sort());
        if (key(st.bars) !== key(exp)) fail(where, `topic bars ${JSON.stringify(st.bars)}, expected ${JSON.stringify(exp)}`);
      } else {
        const a = `${st.month}-01`, z = addDay(addDay(`${st.month}-28`, 4).slice(0, 7) + '-01', -1);
        const exp = HAS_VOICES ? [...topics].filter(([, x]) => x.first <= z && x.last >= a).sort((p, q) => p[1].first.localeCompare(q[1].first)).map(([id]) => id) : [];
        if (JSON.stringify(st.rows) !== JSON.stringify(exp)) fail(where, `timeline rows ${JSON.stringify(st.rows)}, expected ${JSON.stringify(exp)}`);
      }
      if (HAS_VOICES) {
        if (!st.sec) fail(where, 'いま話題 section missing');
        else if (nowN === null ? !st.sec.hidden : st.sec.hidden || st.sec.n !== Math.min(5, nowN)) fail(where, `いま話題 ${JSON.stringify(st.sec)}, expected ${nowN}`);
        if (st.sec?.xurl) fail(where, 'いま話題 has an X URL');
      } else if (st.sec) fail(where, 'いま話題 without VOICES_ENABLED');
      // day dialog: a topic day opens with its releases and topics
      // day dialog (desktop; phones open topics from the timeline)
      const tday = vp === 'desktop' && want(st.grid)[0];
      if (tday) {
        await page.locator(`.day [data-open-day="${tday}"].n`).click();
        const dl = await page.evaluate(() => ({ open: document.getElementById('dlg').open, tp: document.querySelectorAll('#dlg .dl-tp .tp').length,
          links: [...document.querySelectorAll('#dlg .dl-tp a')].map(a => a.getAttribute('href')), titles: [...document.querySelectorAll('#dlg .dl-tp a')].map(a => a.textContent),
          name: document.getElementById(document.getElementById('dlg').getAttribute('aria-labelledby'))?.textContent }));
        if (!dl.open || dl.tp !== onDay(tday) || dl.links.some(h => !h.startsWith('/voices/#t=')) || JSON.stringify(dl.titles) !== JSON.stringify(titlesOn(tday)) || !dl.name)
          fail(where, `day dialog ${tday}: ${JSON.stringify(dl)}, expected ${JSON.stringify(titlesOn(tday))}`);
        await page.screenshot({ path: path.join(OUT, `hub-${vp}-${scheme}-day.png`) });
        await page.keyboard.press('Escape');
        if (await page.evaluate(() => document.activeElement?.dataset.openDay) !== tday) fail(where, 'focus did not return to the day');
      }
      await page.screenshot({ path: path.join(OUT, `hub-${vp}-${opt.width}-${scheme}.png`), fullPage: true });
      // switcher: every hub as a link, the current one marked; the shown month is carried, also the default one
      const other = HUBS.find(h => h !== pick);
      const m1 = await page.evaluate(() => state.month);
      await page.locator('#gameSw').click();
      await page.locator(`#swList a[href^="${other.path}"]`).click();
      await page.waitForURL(u => u.pathname === other.path);
      if (await page.evaluate(() => state.month) !== m1) fail(where, `switch to ${other.path} at the default month did not keep ${m1}`);
      await page.goto(BASE + pick.path, { waitUntil: 'networkidle' });
      await page.locator('#nextM').click();
      const m2 = await page.evaluate(() => state.month);
      if (new URL(page.url()).search !== `?m=${m2}`) fail(where, `URL ${page.url()} after 次月`);
      await page.locator('#gameSw').click();
      const sw = await page.evaluate(() => ({ open: document.getElementById('swDlg').open, links: [...document.querySelectorAll('#swList a')].map(a => [a.getAttribute('href'), a.getAttribute('aria-current')]) }));
      if (!sw.open || sw.links.length !== HUBS.length || sw.links.some(([h, c]) => !h.endsWith(`/?m=${m2}`) || (c === 'page') !== h.startsWith(pick.path)))
        fail(where, `switcher ${JSON.stringify(sw)}`);
      if (scheme === 'light') await page.screenshot({ path: path.join(OUT, `hub-${vp}-switcher.png`) });
      await page.locator(`#swList a[href^="${other.path}"]`).click();
      await page.waitForURL(u => u.pathname === other.path);
      if (await page.evaluate(() => state.month) !== m2) fail(where, `switch to ${other.path} did not keep ${m2}`);
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    for (const b of [...new Set(bad)]) fail(where, b);
    console.log(`  ${where.padEnd(22)} checked`);
    await ctx.close();
  }
  // a failed voices API leaves the releases and hides every 話題 part
  if (HAS_VOICES) {
    const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const page = await ctx.newPage(), bad = [];
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    await page.route('**/api/v1/voices', r => r.fulfill({ status: 503, body: 'busy' }));
    await page.goto(BASE + pick.path, { waitUntil: 'networkidle' });
    const st = await page.evaluate(() => ({ tmk: document.querySelectorAll('.tbar,.tlr').length, sec: document.getElementById('hubTopics').hidden, cards: document.querySelectorAll('.pk').length }));
    if (st.tmk || !st.sec || !st.cards) fail('hub voices 503', JSON.stringify(st));
    for (const b of bad) fail('hub voices 503', b);
    await ctx.close();
  }
  // per-type event counts (M2): the IP-guessed location, one /events/days per month with the /events/ query, cell and
  // day-dialog counts, picking a location saves it, a failed answer leaves no counts; a game without events asks nothing
  const evHub = HUBS.find(h => h.js.eventsApi);
  if (HAS_EVENTS && evHub) {
    const G = evHub.js.hub.code, T = evHub.js.types, tc = Object.keys(T).filter(c => c !== 'other').slice(0, 3);
    const stubDay = d => { const n = +d.slice(8), bt = { [tc[0]]: n % 5 + 1, ...(n % 3 ? { [tc[1]]: n % 3 } : {}), ...(n % 2 ? {} : { [tc[2]]: 1, other: 2 }) };
      return { date: d, count: 99, by_game: { [G]: Object.values(bt).reduce((a, b) => a + b, 0), OTHER: 5 }, by_game_type: { [G]: bt } }; };
    const short = x => { const named = Object.entries(x.by_game_type[G]).filter(([c]) => T[c] && c !== 'other').map(([c, n]) => [T[c], n]).sort((a, b) => b[1] - a[1]);
      const n = x.by_game[G], rest = n - named.reduce((t, [, k]) => t + k, 0), top = named.length <= 3 && !rest ? named : named.slice(0, 2), r = n - top.reduce((t, [, k]) => t + k, 0);
      return top.map(([l, k]) => `${l}\u00a0${k}`).join('') + (r ? `ほか\u00a0${r}` : ''); };
    const ym = TODAY.slice(0, 7), nx = new Date(Date.parse(`${ym}-28T00:00:00Z`) + 4 * 864e5).toISOString().slice(0, 7);
    const mdays = Array.from({ length: 31 }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`).filter(d => new Date(`${d}T00:00:00Z`).toISOString().startsWith(d));
    for (const [vp, opt] of Object.entries({ desktop: { width: 1366, height: 900 }, mobile: VIEWPORTS.mobile })) for (const scheme of ['light', 'dark']) {
      const where = `${vp} ${scheme} hub events ${evHub.path}`;
      const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
        hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: scheme });
      const page = await ctx.newPage(), bad = [], days = [];
      let fail500 = false;
      await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
      page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
      await page.route('**/api/v1/geo', r => r.fulfill({ json: { region_code: 'JP-13' } }));
      await page.route('**/api/v1/events/days?*', r => { const u = new URL(r.request().url()); days.push(u.pathname + u.search);
        if (fail500) return r.fulfill({ status: 500, body: 'x' });
        r.fulfill({ json: { days: u.searchParams.get('from').startsWith(ym) ? mdays.map(stubDay) : [] } }); });
      try {
        await page.goto(`${BASE}${evHub.path}?m=${ym}`, { waitUntil: 'networkidle' });
        const want = `/api/v1/events/days?from=${ym}-01&until=${nx}-01&game=${G}&pref=JP-13`;
        if (JSON.stringify(days) !== JSON.stringify([want])) fail(where, `events requests ${JSON.stringify(days)}, expected [${want}]`);
        const st = await page.evaluate(() => ({ loc: document.getElementById('locLine').textContent, saved: localStorage.getItem('tcg.ev.filters'),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cells: [...document.querySelectorAll('.day')].filter(e => e.querySelector('.evc') && !e.classList.contains('out')).map(e => [e.querySelector('button.n').dataset.openDay, e.querySelector('.evc').textContent]),
          ag: [...document.querySelectorAll('.ag .evag')].filter(e => e.offsetParent).map(e => [e.dataset.openDay, e.textContent]) }));
        if (!st.loc.includes('東京都（推定）') || st.saved) fail(where, `location line "${st.loc}", saved ${st.saved}`);
        if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
        if (vp === 'desktop') {
          const exp = mdays.map(d => [d, short(stubDay(d))]);
          if (JSON.stringify(st.cells) !== JSON.stringify(exp)) fail(where, `cell counts ${JSON.stringify(st.cells.slice(0, 3))}…, expected ${JSON.stringify(exp.slice(0, 3))}…`);
        } else {
          const exp = mdays.filter(d => d >= TODAY).map(d => [d, `イベント ${stubDay(d).by_game[G]}件 ›`]);
          if (JSON.stringify(st.ag) !== JSON.stringify(exp)) fail(where, `day list counts ${JSON.stringify(st.ag.slice(0, 3))}…, expected ${JSON.stringify(exp.slice(0, 3))}…`);
        }
        await page.screenshot({ path: path.join(OUT, `hub-events-${vp}-${opt.width}-${scheme}.png`), fullPage: true });
        // day dialog: every type with its count and the /events/ day view of this game and location
        await page.locator(vp === 'desktop' ? `.day [data-open-day="${TODAY}"].n` : `.ag [data-open-day="${TODAY}"].agn`).click();
        const dl = await page.evaluate(() => ({ h: document.querySelector('#dlg .dl-ev h3')?.textContent, li: [...document.querySelectorAll('#dlg .dl-ev li')].map(l => l.textContent),
          href: document.querySelector('#dlg .dl-ev a')?.getAttribute('href') }));
        const x = stubDay(TODAY);
        if (dl.h !== `イベント ${x.by_game[G]}件（東京都（推定））` || dl.li.length !== Object.keys(x.by_game_type[G]).filter(c => T[c] && c !== 'other').length + (x.by_game_type[G].other ? 1 : 0)
          || dl.href !== `/events/?game=${G}&pref=JP-13&range=custom&from=${TODAY}&to=${TODAY}`) fail(where, `day dialog ${JSON.stringify(dl)}`);
        if (scheme === 'light') await page.screenshot({ path: path.join(OUT, `hub-events-${vp}-day.png`) });
        await page.keyboard.press('Escape');
        // picking a location saves it and asks for that location
        await page.locator('#hubLoc').click();
        await page.locator('#prefDlg [data-pref="JP-27"]').click();
        await page.waitForLoadState('networkidle');
        if (await page.evaluate(() => document.activeElement?.id) !== 'hubLoc') fail(where, 'focus did not return to the location button after a pick');
        const pk = await page.evaluate(() => ({ loc: document.getElementById('locLine').textContent, saved: JSON.parse(localStorage.getItem('tcg.ev.filters') || '{}').pref }));
        if (pk.saved !== 'JP-27' || !pk.loc.includes('大阪府') || pk.loc.includes('推定') || !days.at(-1).endsWith('&pref=JP-27')) fail(where, `pick: ${JSON.stringify(pk)} ${days.at(-1)}`);
        // a failed answer: no counts, releases stay
        fail500 = true;
        await page.reload({ waitUntil: 'networkidle' });
        const f = await page.evaluate(() => ({ evc: document.querySelectorAll('.evc,.evag').length, cards: document.querySelectorAll('.pk').length }));
        if (f.evc || !f.cards) fail(where, `after a failed answer ${JSON.stringify(f)}`);
      } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
      for (const b of [...new Set(bad)]) fail(where, b);
      console.log(`  ${where.padEnd(22)} checked`);
      await ctx.close();
    }
    // an events hub with nothing upcoming opens on the Tokyo month even when no title has a release in it (fixture: the
    // page's DATA without this month and without the game's later items): that month's /days, no note, 今日 stays there
    {
      const where = `hub events ${evHub.path} nothing upcoming`;
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
      const page = await ctx.newPage(), days = [], bad = [];
      await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
      page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
      await page.route('**/api/v1/geo', r => r.fulfill({ json: { region_code: 'JP-13' } }));
      await page.route('**/api/v1/events/days?*', r => { const u = new URL(r.request().url()); days.push(u.searchParams.get('from')); r.fulfill({ json: { days: [] } }); });
      await page.route(BASE + evHub.path, async r => {
        const html = await (await r.fetch()).text(), game = evHub.js.game;
        const out = html.replace(/const DATA = (\[.*?\]);\n/, (_, j) => `const DATA = ${JSON.stringify(JSON.parse(j).filter(d => !d.date.startsWith(ym) && !(d.game === game && d.date >= ym)))};\n`);
        if (out === html) fail(where, 'DATA not found in the page');
        r.fulfill({ body: out, contentType: 'text/html; charset=utf-8' });
      });
      try {
        await page.goto(BASE + evHub.path, { waitUntil: 'networkidle' });
        const st = await page.evaluate(() => ({ month: state.month, note: !document.getElementById('mnote').hidden, prev: document.getElementById('prev').disabled }));
        if (st.month !== ym || st.note || days[0] !== `${ym}-01`) fail(where, `${JSON.stringify(st)} days ${days.join(' ')}`);
        await page.locator('#nextM').click();
        await page.locator('#goToday').click();
        if (await page.evaluate(() => state.month) !== ym) fail(where, '今日 left the current month');
      } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
      for (const b of [...new Set(bad)]) fail(where, b);
      console.log(`  ${where} checked`);
      await ctx.close();
    }
    // a game without events: no location line, no geo or events request
    const noEv = HUBS.find(h => !h.js.eventsApi);
    if (noEv) {
      const ctx = await browser.newContext({ viewport: VIEWPORTS.mobile, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
      const page = await ctx.newPage(), reqs = [];
      page.on('request', r => { if (/\/api\/v1\/(geo|events)/.test(r.url())) reqs.push(r.url()); });
      await page.goto(BASE + noEv.path, { waitUntil: 'networkidle' });
      if (reqs.length || !(await page.locator('#locLine').isHidden())) fail(`hub ${noEv.path}`, `events parts on a game without events: ${reqs.join(' ')}`);
      await ctx.close();
    }
  }
  // more topics than lanes, crossing a week boundary: 4 bars a week in the right grid columns, the rest counted per day
  if (HAS_VOICES) {
    const where = 'hub lanes';
    const code = pick.js.hub.code, ym = TODAY.slice(0, 7);
    // the first Saturday of the month on or after the 8th: every fixture topic runs Thu..Mon across that week end
    let sat = `${ym}-08`; while (new Date(`${sat}T00:00:00Z`).getUTCDay() !== 6) sat = addDay(sat, 1);
    const fx = Array.from({ length: 6 }, (_, i) => ({ id: `fx-lane-${i}`, game: code, title: `レーン${i}`, summary: 's', attitude: 'neutral', status: 'continuing',
      first_seen: addDay(sat, -2 + (i % 2)), voices: [], share: { positive: 1, negative: 1, neutral: 1 }, volume: 'mid', reacting_to: null, source: 'grok-app' }));
    const last = addDay(sat, 2);
    const snap = { date: last, window: { from: addDay(last, -2), to: last }, topics: fx.map(t => ({ ...t, window: { from: addDay(last, -2), to: last } })) };
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    await page.route('**/api/v1/voices', r => r.fulfill({ json: { version: 'fx', snapshots: [snap] } }));
    await page.goto(`${BASE}${pick.path}?m=${ym}`, { waitUntil: 'networkidle' });
    const got = await page.evaluate(() => {
      const days = [...document.querySelectorAll('.day button.n')].map(b => b.dataset.openDay);
      return { bars: [...document.querySelectorAll('.tbar')].map(a => { const cs = getComputedStyle(a), row = +cs.gridRowStart - 2;
        return [a.dataset.topic, days[row * 7 + +cs.gridColumnStart - 1], days[row * 7 + +cs.gridColumnEnd - 2]]; }),
        more: Object.fromEntries([...document.querySelectorAll('.tmore')].map(b => [b.dataset.openDay, b.textContent])) };
    });
    // expected: per week, topics by first day then longer first, greedy lanes; lanes 4+ only counted
    const { bars: exp, hid } = laneBars(fx.map(t => ({ id: t.id, first: t.first_seen, last })), [[addDay(sat, -6), sat], [addDay(sat, 1), addDay(sat, 7)]]);
    const key = a => JSON.stringify([...a].map(String).sort());
    if (key(got.bars) !== key(exp)) fail(where, `bars ${JSON.stringify(got.bars)}, expected ${JSON.stringify(exp)}`);
    const wantMore = Object.fromEntries(Object.entries(hid).map(([k, n]) => [k, `ほか${n}件の話題`]));
    if (JSON.stringify(Object.entries(got.more).sort()) !== JSON.stringify(Object.entries(wantMore).sort())) fail(where, `hidden ${JSON.stringify(got.more)}, expected ${JSON.stringify(wantMore)}`);
    await page.screenshot({ path: path.join(OUT, 'hub-lanes.png') });
    console.log(`  ${where} checked (${got.bars.length} bars)`);
    await ctx.close();
  }
  // every hub at 1366 / 390 in both themes: no errors or horizontal scroll, one h1, the switcher lists every hub with the
  // current one marked; screenshots of the hubs added after the ten former title pages (M3)
  const FORMER = new Set(['pokemon', 'onepiece', 'mtg', 'yugioh', 'duelmasters', 'weiss', 'unionarena', 'gundam', 'dragonball', 'digimon']);
  for (const [vp, opt] of Object.entries({ desktop: { width: 1366, height: 900 }, mobile: VIEWPORTS.mobile })) for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
      hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: scheme });
    for (const h of HUBS) {
      const where = `${vp} ${scheme} hub ${h.path}`;
      const page = await ctx.newPage(), bad = [];
      await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
      page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
      page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
      try {
        await page.goto(BASE + h.path, { waitUntil: 'networkidle' });
        await page.locator('#gameSw').click();
        const st = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          h1: document.querySelectorAll('h1').length, sw: [...document.querySelectorAll('#swList a')].map(a => [a.getAttribute('href').split('?')[0], a.getAttribute('aria-current')]),
          lp: [...document.querySelectorAll('.lpref a')].filter(a => a.getClientRects().length && a.getBoundingClientRect().right <= document.documentElement.clientWidth + 1).length }));
        // M4: with LANDING_ENABLED an events game's hub has a row of its 48 landing pages, all inside the viewport
        if (st.lp !== (HAS_LANDING && h.js.eventsApi ? 48 : 0)) fail(where, `${st.lp} landing links`);
        if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
        if (st.h1 !== 1) fail(where, `${st.h1} h1`);
        if (JSON.stringify(st.sw.map(x => x[0])) !== JSON.stringify(HUBS.map(x => x.path)) || st.sw.some(([p, c]) => (c === 'page') !== (p === h.path)))
          fail(where, `switcher ${JSON.stringify(st.sw)}`);
        await page.keyboard.press('Escape');
        if (!FORMER.has(h.path.slice(1, -1))) await page.screenshot({ path: path.join(OUT, `hub-${h.path.slice(1, -1)}-${opt.width}-${scheme}.png`), fullPage: true });
      } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
      for (const b of [...new Set(bad)]) fail(where, b);
      await page.close();
    }
    console.log(`  ${vp} ${scheme} hubs`.padEnd(24) + `${HUBS.length} checked`);
    await ctx.close();
  }
  // いま話題 as cards (as on /): a snapshot of today with five topics of the hub's game; >= 3 columns at 1366, one on
  // phones (also at 280px), one link per card named by its title, no game chip, 新 on the new topic, the runtime font,
  // equal heights per row; a snapshot over 7 days old hides the section
  if (HAS_VOICES) {
    const where = 'hub いま話題 cards';
    const st5 = ['new', 'continuing', 'cooling', 'new', 'continuing'];
    const fx = st5.map((status, i) => ({ id: `fx-now-${i}`, game: code, title: `カード${i}の話題（検証用）`, summary: '要約'.repeat(20 + i * 8), attitude: ['positive', 'negative', 'mixed', 'neutral', 'positive'][i],
      status, first_seen: status === 'new' ? TODAY : addDay(TODAY, -3), voices: [], share: { positive: 1, negative: 1, neutral: 1 }, volume: 'mid', reacting_to: null, source: 'grok-app' }));
    let snapDate = TODAY;
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const page = await ctx.newPage(), bad = [];
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    await page.route('**/api/v1/voices', r => r.fulfill({ json: { version: 'fx', snapshots: [{ date: snapDate, window: { from: addDay(snapDate, -2), to: snapDate },
      topics: fx.map(t => ({ ...t, window: { from: addDay(snapDate, -2), to: snapDate } })) }] } }));
    const state = () => page.evaluate(() => {
      const sec = document.getElementById('hubTopics'), lis = [...sec.querySelectorAll('ul.vts > li')], rs = lis.map(li => li.querySelector('a.vt').getBoundingClientRect());
      const rows = Object.values(rs.reduce((m, r) => ((m[Math.round(r.top)] ||= []).push(Math.round(r.height)), m), {})), box = sec.getBoundingClientRect();
      const runtime = getComputedStyle(document.documentElement).getPropertyValue('--runtime').trim();
      return { hidden: sec.hidden, n: lis.length, cols: new Set(rs.map(r => Math.round(r.left))).size, unequal: rows.some(h => Math.max(...h) - Math.min(...h) > 1),
        outside: rs.some(r => r.left < box.left - 0.5 || r.right > box.right + 0.5), chip: sec.querySelectorAll('.gm').length,
        links: lis.map(li => { const a = li.querySelectorAll('a'); return [a.length, a[0]?.getAttribute('href'), (a[0]?.getAttribute('aria-labelledby') || '').split(' ').map(i => document.getElementById(i)?.textContent).join(' '), li.querySelector('.tt')?.textContent]; }),
        fresh: lis.map(li => li.querySelector('.badge.new') ? 'new' : ''), font: lis.every(li => getComputedStyle(li.querySelector('.tt')).fontFamily.replace(/\s/g, '') === runtime.replace(/\s/g, '')),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    const ok = (st, w, min, max) => {
      if (st.hidden || st.n !== 5) fail(where, `${w}px: ${st.n} cards, hidden ${st.hidden}`);
      if (st.cols < min || st.cols > max) fail(where, `${w}px: ${st.cols} columns`);
      // the hub page is laid out for 344px and up (docs/design/game-hub.md › 9); at 280 only the cards are checked
      if (st.unequal || st.outside || (w >= 344 && st.overflow > 1)) fail(where, `${w}px: unequal ${st.unequal} outside ${st.outside} overflow ${st.overflow}`);
      if (st.chip) fail(where, `${w}px: game chip on a one-game hub`);
      if (st.links.some(([n, h, name, t], i) => n !== 1 || h !== `/voices/#t=fx-now-${i}` || name !== t)) fail(where, `${w}px: links ${JSON.stringify(st.links)}`);
      if (JSON.stringify(st.fresh) !== JSON.stringify(st5.map(x => x === 'new' ? 'new' : ''))) fail(where, `${w}px: 新 badges ${st.fresh}`);
      if (!st.font) fail(where, `${w}px: card text not in the runtime font`);
    };
    try {
      await page.goto(BASE + pick.path, { waitUntil: 'networkidle' });
      ok(await state(), 1366, 3, 5);
      for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.locator('#hubTopics').screenshot({ path: path.join(OUT, `hub-topics-1366${scheme === 'dark' ? '-dark' : ''}.png`) }); }
      await page.emulateMedia({ colorScheme: 'light' });
      for (const w of [390, 280]) {
        await page.setViewportSize({ width: w, height: 844 });
        ok(await state(), w, 1, 1);
        if (w === 390) await page.locator('#hubTopics').screenshot({ path: path.join(OUT, 'hub-topics-390.png') });
      }
      snapDate = addDay(TODAY, -8);
      await page.reload({ waitUntil: 'networkidle' });
      if (!(await state()).hidden) fail(where, 'shown for a snapshot over 7 days old');
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    for (const b of [...new Set(bad)]) fail(where, b);
    console.log(`  ${where} checked`);
    await ctx.close();
  }
  // /<code>/ answers 301 to the hub (both cases, with and without the slash)
  for (const h of HUBS) {
    const c = h.js.hub.code;
    if (c.toLowerCase() === h.path.slice(1, -1)) continue;
    for (const v of [`/${c.toLowerCase()}/`, `/${c}`]) {
      const r = await fetch(BASE + v + '?m=2026-12', { redirect: 'manual' });
      if (r.status !== 301 || r.headers.get('location') !== `${h.path}?m=2026-12`) fail(`redirect ${v}`, `${r.status} ${r.headers.get('location')}`);
    }
  }
  console.log(`  hubs checked (${pick.path}, ${topics.size} topics, ${Object.keys(REDIRECTS).length} redirects)`);
}
// game icons (gi() in build.py) next to game names in both themes: every one loaded and at its fixed size
// Footer (every page with the タイトル別 / 月別 rows): both rows inside one closed native <details> 「タイトル別・月別」,
// the links still in the HTML; the ツール row, the site row and the notice stay outside it.
{
  const where = 'footer details';
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.html') ? [path.join(d, e.name)] : []);
  let n = 0;
  for (const f of walk(DIST)) {
    const h = fs.readFileSync(f, 'utf8'), nav = /<nav class="sitenav"[^>]*>(.*?)<\/nav>/s.exec(h);
    if (!nav) continue;
    const rel = path.relative(DIST, f);
    if (/<b>(タイトル別|月別)<\/b>/.test(nav[1])) {
      n++;
      const det = /<details class="sitemore"><summary>タイトル別・月別<\/summary>(.*?)<\/details>/s.exec(nav[1]);
      if (!det || !det[1].includes('<b>タイトル別</b>') || !det[1].includes('<b>月別</b>') || /<b>(タイトル別|月別)<\/b>/.test(nav[1].replace(det[0], ''))) fail(where, `${rel}: タイトル別 / 月別 not folded`);
      else if (!/href="\/\d{4}-\d{2}\/"/.test(det[1])) fail(where, `${rel}: month links missing`);
    }
    if (!nav[1].includes('class="sitenote"') || !nav[1].includes('href="/privacy/"')) fail(where, `${rel}: notice / privacy link missing`);
    if (/<details class="sitemore" open/.test(nav[1])) fail(where, `${rel}: footer details open`);
  }
  if (n < 10) fail(where, `only ${n} pages with the folded rows`);
  console.log(`  ${where.padEnd(22)} ${n} pages`);
}
// / (direction A, owner 2026-11-25): the h1 date with the strip beside it on desktop; the day's releases grouped by title
// (title once, the shared title / series prefix dropped from the names but kept in their accessible names, version /
// vol. numbers kept, prices on the right), events one collapsible row per game (closed when the day has several, open
// when one), zero days without a count; 発売 left, イベント and いま話題 stacked on the right from 901px, one column
// below; no sideways scroll at 1366 / 1024 / 390 / 280 in both themes. Made-up releases replace the build's.
if (HAS_EVENTS) {
  const where = 'home layout A';
  const day = n => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const D2 = day(2);
  const fx = [
    ['DIVINE CROSS', 'DIVINE CROSS スペシャルセット 2026年 夏 りっく☆じあ〜す', '3,300円'], ['DIVINE CROSS', 'DIVINE CROSS スペシャルセット 2026年 夏 刹那にかける恋はなび', '2,200円'],
    ['DIVINE CROSS', 'DIVINE CROSS ワナクリ２', '660円'], ['DIVINE CROSS', 'DIVINE CROSS 七つの大罪 黙示録の四騎士 vol.2', '660円'], ['DIVINE CROSS', 'DIVINE CROSS', '']
  ].map(([game, name, pack], i) => ({ id: `ifxa${i}`, date: TODAY, game, name, pack }))
    .concat([['UNION ARENA', 'UNION ARENA ブースターパック D.Gray-man【UA58BT】', '385円'], ['UNION ARENA', 'UNION ARENA ブースターパック 〈物語〉シリーズ Vol.2【EX18BT】', '385円'],
      ['アニマルカードゲーム', '構築済みトライアルデッキ 「狸の宴」', '2,750円'], ['ポケモンカード', '拡張パック「ハドウシーカー」', '200円'], ['アニマルカードゲーム', '構築済みトライアルデッキ 「狼の夜」', '2,750円']]
      .map(([game, name, pack], i) => ({ id: `ifxb${i}`, date: D2, game, name, pack })));
  const evs = [['a1', 'OPCG', TODAY], ['a2', 'OPCG', TODAY], ['a3', 'PTCG', TODAY], ['a4', 'OPCG', D2]].map(([id, code, d]) => ({ id, name: `テスト大会 ${id}`, game_code: code, game_codes: [code],
    starts_on: d, time_precision: 'datetime', starts_at: `${d}T18:00:00+09:00`, timezone: 'Asia/Tokyo', attendance_mode: 'offline', venue: { name: `店 ${id}` }, source_url: 'https://example.com/', event_status: 'scheduled' }));
  const sameMonth = D2.slice(0, 7) === TODAY.slice(0, 7);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
  const bad = [];
  page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
  await page.route(`${BASE}/`, async route => {
    const r = await route.fetch(), html = await r.text(), m = /const H = (\{.*?\});\n/s.exec(html), H = JSON.parse(m[1]);
    H.items = fx;
    route.fulfill({ response: r, body: html.replace(m[1], JSON.stringify(H).replace(/</g, '\\u003c')) });
  });
  await page.route(EVENTS_API, route => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith('/events/meta')) return route.fulfill({ json: { games: [], types: [], prefectures: [] } });
    if (u.pathname.endsWith('/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: 3, by_game: { OPCG: 2, PTCG: 1 } }].concat(sameMonth ? [{ date: D2, count: 1, by_game: { OPCG: 1 } }] : []) } });
    route.fulfill({ json: { events: evs.filter(e => e.starts_on >= u.searchParams.get('from') && e.starts_on < u.searchParams.get('until')), next_cursor: null } });
  });
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#wkPanel .rg')].map(g => [g.dataset.game, (h => { h.querySelectorAll('.gi').forEach(e => e.remove()); return h.textContent.trim(); })(g.querySelector('h3').cloneNode(true)),
    [...g.querySelectorAll(':scope > .rows > li')].map(li => li.classList.contains('rsg')
      ? { series: li.querySelector('h4').textContent, rows: [...li.querySelectorAll('.pk')].map(p => { const a = p.querySelector('a.n'), c = a.cloneNode(true); c.querySelectorAll('.sr').forEach(e => e.remove()); return [c.textContent, a.textContent]; }) }
      : (p => { const a = p.querySelector('a.n'), c = a.cloneNode(true); c.querySelectorAll('.sr').forEach(e => e.remove()); return [c.textContent, a.textContent]; })(li))]));
  try {
    await page.goto(`${BASE}/`);
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13' })); localStorage.setItem('tcg.stars', JSON.stringify(['ifxb3', 'ifxb1'])); });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('wkStrip').textContent.includes('…') && !document.querySelector('#wkPanel .sk'), null, { timeout: 5000 }).catch(() => {});
    // today: one title; the two スペシャルセット share a subheading, the bare title name stays, vol.2 stays
    const full = (s, x) => `${s} ${x}`;
    const want1 = [['DIVINE CROSS', 'DIVINE CROSS', [{ series: 'スペシャルセット 2026年 夏', rows: [['りっく☆じあ〜す', full('DIVINE CROSS スペシャルセット 2026年 夏', 'りっく☆じあ〜す')], ['刹那にかける恋はなび', full('DIVINE CROSS スペシャルセット 2026年 夏', '刹那にかける恋はなび')]] },
      ['ワナクリ２', 'DIVINE CROSS ワナクリ２'], ['七つの大罪 黙示録の四騎士 vol.2', 'DIVINE CROSS 七つの大罪 黙示録の四騎士 vol.2'], ['DIVINE CROSS', 'DIVINE CROSS']]]];
    const r1 = await rows();
    if (JSON.stringify(r1) !== JSON.stringify(want1)) fail(where, `same-series day ${JSON.stringify(r1)}`);
    const lay = await page.evaluate(() => {
      const R = s => document.querySelector(s)?.getBoundingClientRect(), rel = R('#wkPanel .rel'), evb = R('#wkPanel .evb'), vt = R('#vtr'), h1 = R('.hbar'), strip = R('#wkStrip');
      const prices = [...document.querySelectorAll('#wkPanel .pk')].filter(p => p.querySelector('.pr')).map(p => p.getBoundingClientRect().right - p.querySelector('.pr').getBoundingClientRect().right);
      const tabs = [...document.querySelectorAll('#wkStrip [role="tab"]')].map(t => [t.dataset.rel, t.dataset.ev, !!t.querySelector('.cr:not(.u)'), !!t.querySelector('.ce:not(.u)')]);
      const ops = [...document.querySelectorAll('#evBody .gcol')].map(c => [c.getAttribute('aria-label'), c.querySelector('.gt').getAttribute('aria-expanded'), !c.querySelector('.gb').hidden]);
      return { side: rel && evb && evb.left > rel.right, ratio: rel && evb && rel.width / (rel.width + evb.width), under: !vt || (Math.abs(vt.left - evb.left) < 2 && vt.top > evb.bottom),
        beside: strip.left > h1.right && strip.top < h1.bottom, prices: Math.max(...prices), tabs, ops,
        legend: document.getElementById('wkLg').textContent, foot: (d => d && { open: d.open, tools: !!document.querySelector('.sitenav > div b')?.textContent.includes('ツール'), note: !!document.querySelector('.sitenav .sitenote')?.getClientRects().length })(document.querySelector('.sitenav details.sitemore')) };
    });
    if (!lay.side || !(lay.ratio > 0.55 && lay.ratio < 0.65)) fail(where, `1366: 発売 / イベント not side by side at ~60% (${lay.ratio})`);
    if (!lay.under) fail(where, '1366: いま話題 not under イベント');
    if (!lay.beside) fail(where, '1366: the strip is not beside the date');
    if (!(lay.prices < 12)) fail(where, `prices not right-aligned (${lay.prices}px from the row end)`);
    // zero days: no badge; a count only above 0
    if (lay.tabs.some(([r, e, cr, ce]) => cr !== (+r > 0) || (e !== '' && e !== '–' && ce !== (+e > 0)))) fail(where, `strip badges ${JSON.stringify(lay.tabs)}`);
    if (lay.tabs[1][0] !== '0' || lay.tabs[0][0] !== '5') fail(where, `strip counts ${JSON.stringify(lay.tabs)}`);
    if (lay.legend !== '発売数イベント数（すべて）') fail(where, `legend "${lay.legend}"`);
    if (JSON.stringify(lay.ops) !== JSON.stringify([['ONE PIECE', 'false', false], ['ポケモンカード', 'false', false]])) fail(where, `event rows not closed at first ${JSON.stringify(lay.ops)}`);
    if (!lay.foot || lay.foot.open || !lay.foot.tools || !lay.foot.note) fail(where, `footer ${JSON.stringify(lay.foot)}`);
    // a row opens and closes; it stays open across a re-render
    const tog = page.locator('#evBody .gcol[aria-label="ポケモンカード"] .gt');
    await tog.click();
    if (await tog.getAttribute('aria-expanded') !== 'true' || await page.locator('#evBody .gcol[aria-label="ポケモンカード"] .ev').count() !== 1 || !(await page.locator('#evBody .gcol[aria-label="ポケモンカード"] .ev').isVisible())) fail(where, 'event row did not open');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('sn:prefs')));
    if (await page.locator('#evBody .gcol[aria-label="ポケモンカード"] .gt').getAttribute('aria-expanded') !== 'true') fail(where, 'event row closed by a re-render');
    await page.locator('#evBody .gcol[aria-label="ポケモンカード"] .gt').click();
    if (await page.locator('#evBody .gcol[aria-label="ポケモンカード"] .gb').isVisible()) fail(where, 'event row did not close');
    // a day without releases: 発売 one line across the top with the strip's next release day, いま話題 (wider) left of イベント
    await page.locator('#wkT1').click();
    const e0 = await page.evaluate(() => {
      const R = s => document.querySelector(s)?.getBoundingClientRect(), rel = R('#wkPanel .rel'), evb = R('#wkPanel .evb'), vt = R('#vtr'), hg = R('.hgrid');
      const vtOn = !!vt && !document.getElementById('vtr').hidden;
      return { one: !!document.querySelector('#wkPanel .rel0') && rel.height < 80 && Math.abs(rel.width - hg.width) < 2, nx: document.querySelector('#wkPanel .nx')?.textContent ?? null,
        vtOn, beside: vtOn ? Math.abs(vt.top - evb.top) < 2 && vt.right < evb.left && vt.width > evb.width : Math.abs(evb.width - hg.width) < 2,
        topics: document.querySelectorAll('#vtBody .vt').length };
    });
    const t2 = await page.locator('#wkT2').getAttribute('aria-label');
    const n2 = /発売(\d+)件/.exec(t2)?.[1], md2 = /^(\d+)月(\d+)日\(([^)]+)\)/.exec(t2);
    if (!e0.one || e0.nx !== `次の発売 ${md2[1]}/${md2[2]}(${md2[3]})・${n2}件 ›`) fail(where, `no-release day: 発売 line ${JSON.stringify(e0)} (next ${t2})`);
    if (!e0.beside) fail(where, `no-release day: いま話題 / イベント layout ${JSON.stringify(e0)}`);
    await page.locator('#wkPanel .nx').click();
    if (await page.locator('#wkT2').getAttribute('aria-selected') !== 'true' || await page.evaluate(() => document.activeElement?.id) !== 'wkT2') fail(where, 'no-release day: 次の発売 did not select that day');
    if (await page.locator('#wkPanel .rel0').count() || (e0.vtOn && await page.locator('#vtBody .vt').count() > 5)) fail(where, 'a day with releases kept the no-release layout');
    await page.locator('#wkT0').click();
    // the multi-title day: the favourites (two titles; one of them a series member) grouped first, then the rest;
    // series subheadings per part; Vol.2 kept
    await page.locator('#wkT2').click();
    await page.waitForFunction(() => !document.querySelector('#wkPanel .sk'), null, { timeout: 5000 }).catch(() => {});
    const r2 = await rows();
    const want2 = [['UNION ARENA', 'UNION ARENA', [['ブースターパック 〈物語〉シリーズ Vol.2【EX18BT】', 'UNION ARENA ブースターパック 〈物語〉シリーズ Vol.2【EX18BT】']]],
      ['ポケモンカード', 'ポケモンカード', [['拡張パック「ハドウシーカー」', '拡張パック「ハドウシーカー」']]],
      ['UNION ARENA', 'UNION ARENA', [['ブースターパック D.Gray-man【UA58BT】', 'UNION ARENA ブースターパック D.Gray-man【UA58BT】']]],
      ['アニマルカードゲーム', 'アニマルカードゲーム', [{ series: '構築済みトライアルデッキ', rows: [['「狸の宴」', '構築済みトライアルデッキ 「狸の宴」'], ['「狼の夜」', '構築済みトライアルデッキ 「狼の夜」']] }]]];
    if (JSON.stringify(r2) !== JSON.stringify(want2)) fail(where, `multi-title day ${JSON.stringify(r2)}`);
    const starOrder = await page.evaluate(() => [...document.querySelectorAll('#wkPanel .pk')].map(p => p.classList.contains('on') ? 1 : 0).join(''));
    if (starOrder !== '11000') fail(where, `favourites not all first: ${starOrder}`);
    const dd = await page.evaluate(() => [...document.querySelectorAll('#wkPanel .blk-h .dd')].map(e => e.textContent));
    if (dd.length !== 2 || !dd.every(t => t.startsWith(`${+D2.slice(5, 7)}/${+D2.slice(8)}(`))) fail(where, `other day not named in the headings ${JSON.stringify(dd)}`);
    if (sameMonth) {
      const one = await page.evaluate(() => [...document.querySelectorAll('#evBody .gcol')].map(c => [c.getAttribute('aria-label'), c.querySelector('.gt').getAttribute('aria-expanded')]));
      if (JSON.stringify(one) !== JSON.stringify([['ONE PIECE', 'true']])) fail(where, `a day's one game is not open ${JSON.stringify(one)}`);
    }
    await page.locator('#wkT0').click();
    // widths and themes: no sideways scroll; one column below 901px
    for (const w of [1366, 1024, 390, 280]) {
      await page.setViewportSize({ width: w, height: 900 });
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        const st = await page.evaluate(() => { const rel = document.querySelector('#wkPanel .rel').getBoundingClientRect(), evb = document.querySelector('#wkPanel .evb')?.getBoundingClientRect();
          const h1 = document.querySelector('.hbar').getBoundingClientRect(), strip = document.getElementById('wkStrip').getBoundingClientRect();
          return { ov: document.documentElement.scrollWidth - document.documentElement.clientWidth, stacked: !evb || evb.top >= rel.bottom - 1, beside: strip.left > h1.right && strip.top < h1.bottom }; });
        // the strip sits beside the date from 1024px, under it below
        if ((w >= 1024) !== st.beside) fail(where, `${w}px: the strip is ${st.beside ? 'beside' : 'under'} the date`);
        if (st.ov > 1) fail(where, `${w}px ${scheme}: page scrolls sideways by ${st.ov}px`);
        if ((w <= 900) !== st.stacked) fail(where, `${w}px: ${st.stacked ? 'stacked' : 'two columns'}`);
        await page.screenshot({ path: path.join(OUT, `home-a-${w}${scheme === 'dark' ? '-dark' : ''}.png`), fullPage: true });
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    // without a location: the イベント block is one 地域を設定 button
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.evaluate(() => localStorage.removeItem('tcg.ev.filters'));
    await page.reload({ waitUntil: 'networkidle' });
    if (await page.locator('#evBody').evaluate(e => e.textContent + '|' + e.querySelectorAll('button').length) !== '地域を設定|1') fail(where, 'no location: not one 地域を設定 button');
    await page.screenshot({ path: path.join(OUT, 'home-a-1366-nopref.png'), fullPage: true });
  } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
  for (const b of [...new Set(bad)]) fail(where, b);
  console.log(`  ${where.padEnd(22)} checked`);
  await ctx.close();
}
{
  const GC = ['OPCG', 'UATCG', 'CONAN', 'PTCG'];
  const ev = i => ({ id: `gi${i}`, name: `E${i}`, game_code: GC[i % 4], game_codes: i % 4 ? [GC[i % 4]] : ['OPCG', 'UATCG'], starts_on: TODAY,
    time_precision: 'datetime', starts_at: `${TODAY}T21:00:00+09:00`, timezone: 'Asia/Tokyo', attendance_mode: 'offline',
    venue: { name: `店 ${i}` }, source_url: 'https://example.com/', event_status: 'scheduled' });
  const evs = Array.from({ length: 8 }, (_, i) => ev(i));
  const tmr = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const targets = [['/releases/', '.gi'], ['/', HAS_EVENTS ? '#evBody .gcol h3 .gi' : '.gi']];
  if (HAS_EVENTS) targets.push(['/events/?pref=JP-13&view=list', '#list .ev .gi']);
  // phones show dots on the calendar: the day dialog (latest snapshot) has the chips and cards
  const vday = HAS_VOICES && VOICE_SNAPS.at(-1)?.date;
  if (HAS_VOICES) targets.push(['/voices/', '.gi']);
  for (const [vp, opt] of Object.entries(VIEWPORTS)) for (const scheme of ['light', 'dark']) for (const [p, need] of targets) {
    const where = `${vp} ${scheme} ${p.split('?')[0]} icons`;
    const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
      hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: scheme });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    const bad = [];
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    await page.route(EVENTS_API, route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/events/meta')) return route.fulfill({ json: { games: GC.map(code => ({ code, record_count: 2, complete: true,
        fetched_at: `${TODAY}T06:00:00+09:00` })), types: [], prefectures: [{ code: 'JP-13', count: 8 }] } });
      if (u.pathname.endsWith('/events/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: 8, by_game: { OPCG: 2, UATCG: 2, CONAN: 2, PTCG: 2 } },
        { date: tmr, count: 3, by_game: { OPCG: 1, CONAN: 1, PTCG: 1 } }] } });
      route.fulfill({ json: { events: u.searchParams.get('from') > TODAY ? [] : evs, next_cursor: null } });
    });
    try {
      await page.goto(`${BASE}${p}${p === '/voices/' && vp === 'mobile' && vday ? `#d=${vday}` : ''}`, { waitUntil: 'networkidle' });
      if (p === '/') { await page.evaluate(() => localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13' }))); await page.reload({ waitUntil: 'networkidle' }); }
      // without events the home may show no title at all (no releases today or tomorrow): the 表示の設定 chips have icons
      if (p === '/' && !HAS_EVENTS) await page.locator('#hsBtn').click();
      await page.locator(need).first().waitFor({ state: 'attached', timeout: 5000 });
      const r = await page.evaluate(() => [...document.querySelectorAll('.gi')].filter(e => e.getClientRects().length).map(e => {
        const b = e.getBoundingClientRect(), t = e.tagName !== 'IMG' && e.firstChild && document.createRange();
        if (t) t.selectNodeContents(e); const g = t && t.getBoundingClientRect();
        // monogram glyph centred in its tile (a flex/inline rule from the label must not override the grid)
        const off = g ? Math.max(Math.abs(g.left + g.width / 2 - b.left - b.width / 2), Math.abs(g.top + g.height / 2 - b.top - b.height / 2)) : 0;
        return { disp: getComputedStyle(e).display, off: Math.round(off * 10) / 10, txt: e.textContent, img: e.tagName === 'IMG', src: e.getAttribute('src'), ok: e.tagName !== 'IMG' || (e.complete && e.naturalWidth > 0),
          w: b.width, h: b.height, aria: e.getAttribute('aria-hidden'), alt: e.getAttribute('alt') }; }));
      if (!r.length) fail(where, 'no visible game icons');
      const broken = r.filter(x => !x.ok), size = r.filter(x => x.w < 13 || x.w > 17 || x.h !== x.w), a11y = r.filter(x => x.aria !== 'true' || (x.img && x.alt !== ''));
      if (broken.length) fail(where, `broken icons ${[...new Set(broken.map(x => x.src))].join(' ')}`);
      if (size.length) fail(where, `icon size ${JSON.stringify(size[0])}`);
      if (a11y.length) fail(where, 'icons not decorative (aria-hidden / alt)');
      const off = r.filter(x => !x.img && (x.disp !== 'inline-grid' && x.disp !== 'grid' || x.off > 1.5));
      if (off.length) fail(where, `monogram not centred ${JSON.stringify(off[0])}`);
      await page.screenshot({ path: path.join(OUT, `icons-${vp}-${scheme}-${p.split('?')[0].replace(/\//g, '') || 'home'}.png`), fullPage: true });
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    for (const b of [...new Set(bad)]) fail(where, b);
    console.log(`  ${where.padEnd(22)} checked`);
    await ctx.close();
  }
}
// Game labels link their hub (owner 2026-11-25): every shown game icon + name of a title with a hub is a link to /<slug>/
// (plain on that hub itself and for titles without one); filter / toggle chips stay buttons; no interactive element
// inside another; no sideways scroll at 390.
{
  const REG = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/games.json'), 'utf8'));
  const NAME2SLUG = {};
  for (const g of REG) if (g.hub) for (const n of [g.label, g.short, g.chip, ...g.sources.releases]) if (n) NAME2SLUG[n] = g.slug;
  const ITEMS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/items.json'), 'utf8'));
  const item = ITEMS.find(d => NAME2SLUG[d.game] && fs.existsSync(path.join(DIST, 'item', d.id, 'index.html')));
  const LABELS = '.pk .g > a, .pk .g > span:not(.sm), .rg > h3 > .gn, .tag, .gcol h3 .gn, .vt .gm, .seo-day .sg';
  const audit = page => page.evaluate(([LABELS, MAP]) => {
    const nameOf = el => { const c = el.cloneNode(true); c.querySelectorAll('.gi, [aria-hidden="true"], i, em, b').forEach(e => e.remove()); return c.textContent.trim(); };
    const out = { links: [], wrong: [], nested: document.querySelectorAll('a a, a button, button a, button button').length,
      chipLinks: [...document.querySelectorAll('[aria-pressed]')].filter(e => e.tagName === 'A' || e.querySelector('a') || e.closest('a')).length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    for (const el of document.querySelectorAll(LABELS)) {
      if (!el.getClientRects().length && !el.closest('dialog[open], details')) continue;
      const n = nameOf(el), slug = MAP[n], want = slug && location.pathname !== `/${slug}/` ? `/${slug}/` : null;
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      if (href) out.links.push([n, href]);
      if (href !== want) out.wrong.push([n, el.className, href, want]);
    }
    return out; }, [LABELS, NAME2SLUG]);
  const judge = (where, a, min) => {
    if (a.links.length < min) fail(where, `game links: ${a.links.length} < ${min}`);
    if (a.wrong.length) fail(where, `game labels not linking their hub: ${JSON.stringify(a.wrong.slice(0, 4))}`);
    if (a.nested) fail(where, `${a.nested} interactive elements nested in links / buttons`);
    if (a.chipLinks) fail(where, `${a.chipLinks} filter chips are (or hold) links`);
    if (a.overflow > 0) fail(where, `sideways scroll ${a.overflow}px`);
  };
  const SHARED = (i, codes) => ({ id: `gl${i}`, name: `GL${i}`, game_code: codes[0], game_codes: codes, starts_on: TODAY, time_precision: 'datetime',
    starts_at: `${TODAY}T18:00:00+09:00`, timezone: 'Asia/Tokyo', attendance_mode: 'offline', venue: { name: `店 ${i}` }, source_url: 'https://example.com/', event_status: 'scheduled' });
  const EVS = [SHARED(0, ['OPCG', 'UATCG']), SHARED(1, ['PTCG']), SHARED(2, ['OPCG'])];
  for (const [vp, opt] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
      hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    const bad = [];
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    await page.route(EVENTS_API, route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/events/meta')) return route.fulfill({ json: { games: [], types: [], prefectures: [{ code: 'JP-13', count: EVS.length }] } });
      if (u.pathname.endsWith('/events/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: EVS.length, by_game: { OPCG: 2, UATCG: 1, PTCG: 1 } }] } });
      route.fulfill({ json: { events: u.searchParams.get('from') > TODAY ? [] : EVS, next_cursor: null } });
    });
    const go = async (p, ready) => { await page.goto(BASE + p, { waitUntil: 'load' }); if (ready) await page.waitForSelector(ready, { timeout: 8000 }).catch(() => {}); };
    const run = async (label, fn) => { const where = `${vp} game links ${label}`; try { await fn(where); } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); } };
    await run('/', async where => {
      // made-up releases today (one title with a hub, one without) put in front of the build's, so the cards are always there
      await page.route(`${BASE}/`, async route => {
        const r = await route.fetch(), fx = [{ id: 'iglfx1', date: TODAY, game: 'ONE PIECE', name: 'GL fixture A', pack: '', thumb: '' },
          { id: 'iglfx2', date: TODAY, game: 'GLテスト', name: 'GL fixture B', pack: '', thumb: '' }];
        route.fulfill({ response: r, body: (await r.text()).replace('"items": [', `"items": [${fx.map(x => JSON.stringify(x)).join(',')},`) });
      });
      await go('/');
      await page.evaluate(() => { localStorage.clear(); localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13' })); });
      await go('/', HAS_EVENTS ? '#evBody .gcol' : '#wkPanel .pk');
      if (HAS_VOICES) await page.waitForSelector('#vtBody .vt', { timeout: 5000 }).catch(() => {});
      // today's panel: the stubbed events (columns OPCG / UATCG / PTCG, a shared OPCG + UATCG row; BUILD_EVENTS builds) and the fixture cards
      const a = await audit(page);
      judge(where, a, HAS_EVENTS ? 3 : 1);
      const need = (HAS_EVENTS ? ['/onepiece/', '/unionarena/', '/pokemon/'] : ['/onepiece/']).filter(h => !a.links.some(l => l[1] === h));
      if (need.length) fail(where, `event columns / tags without ${need.join(' ')}`);
      const cards = await page.locator('#wkPanel .pk').evaluateAll(ps => ps.filter(p => /^GL fixture/.test(p.querySelector('.n')?.textContent)).map(p => p.closest('.rg').querySelector('h3 a.gl')?.getAttribute('href') || null));
      if (JSON.stringify(cards) !== JSON.stringify(['/onepiece/', null])) fail(where, `fixture cards' game links ${JSON.stringify(cards)}`);
      if (vp === 'mobile') await page.locator('#wkPanel').screenshot({ path: path.join(OUT, `game-links-home-${vp}.png`) });
      // the 表示中 pill is one button (it opens 表示の設定): its saved titles are plain names, no links inside
      // (MTG is offered only with いま話題; without it the /events/ filter holds the titles; a BUILD_EVENTS=0 build offers none)
      if (!HAS_EVENTS) { await page.unroute(`${BASE}/`); return; }
      const [saved, want] = HAS_VOICES ? [['tcg.voices', { game: 'OPCG,MTG' }], 'ワンピ・MTG'] : [['tcg.ev.filters', { pref: 'JP-13', game: 'OPCG,PTCG' }], 'ワンピ・ポケカ'];
      await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), saved);
      await go('/', '#hsT');
      judge(where + ' 表示中', await audit(page), 1);
      const hs = await page.evaluate(() => ({ tag: document.getElementById('hsT').closest('button')?.id, text: document.getElementById('hsT').textContent, links: document.querySelectorAll('#hsBtn a').length }));
      if (hs.tag !== 'hsBtn' || hs.text !== want || hs.links) fail(where, `表示中 pill ${JSON.stringify(hs)} (want ${want})`);
      await page.unroute(`${BASE}/`);
    });
    await run('/releases/', async where => {
      await go('/releases/');
      await page.evaluate(() => { localStorage.clear(); localStorage.setItem('tcg.view', '"cal"'); });
      await go('/releases/', '.pk');
      judge(where, await audit(page), 0);
      // the rest needs a shown card of a title with a hub (the labels above are checked whatever the data)
      if (!(await page.locator('.pk:has(a.gl) .pko').filter({ visible: true }).count())) return;
      // the card opens its dialog (game link left out), the dialog's label links too
      await page.locator('.pk:has(a.gl) .pko').filter({ visible: true }).first().click();
      await page.waitForSelector('#dlg[open] .dl-head', { timeout: 5000 });
      judge(where + ' dialog', await audit(page), 1);
      if (!(await page.locator('#dlg[open] .dl-head a.gl').count())) fail(where, 'detail dialog: game label not a link');
      await page.keyboard.press('Escape');
      if (vp === 'desktop') {
        const card = page.locator('.cal .pkw').filter({ has: page.locator('a.gl') }).first(), lk = card.locator('a.gl');
        await lk.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
        await card.screenshot({ path: path.join(OUT, `game-links-card-focus-${vp}.png`) });
        await page.keyboard.press('Tab');
        if (!(await card.locator('.pko').evaluate(b => b === document.activeElement))) fail(where, 'Tab from the game link does not reach the card');
        await card.screenshot({ path: path.join(OUT, `game-links-card-focus2-${vp}.png`) });
        const href = await lk.getAttribute('href');
        await lk.click();
        await page.waitForURL(u => new URL(u).pathname === href, { timeout: 5000 });
        if (await page.locator('#dlg[open]').count()) fail(where, 'game link opened the detail dialog');
      }
      await page.evaluate(() => localStorage.setItem('tcg.view', '"tbl"'));
      await go('/releases/', 'td.gm');
      judge(where + ' table', await audit(page), 1);
    });
    await run('/events/', async where => {
      if (!HAS_EVENTS) return;
      await go('/events/?pref=JP-13&view=list', '#list .ev');
      const a = await audit(page);
      judge(where, a, 3);
      if (!a.links.some(l => l[1] === '/unionarena/')) fail(where, 'shared event without its UNION ARENA link');
      // a re-render (auto-paging) keeps focus on the same row's game link
      const kept = await page.evaluate(() => { const l = document.getElementById('list'), g = l.querySelector('.ev a.gl[href="/unionarena/"]'); if (!g) return 'no link';
        const id = g.closest('[data-id]')?.dataset.id; g.focus(); const k = snEv.keep(l); l.innerHTML = l.innerHTML; snEv.restore(l, k);
        const f = document.activeElement; return f !== g && f.matches('a.gl[href="/unionarena/"]') && f.closest('[data-id]')?.dataset.id === id ? 'ok' : `lost (${f.tagName}.${f.className})`; });
      if (kept !== 'ok') fail(where, `focused game link after re-render: ${kept}`);
      if (await page.locator('button.chip.g').count() < 3) fail(where, 'title filter chips missing');
    });
    await run('/voices/', async where => {
      if (!HAS_VOICES) return;
      await go('/voices/?view=list', '.tc .tag');
      judge(where, await audit(page), 1);
    });
    await run('hub /onepiece/', async where => {
      await go('/onepiece/', '.pk');
      const a = await audit(page);
      judge(where, a, 0);
      if (await page.locator('a.gl[href="/onepiece/"]').count()) fail(where, 'the hub links itself');
    });
    if (item) await run('item', async where => {
      await go(`/item/${item.id}/`);
      const a = await audit(page);
      judge(where, a, 1);
      if (vp === 'mobile') await page.locator('.pd-card').screenshot({ path: path.join(OUT, `game-links-item-${vp}.png`) });
    });
    for (const b of [...new Set(bad)]) fail(`${vp} game links`, b);
    console.log(`  ${`${vp} game links`.padEnd(22)} checked`);
    await ctx.close();
  }
}

await browser.close();
server.close();
for (const f of fails) console.log('FAIL', f);
console.log('RESULT', fails.length ? 'FAIL' : 'PASS', `(${fails.length} fail) screenshots: ${OUT}`);
process.exit(fails.length ? 1 : 0);
