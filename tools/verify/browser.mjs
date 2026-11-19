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
  let scenario = 'plain';
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
await browser.close();
server.close();
for (const f of fails) console.log('FAIL', f);
console.log('RESULT', fails.length ? 'FAIL' : 'PASS', `(${fails.length} fail) screenshots: ${OUT}`);
process.exit(fails.length ? 1 : 0);
