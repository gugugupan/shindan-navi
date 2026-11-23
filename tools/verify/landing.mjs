// Event landing pages /events/<slug>/<pref>/ against the real build, importer and Worker code
// (docs/design/event-landing.md). Two passes over api/scripts/dev-node.mjs with a throwaway SQLite database:
//   off: dist/ as built now (flag off) and LANDING_ENABLED unset: the paths are the static 404, robots.txt and the
//        build have no trace of the pages;
//   on:  rebuilds dist/ with LANDING_ENABLED=1 (and VOICES_ENABLED=1 as production), imports events with migration
//        0007 applied, serves with LANDING_ENABLED=1, checks pages, noindex rules, JSON-LD and the sitemap over HTTP,
//        then drives one page in headless Chrome at desktop and mobile widths. dist/ is rebuilt without the flag after.
//
//   node tools/verify/landing.mjs --today YYYY-MM-DD [--data DIR] [--out .verify]   # needs api/node_modules, .venv
//
// Without --data the events are SYNTHETIC (generated here); --data takes a data/events-style copy (never committed).
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'api');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TODAY = arg('--today', new Date().toISOString().slice(0, 10));
const OUT = path.resolve(ROOT, arg('--out', '.verify'));
const DATA = arg('--data', null);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(arg('--port', '8798'));
const BASE = `http://localhost:${PORT}`;
const { loadAll, planImport } = await import(path.join(API, 'scripts/lib/importer.mjs'));
const { SqliteD1 } = await import(path.join(API, 'scripts/lib/sqlite-d1.mjs'));

const fails = [];
const fail = (where, msg) => fails.push(`${where}: ${msg}`);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
fs.mkdirSync(OUT, { recursive: true });

function build(env) {
  const r = spawnSync(path.join(ROOT, '.venv/bin/python'), ['-I', 'scripts/build.py'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, BUILD_TODAY: TODAY, VOICES_ENABLED: '1', LANDING_ENABLED: '', ...env },
  });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  console.log(`landing: build ${r.stdout.trim().split('\n').pop()}`);
}

/** SYNTHETIC events in the data/events layout: OPCG and PTCG, dense in Tokyo, some groups, online and cancelled ones. */
function syntheticDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-data-'));
  const window = { from: TODAY, until: addDays(TODAY, 60) };
  for (const [game, source, prefix] of [['OPCG', 'bandai_tcg_plus', 'tcgp'], ['PTCG', 'pokemon_players', 'ptcg']]) {
    const evs = [];
    for (let k = 0; k < 400; k++) {
      const day = addDays(TODAY, k % 40);
      const pref = k % 7 === 0 ? ['JP-27', '大阪府'] : ['JP-13', '東京都'];
      const online = k % 23 === 0;
      const ext = `syn${game}${k}`;
      const timed = k % 4 !== 0;
      evs.push({
        id: `${prefix}:${ext}`, game_code: game, source_code: source, external_id: ext, source_url: `https://example.invalid/synthetic/${ext}`,
        group: { source_id: null, name: '【SYNTHETIC】group', category: ['tournament', 'casual', 'teaching'][k % 3], event_type_code: k % 3 ? 'standard_battle' : 'meetup' },
        name: k % 3 ? '【SYNTHETIC】スタンダードバトル（11月開催）' : `【SYNTHETIC】交流会 ${k}`,
        attendance_mode: online ? 'online' : 'in_person',
        venue: online ? null : { name: `【SYNTHETIC】shop ${k % 9}`, source_id: `v${k % 9}`, country_code: 'JP', region_code: pref[0], region_name: pref[1], city: '【SYNTHETIC】市', address: `【SYNTHETIC】address ${k % 9}`, postal_code: null },
        starts_on: day, ends_on: null, starts_at: timed ? `${day}T${10 + (k % 8)}:00:00+09:00` : null, ends_at: null, timezone: 'Asia/Tokyo',
        time_precision: timed ? 'datetime' : 'date', format_text: null, eligibility_text: null, capacity: 16, fee_amount: k % 2 ? 500 : 0, fee_currency: 'JPY',
        fee_text: null, registration_method: 'first_come', registration_platform: null, registration_url: null, registration_opens_at: null,
        registration_closes_at: null, registration_status: ['open', 'closed', 'unknown'][k % 3], event_status: k % 31 === 0 ? 'cancelled' : 'scheduled',
        source_status_text: 'SYNTHETIC', last_seen_at: `${TODAY}T00:00:00Z`,
      });
    }
    const gdir = path.join(dir, game);
    fs.mkdirSync(gdir, { recursive: true });
    const byMonth = new Map();
    for (const e of evs) byMonth.set(e.starts_on.slice(0, 7), [...(byMonth.get(e.starts_on.slice(0, 7)) ?? []), e]);
    for (const [m, list] of byMonth) fs.writeFileSync(path.join(gdir, `${m}.json`), JSON.stringify(list));
    fs.writeFileSync(path.join(gdir, '_run.json'), JSON.stringify({ game_code: game, source_code: source, fetched_at: `${TODAY}T00:00:00Z`, window, query: {},
      source_total: evs.length, record_count: evs.length, complete: true, collector_version: 'synthetic', notes: [] }));
  }
  return dir;
}

