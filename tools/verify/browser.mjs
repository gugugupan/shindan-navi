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
// the official posts the voices snapshots react to: the only X links /voices/ may show
const OFFICIAL_X = new Set(fs.existsSync(path.join(ROOT, 'data/voices')) ? fs.readdirSync(path.join(ROOT, 'data/voices')).filter(f => f.endsWith('.json'))
  .flatMap(f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data/voices', f), 'utf8')).topics.map(t => t.reacting_to).filter(Boolean)) : []);
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
// /voices/ and the home page's いま話題 block: VOICES_ENABLED=1 builds only
const HAS_VOICES = fs.existsSync(path.join(DIST, 'voices/index.html'));
// VOICES_SOURCE=d1 builds read the snapshots from the Worker: tools/verify/voices-d1.mjs checks them
if (HAS_VOICES && fs.readFileSync(path.join(DIST, 'voices/index.html'), 'utf8').includes('const V = {"snapshots": null')) {
  console.error('browser.mjs: dist/ is a VOICES_SOURCE=d1 build; this script checks static builds (use tools/verify/voices-d1.mjs)');
  process.exit(2);
}
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
// Logo row: the tool tabs follow the logo on desktop (settings / user at the right end), a bottom bar on phones.
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
  if (h.t.left < h.brand.right || h.t.left - h.brand.right > 24) return `tool tabs not right after the logo (${Math.round(h.t.left - h.brand.right)}px)`;
  if (h.t.right > h.corner.left) return 'tool tabs overlap the corner';
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
    // a title page with nothing this month opens on the title's next month with releases (else its latest) and says so
    const cur = `${wy}-${wm}`, gm = st.gm;
    const open = gm.length && !gm.includes(cur) ? gm.find(x => x > cur) || gm.at(-1) : cur;
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
  await page.route('**/api/v1/**', route => {
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
  const st = await page.evaluate(() => ({ date: document.getElementById('hDate').textContent, cards: document.querySelectorAll('#relBody a.pk').length,
    none: !!document.querySelector('#relBody .none'), days: document.querySelectorAll('#wkBody .wd').length,
    prompt: !!document.querySelector('#evBody .none button#pickLoc'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
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
      cols: document.querySelectorAll('#evBody .gcol').length, types: document.querySelectorAll('#evBody .ty').length, where: document.getElementById('evWhere').textContent }));
    if (ev.cols !== 1 || ev.rows !== 5) fail(where, `today's events show ${ev.cols} columns / ${ev.rows} rows`);
    // /days without by_game_type (answers cached before it existed): no type line
    if (ev.types) fail(where, `${ev.types} type lines without by_game_type`);
    if (ev.more !== `/events/?game=OPCG&pref=JP-13&range=custom&from=${TODAY}&to=${TODAY}`) fail(where, `day view link ${ev.more}`);
    if (!ev.where.startsWith('東京都')) fail(where, `location ${ev.where}`);

    // the location picker (shared with /events/): the choice goes into the saved filters, the rest of them kept
    api.length = 0;
    await page.locator('#locBtn').click();
    await page.locator('#prefDlg[open] [data-pref="JP-27"]').waitFor();
    // counts from meta.loc_counts for the saved game filter (OPCG): Tokyo 3 + 4, Osaka's row is PTCG only
    await page.waitForFunction(() => document.querySelector('#prefDlg [data-pref="JP-13"] em')?.textContent === '7');
    if (await page.locator('#prefDlg [data-pref="JP-27"] em').textContent() !== '0') fail(where, 'picker counts ignore the game filter');
    await page.locator('#prefDlg [data-pref="JP-27"]').click();
    await page.waitForFunction(() => document.getElementById('evWhere').textContent.startsWith('大阪府') && document.querySelector('#evBody .gcol'));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tcg.ev.filters')));
    if (saved.pref !== 'JP-27' || saved.game !== 'OPCG' || saved.days !== 'weekend') fail(where, `picker saved ${JSON.stringify(saved)}`);
    const want2 = ['/api/v1/events/meta', `/api/v1/events/days?from=${ym}-01&until=${next}&game=OPCG&pref=JP-27`, `/api/v1/events?from=${TODAY}&until=${next}&game=OPCG&pref=JP-27&limit=50`];
    if (JSON.stringify([...api].sort()) !== JSON.stringify(want2.sort())) fail(where, `API requests after the picker ${api.join(' ')}`);
    if (await page.locator('#prefDlg').evaluate(d => d.open)) fail(where, 'picker still open');

    // all games, one busy: per-game columns from /days by_game, one cursor page for the game the first page missed
    scenario = 'busy'; api.length = 0;
    await page.evaluate(() => localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13' })));
    await page.reload({ waitUntil: 'networkidle' });
    const busy = await page.evaluate(() => ({ cols: [...document.querySelectorAll('#evBody .gcol')].map(c => [c.getAttribute('aria-label'), c.querySelectorAll('.ev').length,
      c.querySelector('a.go')?.textContent]), chips: [...document.querySelectorAll('#wkBody .wd')][0].querySelectorAll('a.gc').length,
      types: [...document.querySelectorAll('#evBody .gcol')].map(c => c.querySelector('.ty')?.textContent || null),
      tyLine: (() => { const t = document.querySelector('#evBody .gcol .ty'); return t ? { nowrap: getComputedStyle(t).whiteSpace === 'nowrap', h: t.getBoundingClientRect().height } : null; })(),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    if (JSON.stringify(busy.cols) !== JSON.stringify([['ONE PIECE', 5, 'ほか 45件 ›'], ['ポケモンカード', 3, '地図で見る ›']])) fail(where, `busy columns ${JSON.stringify(busy.cols)}`);
    if (api.length !== 3 || !api.some(a => a.includes('cursor=c1'))) fail(where, `busy: API requests ${api.join(' ')}`);
    if (busy.chips !== 2) fail(where, `tomorrow shows ${busy.chips} game chips`);
    if (JSON.stringify(busy.types) !== JSON.stringify(['スタンダードバトル 30件・フラッグシップバトル 12件・ほか 8件', 'ジムバトル 2件・シティリーグ 1件'])) fail(where, `busy: type lines ${JSON.stringify(busy.types)}`);
    if (opt.width <= 760 && !(busy.tyLine && busy.tyLine.nowrap && busy.tyLine.h < 24)) fail(where, `busy: type line not one line on phones ${JSON.stringify(busy.tyLine)}`);
    if (busy.overflow > 1) fail(where, `busy: page scrolls horizontally by ${busy.overflow}px`);
    await page.screenshot({ path: path.join(OUT, `${vp}-home-busy.png`), fullPage: true });

    scenario = 'many'; api.length = 0;
    await page.reload({ waitUntil: 'networkidle' });
    const many = await page.evaluate(() => ({ cols: [...document.querySelectorAll('#evBody .gcol')].map(c => c.getAttribute('aria-label')),
      types: document.querySelectorAll('#evBody .ty').length,
      rest: [...document.querySelectorAll('#evBody .gmore a.gc')].map(a => [a.textContent, a.getAttribute('href')]),
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

  // deep links into the release calendar
  if (todays.length) {
    await page.goto(`${BASE}/releases/#d=${TODAY}`, { waitUntil: 'load' });
    const dlg = await page.evaluate(() => ({ open: document.getElementById('dlg').open, n: document.querySelectorAll('#dlgBody .dl-item').length, hash: location.hash }));
    if (!dlg.open || dlg.n !== todays.length || dlg.hash) fail(`${vp} /releases/#d=`, `dialog ${JSON.stringify(dlg)}`);
  }
  console.log(`  ${where.padEnd(22)} today=${todays.length} events=${hasEvents} api=${api.length}`);
  await ctx.close();
}
// / いま話題 (VOICES_ENABLED=1 builds only): the latest snapshot's topics, at most 5 rows and 2 per game unless one game
// is shown; read only: games from the /voices/ saved filter (tcg.voices), else the /events/ one, kept to games with
// topics, else all; nothing written. Hidden once the snapshot is more than 7 days old. No API calls without a location.
for (const [vp, opt] of HAS_VOICES ? Object.entries(VIEWPORTS) : []) {
  const where = `${vp} / いま話題`;
  const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
    hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
  const bad = [], api = [];
  page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
  page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
  page.on('request', r => { if (r.url().includes('/api/')) api.push(r.url()); });
  const state = () => page.evaluate(() => {
    const sec = document.getElementById('vtr');
    return { shown: !!sec && !sec.hidden && sec.offsetParent !== null, label: sec && document.getElementById(sec.getAttribute('aria-labelledby'))?.textContent,
      sub: document.getElementById('vtSub')?.textContent, buttons: sec ? sec.querySelectorAll('button').length : 0,
      rows: [...document.querySelectorAll('#vtBody a.vt')].map(a => a.getAttribute('href').replace('/voices/#t=', '')),
      asof: document.getElementById('vtAsOf')?.textContent, saved: [localStorage.getItem('tcg.voices'), localStorage.getItem('tcg.ev.filters')],
      oneLine: (() => { const s = document.querySelector('#vtBody .sm'); return s ? getComputedStyle(s).whiteSpace === 'nowrap' : null; })(),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  const setStore = o => page.evaluate(o => { localStorage.clear(); for (const [k, v] of Object.entries(o)) localStorage.setItem(k, JSON.stringify(v)); }, o);
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    const HV = await page.evaluate(() => JSON.parse(/const H = (\{.*?\});\n/s.exec(document.documentElement.innerHTML)[1]).voices);
    if (!HV) throw new Error('no embedded voices data');
    const byId = Object.fromEntries(HV.topics.map(t => [t.id, t]));
    const short = Object.fromEntries(HV.games.map(g => [g.code, g.short || g.name]));
    const W = { high: 3, mid: 2, low: 1 };
    const order = ids => ids.every((id, i) => !i || W[byId[ids[i - 1]].volume] > W[byId[id].volume] || (W[byId[ids[i - 1]].volume] === W[byId[id].volume] && byId[ids[i - 1]].first_seen >= byId[id].first_seen));
    const perGame = ids => Math.max(0, ...Object.values(ids.reduce((m, id) => (m[byId[id].game] = (m[byId[id].game] || 0) + 1, m), {})));
    const allOk = st => st.sub === 'すべてのタイトル' && st.rows.length === Math.min(5, HV.topics.length) && perGame(st.rows) <= 2 && order(st.rows);
    // nothing saved: top topics across all games, no controls
    let st = await state();
    const [, mm, dd] = HV.date.split('-').map(Number);
    if (!st.shown || st.label !== 'いま話題') fail(where, `block not shown (${st.label})`);
    if (st.buttons) fail(where, `${st.buttons} buttons in the read-only block`);
    if (!allOk(st)) fail(where, `all games: sub "${st.sub}" rows ${st.rows.join(' ')}`);
    if (st.asof !== `${mm}/${dd} 時点・AI要約`) fail(where, `footer ${st.asof}`);
    if (opt.width <= 760 && st.oneLine !== true) fail(where, 'summary is not one line on phones');
    if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px`);
    await page.locator('#vtr').screenshot({ path: path.join(OUT, `${vp}-home-voices.png`) });
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
    if (st.sub !== `${short[one.code]} の話題` || st.rows.length !== Math.min(5, n1) || st.rows.some(id => byId[id].game !== one.code) || !order(st.rows)) fail(where, `one game: sub "${st.sub}" rows ${st.rows.join(' ')}`);
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
    const href = await page.locator('#vtBody a.vt').first().getAttribute('href');
    await page.locator('#vtBody a.vt').first().click();
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
  if (api.length) fail(where, `API called: ${api.join(' ')}`);
  for (const b of [...new Set(bad)]) fail(where, b);
  console.log(`  ${where.padEnd(22)} checked`);
  await ctx.close();
}
// / 明日・今週の予定 follows the saved titles (tcg.voices with VOICES builds, else /events/' game filter; read only):
// releases and event chips of those titles, a すべて表示 toggle for the visit, and every title with a note when the
// chosen ones have nothing this week. Same 2 API requests as without the filter.
for (const [vp, opt] of Object.entries(VIEWPORTS)) {
  const where = `${vp} / week filter`;
  const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
    hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
  const bad = [], api = [];
  page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
  page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
  page.on('request', r => { if (r.url().includes('/api/')) api.push(r.url()); });
  // tomorrow: OPCG 2 + PTCG 1 events, the day after: PTCG 4; the saved game filter applies as on the API
  const WEEK2 = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 2 * 864e5).toISOString().slice(0, 10);
  await page.route('**/api/v1/**', route => {
    const u = new URL(route.request().url()), gf = (u.searchParams.get('game') || '').split(',').filter(Boolean);
    if (!u.pathname.endsWith('/days')) return route.fulfill({ json: { events: [], next_cursor: null } });
    const days = [[WEEK1, { OPCG: 2, PTCG: 1 }], [WEEK2, { PTCG: 4 }]].map(([date, bg]) => {
      const by_game = Object.fromEntries(Object.entries(bg).filter(([g]) => !gf.length || gf.includes(g)));
      return { date, count: Object.values(by_game).reduce((a, b) => a + b, 0), by_game };
    }).filter(d => d.count);
    route.fulfill({ json: { days } });
  });
  const setStore = o => page.evaluate(o => { localStorage.clear(); for (const [k, v] of Object.entries(o)) localStorage.setItem(k, JSON.stringify(v)); }, o);
  const state = () => page.evaluate(() => {
    const f = document.getElementById('wkF');
    return { shown: !f.hidden, text: f.textContent, btn: f.querySelector('button')?.textContent || null, controls: f.querySelector('button')?.getAttribute('aria-controls') || null,
      rels: [...document.querySelectorAll('#wkBody a[href^="/releases/#i="]')].map(a => a.getAttribute('title').split(' / ')[0]),
      chips: [...document.querySelectorAll('#wkBody a.gc:not(.any)')].map(a => a.getAttribute('title').split('・')[0]),
      others: [...document.querySelectorAll('#wkBody .rl')].filter(a => a.textContent.includes('ほか')).length,
      days: [...document.querySelectorAll('#wkBody .wd')].map(w => ({ q: w.querySelector('.q')?.textContent || null,
        rl: [...w.querySelectorAll('.rl')].map(a => [a.textContent, a.getAttribute('href')]), any: [...w.querySelectorAll('a.gc.any')].map(a => a.getAttribute('href')) })),
      saved: [localStorage.getItem('tcg.voices'), localStorage.getItem('tcg.ev.filters')],
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    const H = await page.evaluate(() => JSON.parse(/const H = (\{.*?\});\n/s.exec(document.documentElement.innerHTML)[1]));
    if (!H.titles || !H.titles.OPCG) throw new Error('no embedded title map');
    const week = Array.from({ length: 6 }, (_, i) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + (i + 1) * 864e5).toISOString().slice(0, 10));
    const inWeek = H.items.filter(x => week.includes(x.date) && x.date >= H.from && x.date <= H.until);
    const shown = games => week.reduce((n, d) => n + Math.min(3, inWeek.filter(x => x.date === d && (!games || games.includes(x.game))).length), 0);
    const EVC = ['OPCG', 'UATCG', 'CONAN', 'PTCG', 'GCG', 'DBFW', 'BS', 'DCG'];
    // a title with releases this week (an /events/ game, so the /events/ filter can hold it too)
    const code = EVC.find(c => inWeek.some(x => x.game === H.titles[c]));
    // a title with nothing this week: no releases, no stubbed events
    const none = EVC.find(c => c !== 'OPCG' && c !== 'PTCG' && !inWeek.some(x => x.game === H.titles[c]));
    const short = c => ({ OPCG: 'ワンピ', UATCG: 'ユニアリ', CONAN: 'コナン', PTCG: 'ポケカ', GCG: 'ガンダム', DBFW: 'フュージョンワールド', BS: 'バトスピ', DCG: 'デジカ' })[c];
    // nothing saved: every title, no sub-line
    await setStore({ 'tcg.ev.filters': { pref: 'JP-13' } });
    await page.reload({ waitUntil: 'networkidle' });
    let st = await state();
    const all = st.rels.length;
    if (st.shown) fail(where, `sub-line without a selection: ${st.text}`);
    if (all !== shown(null)) fail(where, `all titles: ${all} releases listed, data has ${shown(null)}`);
    if (HAS_EVENTS && JSON.stringify(st.chips) !== JSON.stringify(['ONE PIECE', 'ポケモンカード', 'ポケモンカード'])) fail(where, `all titles: chips ${st.chips}`);
    if (!code) console.log(`  ${where.padEnd(22)} no /events/ title with releases this week: filter checks skipped`);
    else {
      const name = H.titles[code];
      const dayRange = d => `range=custom&from=${d}&to=${d}`;
      const filtered = async (label, evGame) => {
        st = await state();
        if (!st.shown || st.text !== `選択中のタイトルのみ（${short(code)}）すべて表示` || st.btn !== 'すべて表示' || st.controls !== 'wkBody') fail(where, `${label}: sub-line "${st.text}" ${st.controls}`);
        if (st.rels.length !== shown([name]) || st.rels.some(g => g !== name)) fail(where, `${label}: releases ${st.rels}`);
        if (HAS_EVENTS && JSON.stringify(st.chips) !== JSON.stringify(code === 'OPCG' ? ['ONE PIECE'] : code === 'PTCG' ? ['ポケモンカード', 'ポケモンカード'] : [])) fail(where, `${label}: chips ${st.chips}`);
        // the day after tomorrow: nothing of the chosen title, only other titles' events (when /events/' filter lets them through)
        if (HAS_EVENTS && code !== 'PTCG' && !inWeek.some(x => x.date === WEEK2 && x.game === name)) {
          const d2 = st.days[1], others = evGame.includes('PTCG') ? 4 : 0;
          const want = others ? [[`ほかのタイトルのイベント ${others}件 ›`, `/events/?game=${evGame}&pref=JP-13&${dayRange(WEEK2)}`]] : [];
          if (d2.q !== '選択中のタイトルの予定なし' || JSON.stringify(d2.rl.filter(r => r[0].includes('イベント'))) !== JSON.stringify(want)) fail(where, `${label}: ${WEEK2} ${JSON.stringify(d2)}`);
        }
        if (inWeek.some(x => x.game !== name) && !st.others) fail(where, `${label}: other titles' releases not mentioned`);
        if (st.overflow > 1) fail(where, `${label}: page scrolls horizontally by ${st.overflow}px`);
      };
      // from /events/' saved game filter
      const evf = { pref: 'JP-13', game: code };
      await setStore({ 'tcg.ev.filters': evf });
      await page.reload({ waitUntil: 'networkidle' });
      await filtered('from /events/', code);
      // tcg.voices wins over /events/ (VOICES builds); /events/' game left out of it here
      if (HAS_VOICES) {
        const evGame = code === 'PTCG' ? 'OPCG,PTCG' : `${code},PTCG`;
        await setStore({ 'tcg.voices': { game: code }, 'tcg.ev.filters': { pref: 'JP-13', game: evGame } });
        await page.reload({ waitUntil: 'networkidle' });
        await filtered('from /voices/', evGame);
      }
      await page.locator('#wkF').screenshot({ path: path.join(OUT, `${vp}-home-week-sub.png`) });
      await page.locator('section:has(#wkH)').screenshot({ path: path.join(OUT, `${vp}-home-week-filtered.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.locator('section:has(#wkH)').screenshot({ path: path.join(OUT, `${vp}-home-week-filtered-dark.png`) });
      await page.emulateMedia({ colorScheme: 'light' });
      // すべて表示: every title for this visit, nothing saved; and back
      const before = (await state()).saved;
      await page.locator('#wkAll').click();
      st = await state();
      if (st.rels.length !== all || st.btn !== '選択中のタイトルのみ' || !st.text.startsWith('すべてのタイトルを表示中')) fail(where, `すべて表示: ${st.rels.length} releases, "${st.text}"`);
      if (await page.evaluate(() => document.activeElement?.id) !== 'wkAll') fail(where, 'focus lost after すべて表示');
      if (JSON.stringify(st.saved) !== JSON.stringify(before)) fail(where, `storage written: ${st.saved}`);
      await page.locator('#wkAll').click();
      st = await state();
      if (st.rels.length !== shown([name]) || st.btn !== 'すべて表示') fail(where, `back to the selection: ${st.rels.length} releases, "${st.text}"`);
      await page.reload({ waitUntil: 'networkidle' });
      if ((await state()).btn !== 'すべて表示') fail(where, 'すべて表示 kept after a reload');
    }
    // the chosen titles have nothing this week: every title, with a note and no toggle
    if (none) {
      await setStore({ 'tcg.ev.filters': { pref: 'JP-13', game: none } });
      await page.reload({ waitUntil: 'networkidle' });
      st = await state();
      if (!st.shown || st.text !== `選択中のタイトル（${short(none)}）の予定はありません。すべてのタイトルを表示しています。` || st.btn) fail(where, `empty after the filter: "${st.text}"`);
      if (st.rels.length !== all) fail(where, `empty after the filter: ${st.rels.length} releases, want ${all}`);
      if (st.saved[1] !== JSON.stringify({ pref: 'JP-13', game: none })) fail(where, `storage written: ${st.saved}`);
      await page.locator('section:has(#wkH)').screenshot({ path: path.join(OUT, `${vp}-home-week-empty.png`) });
    }
    // next month's days (no counts): one chosen /events/ game opens its day view, two keep the saved filter
    const end = new Date(Date.UTC(+TODAY.slice(0, 4), +TODAY.slice(5, 7), 0)).toISOString().slice(0, 10);
    const next = Array.from({ length: 6 }, (_, i) => new Date(Date.parse(`${end}T00:00:00Z`) + (i + 1) * 864e5).toISOString().slice(0, 10));
    const code2 = EVC.find(c => H.items.some(x => next.includes(x.date) && x.date <= H.until && x.game === H.titles[c]));
    if (HAS_EVENTS && HAS_VOICES && code2) {
      const p2 = await ctx.newPage();
      await p2.clock.setFixedTime(new Date(`${end}T12:00:00+09:00`));
      await p2.route('**/api/v1/**', r => r.fulfill({ json: { days: [], events: [], next_cursor: null } }));
      for (const [g, want] of [[code2, `game=${code2}&`], [[code2, code2 === 'PTCG' ? 'OPCG' : 'PTCG'].join(','), null]]) {
        await p2.goto(`${BASE}/`, { waitUntil: 'load' });
        await p2.evaluate(g => { localStorage.clear(); localStorage.setItem('tcg.voices', JSON.stringify({ game: g })); localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13' })); }, g);
        await p2.reload({ waitUntil: 'networkidle' });
        const links = await p2.evaluate(() => [...document.querySelectorAll('#wkBody a.gc.any')].map(a => a.getAttribute('href')));
        if (!links.length || links.some(h => want ? !h.startsWith(`/events/?${want}pref=JP-13&range=custom`) : h.includes('game='))) fail(where, `next month, ${g}: ${links.join(' ')}`);
      }
      await p2.close();
      // the clock is the context's: p2 moved page to the month's end too
      await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    }
    // no location, selection only: releases filtered, no API call
    if (code) {
      api.length = 0;
      await setStore({ 'tcg.ev.filters': { game: code } });
      await page.reload({ waitUntil: 'networkidle' });
      st = await state();
      if (st.rels.some(g => g !== H.titles[code]) || !st.shown) fail(where, `no location: releases ${st.rels}`);
      if (api.length) fail(where, `API called without a location: ${api.join(' ')}`);
    }
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
  await page.route('**/api/v1/**', route => {
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
// /voices/ (VOICES_ENABLED=1 builds only): the embedded snapshots on the calendar (a chip per game on desktop, bars when
// one game is selected, a dot per game on phones) on the right days, the day, game and topic dialogs, the list view,
// the filters and safe X links; shares that add up to 100%, one freshness line per snapshot, the dialog in the URL hash
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
  const expect = filter => page.evaluate(f => {
    const tp = new Map();
    [...V.snapshots].sort((a, b) => a.date < b.date ? -1 : 1).forEach(s => s.topics.forEach(t => {
      const x = tp.get(t.id) || { id: t.id, game: t.game, first: t.first_seen, att: t.attitude }; x.last = s.date; x.att = t.attitude;
      if (t.first_seen < x.first) x.first = t.first_seen; tp.set(t.id, x); }));
    const out = {};
    for (const x of tp.values()) {
      if (f.att && x.att !== f.att) continue;
      for (let d = x.first; d <= x.last; d = new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10)) (out[d] ||= []).push(x);
    }
    return out;
  }, filter || {});
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
    const fr = await page.evaluate(() => {
      const last = {}; [...V.snapshots].sort((a, b) => a.date < b.date ? -1 : 1).forEach(s => s.topics.forEach(t => last[t.game] = s.date));
      const n = {}; Object.values(last).forEach(d => n[d] = (n[d] || 0) + 1);
      return { want: 1 + Object.values(last).length - Math.max(...Object.values(n)), got: document.querySelectorAll('#fresh .frl>span:not(.lab):not(.smp)').length };
    });
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
    const li = await page.evaluate(() => ({ heads: [...document.querySelectorAll('#list .vsnap')].map(s => s.getAttribute('aria-labelledby').slice(2)),
      cards: document.querySelectorAll('#list .tc').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      want: [...V.snapshots].filter(s => s.topics.length).map(s => s.date).sort().reverse(), n: V.snapshots.reduce((t, s) => t + s.topics.length, 0) }));
    if (JSON.stringify(li.heads) !== JSON.stringify(li.want) || li.cards !== li.n) fail(where, `list ${JSON.stringify(li)}`);
    if (li.overflow > 1) fail(where, `list scrolls horizontally by ${li.overflow}px`);
    // shares in 10% steps adding up to 100% on every card; 🆕 only once an older snapshot exists
    // (cards on fewer than 5 posts: no bar, no percentages, a tendency phrase)
    const sh = await page.evaluate(() => [...document.querySelectorAll('#list .tc .att:not([data-small]) .alg')].map(a => [...a.children].reduce((t, x) => t + (+(/約(\d+)%/.exec(x.textContent) || [0, 0])[1]), 0)));
    if (sh.some(n => n !== 100)) fail(where, `share labels add up to ${[...new Set(sh.filter(n => n !== 100))].join('/')}%`);
    const sm = await page.evaluate(() => [...document.querySelectorAll('#list .vsnap')].flatMap(sec => {
      const snap = V.snapshots.find(x => x.date === sec.getAttribute('aria-labelledby').slice(2));
      return [...sec.querySelectorAll('.tc')].map(tc => { const t = snap.topics.find(x => x.id === tc.dataset.topic), n = t.share.positive + t.share.negative + t.share.neutral;
        const small = !!tc.querySelector('.att[data-small]'), pct = /\d+%/.test(tc.querySelector('.att').textContent) || !!tc.querySelector('.abar');
        return (n < 5) !== small || (small && pct) ? `${t.id} n=${n} small=${small} pct=${pct}` : ''; }).filter(Boolean); }));
    if (sm.length) fail(where, `small-sample cards: ${sm.slice(0, 3).join(', ')}`);
    if (await page.evaluate(() => V.snapshots.length === 1 && document.querySelectorAll('.badge.new').length)) fail(where, '🆕 shown with a single snapshot');
    await page.screenshot({ path: path.join(OUT, `${vp}-voices-list.png`), fullPage: true });
    // deep links: a real day opens its dialog, an impossible date is ignored
    for (const [i, [h, open]] of [[`#d=${d0}`, true], ['#d=2026-02-31', false], ['#d=2026-13-01', false]].entries()) {
      await page.goto(`${BASE}/voices/?view=list&r=${i}${h}`, { waitUntil: 'networkidle' });
      if (await page.locator('#vDlg').evaluate(d => d.open) !== open) fail(where, `deep link ${h}: dialog ${open ? 'not opened' : 'opened'}`);
      if (await page.evaluate(() => location.hash) !== (open ? h : '')) fail(where, `deep link ${h}: hash ${await page.evaluate(() => location.hash)}`);
    }
    await page.goto(`${BASE}/voices/#t=${t0}`, { waitUntil: 'networkidle' });
    if (await page.locator('#vBody .tc').count() !== 1 || await page.locator('#vBody .tc').getAttribute('data-topic') !== t0) fail(where, `copied link #t=${t0} did not open its topic`);
    if (api.length) fail(where, `API requests from a static page: ${api.join(' ')}`);
  } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
  for (const b of [...new Set(bad)]) fail(where, b);
  console.log(`  ${where.padEnd(22)} checked`);
  await ctx.close();
}
// /voices/<date>/ archive pages (one per real snapshot): static cards like /voices/ (shares adding up to 100%, the
// small-sample rule), nofollow X links, no script errors or API calls, no horizontal scroll; the /voices/ latest list
// points at cards that exist; the 🔗 to /voices/#t= opens that topic there.
const VOICE_DAYS = HAS_VOICES ? fs.readdirSync(path.join(DIST, 'voices')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
for (const [vp, opt] of VOICE_DAYS.length ? Object.entries(VIEWPORTS) : []) {
  const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
    hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  for (const d of VOICE_DAYS) {
    const where = `${vp} /voices/${d}/`;
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    const bad = [], api = [];
    page.on('console', m => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    page.on('request', r => { if (r.url().includes('/api/')) api.push(r.url()); });
    page.on('response', r => { if (r.url().startsWith(BASE) && r.status() >= 400) bad.push(`HTTP ${r.status()}: ${r.url().slice(BASE.length)}`); });
    try {
      const res = await page.goto(`${BASE}/voices/${d}/`, { waitUntil: 'networkidle' });
      if (!res || res.status() !== 200) fail(where, `status ${res && res.status()}`);
      const hdr = await headerProblem(page, opt.width);
      if (hdr) fail(where, hdr);
      const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/voices', `${d}.json`), 'utf8'));
      const st = await page.evaluate(() => ({
        cards: [...document.querySelectorAll('article.tc')].map(e => e.dataset.topic),
        visible: [...document.querySelectorAll('article.tc')].filter(e => e.offsetParent).length,
        h1: [...document.querySelectorAll('h1')].map(h => h.textContent),
        links: [...document.querySelectorAll('a[data-x]')].map(a => [a.href, a.target, a.rel]),
        xa: [...document.querySelectorAll('a')].filter(a => /^https?:\/\/(www\.)?(x|twitter)\.com\//.test(a.href)).map(a => [a.href, a.dataset.x, a.textContent]),
        players: document.body.textContent.includes('関連する投稿'),
        shares: [...document.querySelectorAll('.tc .att:not([data-small]) .alg')].map(a => [...a.children].reduce((t, x) => t + (+(/約(\d+)%/.exec(x.textContent) || [0, 0])[1]), 0)),
        smallPct: [...document.querySelectorAll('.tc .att[data-small]')].filter(a => /\d+%/.test(a.textContent) || a.querySelector('.abar')).length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        wide: [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(e => e.className || e.tagName).slice(0, 3),
        scripts: [...document.scripts].filter(s => !s.type || s.type === 'text/javascript').length,
        tags: [...new Set([...document.querySelectorAll('.tc .tag')].map(e => e.innerHTML))],
        icons: [...document.querySelectorAll('.tc .tag .gi, .vtoc .gi, .vgsec h2 .gi')].filter(e => !e.getBoundingClientRect().width).length }));
      if (st.icons) fail(where, `${st.icons} game icons not rendered`);
      if (st.cards.length !== snap.topics.length || st.visible !== st.cards.length) fail(where, `${st.cards.length} cards (${st.visible} visible), expected ${snap.topics.length}`);
      if (st.h1.length !== 1 || !st.h1[0].includes('のTCG話題まとめ')) fail(where, `h1 ${JSON.stringify(st.h1)}`);
      if (st.links.some(([h, t, r]) => !/^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/.test(h) || t !== '_blank' || !/nofollow/.test(r) || !/noopener/.test(r))) fail(where, `unsafe X links ${JSON.stringify(st.links.slice(0, 2))}`);
      const ownX = new Set(snap.topics.map(t => t.reacting_to).filter(Boolean));
      if (st.players || st.xa.some(([h, k, txt]) => k !== 'reacting' || !txt.startsWith('反応元の公式投稿') || !ownX.has(h))) fail(where, `links players' posts ${JSON.stringify(st.xa.slice(0, 2))}`);
      if (st.shares.some(n => n !== 100)) fail(where, `share labels add up to ${[...new Set(st.shares.filter(n => n !== 100))].join('/')}%`);
      if (st.smallPct) fail(where, `${st.smallPct} small-sample cards show percentages`);
      if (st.overflow > 1) fail(where, `page scrolls horizontally by ${st.overflow}px (${st.wide.join(', ')})`);
      if (api.length) fail(where, `API requests ${api.join(' ')}`);
      await page.screenshot({ path: path.join(OUT, `${vp}-voices-${d}.png`), fullPage: true });
      // a title chip jumps to its game section; a card's カレンダーで見る opens the topic on /voices/
      const toc = page.locator('.vtoc a').nth(1);
      if (await toc.count()) { const h = await toc.getAttribute('href'); await toc.click(); if (await page.evaluate(() => location.hash) !== h) fail(where, `toc ${h}`); }
      const first = st.cards[0];
      await page.locator(`#topic-${first} a.vopen`).click();
      await page.waitForURL(u => u.pathname === '/voices/');
      await page.locator('#vDlg[open]').waitFor();
      if (await page.locator('#vBody .tc').getAttribute('data-topic') !== first) fail(where, `カレンダーで見る did not open ${first}`);
      // card tags as the /voices/ card() draws them: gi(name) + name
      const jsTags = await page.evaluate(() => GAMES.map(g => { const e = document.createElement('span'); e.innerHTML = `${gi(g.name)}${esc(g.name)}`; return e.innerHTML; }));
      const odd = st.tags.filter(t => !jsTags.includes(t));
      if (odd.length) fail(where, `card tags differ from /voices/ card(): ${odd[0]}`);
      // /voices/: the latest list links cards on the latest archive page, the list view links each archive page
      if (d === VOICE_DAYS.at(-1)) {
        const rows = await page.evaluate(() => [...document.querySelectorAll('.vlatest li a')].map(a => a.getAttribute('href')));
        const want = st.cards.map(id => `/voices/${d}/#topic-${id}`);
        if (JSON.stringify([...rows].sort()) !== JSON.stringify([...want].sort())) fail(where, `/voices/ latest list ${rows.length} rows, expected ${want.length}`);
        if (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) > 1) fail(where, '/voices/ with the latest list scrolls horizontally');
        await page.goto(`${BASE}/voices/?view=list`, { waitUntil: 'networkidle' });
        const sl = await page.evaluate(() => [...document.querySelectorAll('#list .vsl')].map(a => a.getAttribute('href')));
        if (JSON.stringify(sl) !== JSON.stringify(VOICE_DAYS.map(x => `/voices/${x}/`).reverse())) fail(where, `list view archive links ${JSON.stringify(sl)}`);
      }
    } catch (e) { fail(where, `interaction: ${e.message.split('\n')[0]}`); }
    for (const b of [...new Set(bad)]) fail(where, b);
    console.log(`  ${where.padEnd(22)} checked`);
    await page.close();
  }
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
  await page.route('**/api/v1/**', async route => {
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
    await page.route('**/api/v1/**', route => {
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
          links: [bad.querySelectorAll('a').length, badC.querySelectorAll('a').length, !!bad.querySelector('b'), bad.querySelector('.ev-n .t').textContent],
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
      const hs = await page.evaluate(smallText, '#evBody, #wkBody');
      if (hs.length) fail(where, `home text under 12px: ${hs.slice(0, 3).join(' | ')}`);
      await page.screenshot({ path: path.join(OUT, `${vp}-home-rows.png`), fullPage: true });
      await ht.click();
      if (await ht.getAttribute('aria-expanded') !== 'false') fail(where, 'home collapse failed');
      const wk = await page.evaluate(() => [...document.querySelectorAll('#wkBody li a')].filter(a => a.getClientRects().length).map(a => parseFloat(getComputedStyle(a).fontSize)));
      if (wk.some(x => x < 14)) fail(where, `week names under 14px: ${[...new Set(wk)].join(',')}`);
      // /days without by_game: the column counts come from the loaded rows, the day total says more are coming
      nobg = true;
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('#evBody .evg').first().waitFor();
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
    await page.route('**/api/v1/**', async route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: 51, by_game: { OPCG: 3, PTCG: 49 } }] } });
      if (u.searchParams.get('cursor')) { await new Promise(r => setTimeout(r, 1500)); return route.fulfill({ json: { events: [ev('y2', ['OPCG'], 20, SAME)], next_cursor: null } }); }
      route.fulfill({ json: { events: p1, next_cursor: 'c1' } });
    });
    try {
      await page.goto(`${BASE}/`);
      await page.evaluate(() => localStorage.setItem('tcg.ev.filters', JSON.stringify({ pref: 'JP-13' })));
      await page.goto(`${BASE}/`, { waitUntil: 'load' });
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
// game icons (gi() in build.py) next to game names in both themes: every one loaded and at its fixed size
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
  const vday = HAS_VOICES && fs.readdirSync(path.join(ROOT, 'data/voices')).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort().pop()?.slice(0, 10);
  if (HAS_VOICES) targets.push(['/voices/', '.gi']);
  for (const [vp, opt] of Object.entries(VIEWPORTS)) for (const scheme of ['light', 'dark']) for (const [p, need] of targets) {
    const where = `${vp} ${scheme} ${p.split('?')[0]} icons`;
    const ctx = await browser.newContext({ viewport: { width: opt.width, height: opt.height }, isMobile: !!opt.isMobile,
      hasTouch: !!opt.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: scheme });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
    const bad = [];
    page.on('pageerror', e => bad.push(`pageerror: ${e.message}`));
    await page.route('**/api/v1/**', route => {
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
      await page.locator(need).first().waitFor({ state: 'attached', timeout: 5000 });
      if (p === '/' && HAS_EVENTS && !await page.locator('#wkBody a.gc .gi').count()) fail(where, 'no icons in the week event chips');
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
await browser.close();
server.close();
for (const f of fails) console.log('FAIL', f);
console.log('RESULT', fails.length ? 'FAIL' : 'PASS', `(${fails.length} fail) screenshots: ${OUT}`);
process.exit(fails.length ? 1 : 0);
