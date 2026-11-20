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
  // scenario 'busy': 50 OPCG events fill the first page; PTCG's 3 come only on the cursor page.
  // scenario 'many': seven games today; the five busiest get columns, the other two chips.
  let scenario = 'plain';
  const MANY = { GCG: 9, OPCG: 8, PTCG: 7, DCG: 6, BS: 5, UATCG: 2, DBFW: 1 };
  const evt = (i, code, hh, day = TODAY) => ({ id: `${code}${i}`, name: `テスト大会 ${code} ${i + 1}`, game_code: code, game_codes: [code],
    starts_on: day, time_precision: 'datetime', starts_at: `${day}T${String(hh).padStart(2, '0')}:00:00+09:00`, timezone: 'Asia/Tokyo',
    attendance_mode: 'offline', venue: { name: `テスト店 ${i + 1}` }, source_url: 'https://example.com/', event_status: 'scheduled' });
  await page.route('**/api/v1/**', route => {
    const u = new URL(route.request().url());
    api.push(u.pathname + u.search);
    if (u.pathname.endsWith('/events/meta')) return route.fulfill({ json: { games: [], types: [],
      loc_counts: { months: [TODAY.slice(0, 7)], types: ['x'], rows: { 'JP-13': [1, 0, 0, 3, 4], 'JP-27': [8, 0, 0, 1, 1] } } } });
    if (scenario === 'busy') {
      if (u.pathname.endsWith('/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: 53, by_game: { OPCG: 50, PTCG: 3 } },
        { date: WEEK1, count: 4, by_game: { UATCG: 1, CONAN: 3 } }] } });
      return route.fulfill({ json: u.searchParams.get('cursor') ? { events: [0, 1, 2].map(i => evt(i, 'PTCG', 20)), next_cursor: null }
        : { events: Array.from({ length: 50 }, (_, i) => evt(i, 'OPCG', 10 + (i % 9))), next_cursor: 'c1' } });
    }
    if (scenario === 'many') {
      if (u.pathname.endsWith('/days')) return route.fulfill({ json: { days: [{ date: TODAY, count: 38, by_game: MANY }] } });
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
      cols: document.querySelectorAll('#evBody .gcol').length, where: document.getElementById('evWhere').textContent }));
    if (ev.cols !== 1 || ev.rows !== 5) fail(where, `today's events show ${ev.cols} columns / ${ev.rows} rows`);
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
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    if (JSON.stringify(busy.cols) !== JSON.stringify([['ONE PIECE', 5, 'ほか 45件 ›'], ['ポケモンカード', 3, '地図で見る ›']])) fail(where, `busy columns ${JSON.stringify(busy.cols)}`);
    if (api.length !== 3 || !api.some(a => a.includes('cursor=c1'))) fail(where, `busy: API requests ${api.join(' ')}`);
    if (busy.chips !== 2) fail(where, `tomorrow shows ${busy.chips} game chips`);
    if (busy.overflow > 1) fail(where, `busy: page scrolls horizontally by ${busy.overflow}px`);
    await page.screenshot({ path: path.join(OUT, `${vp}-home-busy.png`), fullPage: true });

    scenario = 'many'; api.length = 0;
    await page.reload({ waitUntil: 'networkidle' });
    const many = await page.evaluate(() => ({ cols: [...document.querySelectorAll('#evBody .gcol')].map(c => c.getAttribute('aria-label')),
      rest: [...document.querySelectorAll('#evBody .gmore a.gc')].map(a => [a.textContent, a.getAttribute('href')]),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    if (JSON.stringify(many.cols) !== JSON.stringify(['ONE PIECE', 'ポケモンカード', 'ガンダム', 'バトルスピリッツ', 'デジモン'])) fail(where, `many: columns ${JSON.stringify(many.cols)}`);
    if (JSON.stringify(many.rest) !== JSON.stringify([['UNION ARENA2', `/events/?game=UATCG&pref=JP-13&range=custom&from=${TODAY}&to=${TODAY}`],
      ['DBフュージョンワールド1', `/events/?game=DBFW&pref=JP-13&range=custom&from=${TODAY}&to=${TODAY}`]])) fail(where, `many: other titles ${JSON.stringify(many.rest)}`);
    if (api.length !== 2) fail(where, `many: API requests ${api.join(' ')}`);
    if (many.overflow > 1) fail(where, `many: page scrolls horizontally by ${many.overflow}px`);
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
    await page.locator(`.cd[data-day="${TODAY}"]`).click();
    await page.locator('#list .ev').first().waitFor();
    const order = await page.evaluate(() => [...document.querySelectorAll(`#list .list > *`)].map(e => e.classList.contains('evsep') ? '|' : e.querySelector('h4').textContent.replace('テスト大会 ', '')));
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
    // game filter: one game's chip leaves only its topics
    const g = await page.locator('#games .chip.g').first().getAttribute('data-v');
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