function seed(file, pending) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const db = new SqliteD1(file).migrate(undefined, { pending });
  const accepted = loadAll(DATA ? path.resolve(DATA) : syntheticDir()).filter((r) => !r.errors.length);
  const plan = planImport(accepted, db.readState({ landingFrom: TODAY }), { now: Math.floor(Date.parse(`${TODAY}T10:00:00+09:00`) / 1000) });
  db.execAll(plan.statements);
  db.close();
  console.log(`landing: imported ${accepted.map((r) => `${r.game} ${r.events.length}`).join(', ')}; landing rows ${plan.stats.landing_pages}${plan.notes.length ? `; ${plan.notes.join('; ')}` : ''}`);
  return plan;
}

async function serve(file, env) {
  const server = spawn(process.execPath, ['scripts/dev-node.mjs', '--port', String(PORT), '--sqlite', file], {
    cwd: API, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, LANDING_ENABLED: '', DEV_TODAY: TODAY, ...env },
  });
  await new Promise((ok, no) => {
    server.stdout.on('data', (b) => { if (String(b).includes('dev-node: http://')) ok(); });
    server.on('exit', (c) => no(new Error(`dev-node exited ${c}`)));
  });
  return server;
}
const get = async (p) => { const r = await fetch(BASE + p, { redirect: 'manual' }); return { status: r.status, headers: r.headers, text: await r.text() }; };
const noindex = (r) => /<meta name="robots" content="noindex">/.test(r.text) || r.headers.get('x-robots-tag') === 'noindex';
const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

// ---- off
{
  build({});
  if (fs.existsSync(path.join(ROOT, 'dist/_landing.html'))) fail('off', 'dist/_landing.html built without the flag');
  if (fs.readFileSync(path.join(ROOT, 'dist/robots.txt'), 'utf8').includes('/events/sitemap.xml')) fail('off', 'robots.txt names the landing sitemap');
  if (/id="lpl"|LP_GAMES|<!--\/?LANDING-->/.test(fs.readFileSync(path.join(ROOT, 'dist/events/index.html'), 'utf8'))) fail('off', '/events/ has landing links');
  const file = path.join(OUT, 'landing-off.sqlite3');
  seed(file, true);
  const server = await serve(file, {});
  try {
    for (const p of ['/events/onepiece/tokyo/', '/events/sitemap.xml', '/_landing']) {
      const r = await get(p);
      if (r.status !== 404) fail('off', `${p} answers ${r.status}`);
    }
    if ((await get('/events/')).status !== 200) fail('off', '/events/ broken');
  } finally { server.kill(); }
  console.log('landing: off ok');
}

// ---- on
build({ LANDING_ENABLED: '1' });
try {
  if (!fs.readFileSync(path.join(ROOT, 'dist/robots.txt'), 'utf8').includes('Sitemap: https://shindan-navi.app/events/sitemap.xml')) fail('on', 'robots.txt lacks the landing sitemap');
  const shell = fs.readFileSync(path.join(ROOT, 'dist/_landing.html'), 'utf8');
  if (!shell.includes('<!--LP_MAIN-->') || !shell.includes('<meta name="robots" content="noindex">') || /\/\*[A-Z_]+\*\//.test(shell)) fail('on', 'dist/_landing.html shell slots');
  if (fs.readFileSync(path.join(ROOT, 'dist/sitemap.xml'), 'utf8').includes('/events/onepiece/')) fail('on', 'static sitemap lists landing pages');

  // migration missing: pages 404 noindex, importer skips with its note
  const bare = path.join(OUT, 'landing-bare.sqlite3');
  const barePlan = seed(bare, false);
  if (barePlan.stats.landing_pages !== 0 || !barePlan.notes.length) fail('on/bare', 'importer wrote landing rows without the table');
  let server = await serve(bare, { LANDING_ENABLED: '1' });
  try {
    const r = await get('/events/onepiece/tokyo/');
    if (r.status !== 404 || !noindex(r)) fail('on/bare', `page ${r.status}, noindex ${noindex(r)}`);
    if ((await get('/events/sitemap.xml')).text.includes('<url>')) fail('on/bare', 'sitemap lists pages');
  } finally { server.kill(); }

  const file = path.join(OUT, 'landing-on.sqlite3');
  const plan = seed(file, true);
  if (plan.stats.landing_pages > 624) fail('on', `${plan.stats.landing_pages} landing writes`);
  server = await serve(file, { LANDING_ENABLED: '1' });
  try {
    const sm = await get('/events/sitemap.xml');
    const locs = [...sm.text.matchAll(/<loc>https:\/\/shindan-navi\.app(\/events\/[^<]+)<\/loc><lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)].map((m) => m[1]);
    if (!locs.length) fail('on', 'sitemap is empty');
    console.log(`landing: sitemap ${locs.length} pages`);
    const linked = new Set();
    const sizes = [];
    for (const p of locs) {
      const r = await get(p);
      sizes.push(r.text.length);
      if (r.status !== 200 || noindex(r)) { fail(p, `status ${r.status}, noindex ${noindex(r)}`); continue; }
      const h1 = r.text.indexOf('<h1>'), list = r.text.indexOf('class="lp-list"');
      if (h1 < 0 || h1 > list) fail(p, 'h1 not above the list');
      if (!r.text.includes(`<link rel="canonical" href="https://shindan-navi.app${p}">`)) fail(p, 'canonical');
      if (/<!--\/?LP_/.test(r.text)) fail(p, 'unfilled slot');
      const blocks = ldOf(r.text);
      const evs = blocks.filter((b) => b['@type'] === 'Event');
      if (blocks[0]?.['@type'] !== 'BreadcrumbList' || !evs.length) fail(p, 'JSON-LD');
      for (const e of evs) {
        if (!e.name || !e.startDate || e.startDate.slice(0, 10) < TODAY || !e.location || !/^https:\/\/schema\.org\//.test(e.eventStatus)) fail(p, `Event ${JSON.stringify(e).slice(0, 120)}`);
      }
      if (/"@type":"(Product|Offer|AggregateRating)"/.test(r.text)) fail(p, 'sales markup');
      const hrefs = [...r.text.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));
      for (const h of new Set(hrefs)) {
        if (h.startsWith('/events/') && h.split('/').length === 5) linked.add(h);
        if (h.startsWith('/events/?') || h.startsWith('/events/') && h.split('/').length === 5) continue;
        const t = await get(h.split('?')[0]);
        if (t.status !== 200) fail(p, `link ${h} answers ${t.status}`);
      }
    }
    console.log(`landing: page HTML ${Math.min(...sizes)}..${Math.max(...sizes)} chars`);
    // a page the sitemap leaves out (no upcoming events): noindex
    const unlisted = [...linked].filter((h) => !locs.includes(h));
    if (!unlisted.length) console.log('landing: every linked page is indexable (no empty page to check)');
    for (const h of unlisted.slice(0, 5)) {
      const r = await get(h);
      if (!noindex(r) || ![200, 404].includes(r.status)) fail(h, `unlisted page: status ${r.status}, noindex ${noindex(r)}`);
    }
    const r301 = await get('/events/onepiece/tokyo');
    if (r301.status !== 301) fail('redirect', String(r301.status));
    if ((await get('/events/mtg/tokyo/')).status !== 404) fail('unknown slug', 'not 404');

    // browser: one dense page, both widths
    const target = locs.includes('/events/onepiece/tokyo/') ? '/events/onepiece/tokyo/' : locs[0];
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      for (const [vp, o] of Object.entries({ desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true } })) {
        const where = `${vp} ${target}`;
        const ctx = await browser.newContext({ viewport: { width: o.width, height: o.height }, isMobile: !!o.isMobile, hasTouch: !!o.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
        const page = await ctx.newPage();
        const api = [];
        page.on('console', (m) => { if (m.type() === 'error') fail(where, `console: ${m.text()}`); });
        page.on('pageerror', (e) => fail(where, `pageerror: ${e.message}`));
        page.on('request', (r) => { if (r.url().includes('/api/')) api.push(new URL(r.url()).pathname); });
        await page.goto(BASE + target, { waitUntil: 'networkidle' });
        if (api.length) fail(where, `API requests ${api}`);
        if (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) > 1) fail(where, 'scrolls horizontally');
        const tog = page.locator('button.evg-tog').first();
        if (await tog.count()) {
          const id = await tog.getAttribute('aria-controls');
          await tog.click();
          if (await tog.getAttribute('aria-expanded') !== 'true' || await page.locator(`#${id}`).isHidden()) fail(where, 'group toggle does not open');
        } else fail(where, 'no grouped row to check');
        // /events/ links the chosen location's landing pages: per chosen title, else per title with events there
        const ev = await ctx.newPage();
        await ev.clock.setFixedTime(new Date(`${TODAY}T12:00:00+09:00`));
        ev.on('pageerror', (e) => fail(`${vp} /events/`, `pageerror: ${e.message}`));
        await ev.goto(`${BASE}/events/?pref=JP-13&game=OPCG`, { waitUntil: 'networkidle' });
        const one = await ev.$$eval('#lpl a', (as) => as.map((a) => a.getAttribute('href')));
        if (JSON.stringify(one) !== JSON.stringify(['/events/onepiece/tokyo/'])) fail(`${vp} /events/`, `links with OPCG chosen: ${one}`);
        await ev.evaluate(() => localStorage.clear());
        await ev.goto(`${BASE}/events/?pref=JP-13`, { waitUntil: 'networkidle' });
        const all = await ev.$$eval('#lpl a', (as) => as.map((a) => a.getAttribute('href')));
        if (!all.length || !all.every((h) => /^\/events\/[a-z-]+\/tokyo\/$/.test(h))) fail(`${vp} /events/`, `links without a title: ${all}`);
        for (const h of all) if ((await get(h)).status !== 200) fail(`${vp} /events/`, `${h} not 200`);
        const lsmall = await ev.$$eval('#lpl, #lpl *', (els) => els.filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).length);
        if (lsmall) fail(`${vp} /events/`, 'landing links under 12px');
        if (await ev.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) > 1) fail(`${vp} /events/`, 'scrolls horizontally');
        await ev.locator('#lpl').screenshot({ path: path.join(OUT, `${vp}-events-landing-links.png`) });
        console.log(`landing: ${vp} /events/ links ${all.length}`);
        await ev.close();
        const small = await page.$$eval('.lp-day *', (els) => els.filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).length);
        if (small) fail(where, `${small} text elements under 12px`);
        await page.screenshot({ path: path.join(OUT, `${vp}-landing.png`), fullPage: false });
        await ctx.close();
      }
    } finally { await browser.close(); }
  } finally { server.kill(); }
} finally {
  build({});
}

if (fails.length) {
  console.error(`landing: ${fails.length} FAIL\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(`landing: ok (screenshots in ${path.relative(ROOT, OUT)}/)`);
