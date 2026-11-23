import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { BROWSER_TTL } from '../src/worker';
import { LOCS, PREF_SLUGS, landingRoute, renderLanding, STALE_DAYS } from '../src/landing';
import { GAMES, PREFECTURES } from '../src/constants';
import {
  emptyState, estimateCost, LANDING_DAYS, LANDING_LOCS, LANDING_MISSING, LANDING_PER_DAY, landingRows, loadAll, MAX_LANDING_BYTES, planImport,
} from '../scripts/lib/importer.mjs';
import { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';
import { remoteConfig } from '../scripts/remote-config.mjs';
import { newDb, run, synthetic, writeDataDir, type Ev } from './helpers';

// 2026-11-18 10:00 JST: the synthetic window starts that day.
const NOW = Date.parse('2026-11-18T01:00:00Z') / 1000;
const TODAY = '2026-11-18';
const TEMPLATE = '<!doctype html><html><head><!--LP_HEAD--><title>shell</title>\n<meta name="robots" content="noindex"><!--/LP_HEAD--></head>'
  + '<body><div class="wrap"><!--LP_MAIN--><main>empty</main><!--/LP_MAIN--></div></body></html>';

const pendingDb = () => new SqliteD1().migrate(undefined, { pending: true });

function importInto(db: SqliteD1, events: Ev[], now = NOW, runs: Record<string, Ev> = {}) {
  const accepted = loadAll(writeDataDir(events, runs)).filter((r) => !r.errors.length);
  const plan = planImport(accepted, db.readState(), { now });
  db.execAll(plan.statements);
  return plan;
}

/** Assets stand-in: the shell at /_landing (unless `shell` is null), everything else the static 404. */
const assets = (shell: string | null = TEMPLATE) => ({
  fetch: async (req: Request | string) => {
    const p = new URL(typeof req === 'string' ? req : req.url).pathname;
    if (p === '/_landing' && shell !== null) return new Response(shell, { headers: { 'content-type': 'text/html' } });
    return new Response('static-404', { status: 404 });
  },
}) as unknown as Fetcher;

async function get(db: SqliteD1, path: string, env: Record<string, unknown> = {}, method = 'GET') {
  const res = await worker.fetch(new Request(`https://shindan-navi.app${path}`, { method }),
    { DB: db as unknown as D1Database, ASSETS: assets(), LANDING_ENABLED: '1', DEV_TODAY: TODAY, ...env } as any);
  return { res, text: await res.text() };
}

const ld = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const robotsNoindex = (html: string) => /<meta name="robots" content="noindex">/.test(html);

// Dense Tokyo ONE PIECE days plus a few elsewhere: every synthetic OPCG event moved to Tokyo or Osaka.
const tokyo = (n: number, seed = 0) => synthetic(n * 4, seed).filter((e) => e.game_code === 'OPCG').map((e, i) => ({
  ...e,
  attendance_mode: 'in_person',
  venue: { ...(e.venue ?? { name: `【SYNTHETIC】shop ${i}`, source_id: null, country_code: 'JP', city: null, address: null, postal_code: null }),
    region_code: i % 5 ? 'JP-13' : 'JP-27', region_name: i % 5 ? '東京都' : '大阪府' },
}));

describe('landing rows (importer)', () => {
  it('writes 48 rows per imported game, nothing on a same-day re-run, and counts them in the cost', () => {
    const db = pendingDb();
    const plan = importInto(db, synthetic(400));
    expect(plan.stats.landing_pages).toBe(4 * 48);
    expect(plan.notes).toEqual([]);
    expect(estimateCost(plan.stats, emptyState()).writes.landing_pages).toBe(4 * 48);
    const n = db.db.prepare('SELECT COUNT(*) AS n FROM landing_pages').get() as { n: number };
    expect(n.n).toBe(192);
    const again = planImport(loadAll(writeDataDir(synthetic(400))), db.readState(), { now: NOW + 60 });
    expect(again.stats.landing_pages).toBe(0);
    expect(again.statements).toEqual([]);
    expect(estimateCost(again.stats, db.readState()).reads['state read']).toBeGreaterThanOrEqual(192);
    // a later JST day moves every row's first day: rewritten (still <= 48 per game)
    expect(planImport(loadAll(writeDataDir(synthetic(400))), db.readState(), { now: NOW + 86_400 }).stats.landing_pages).toBe(192);
  });

  it('stays within 624 writes for all 13 games', () => {
    const evs: Ev[] = GAMES.flatMap((g, gi) => synthetic(4, gi * 10).map((e, i) => ({ ...e, id: `x:${g.code}${i}`, external_id: `${g.code}${i}`, game_code: g.code })));
    const runs = Object.fromEntries(GAMES.map((g) => [g.code, run(g.code, 4)]));
    for (const e of evs) { e.source_code = runs[e.game_code].source_code; e.id = `${{ bandai_tcg_plus: 'tcgp', pokemon_players: 'ptcg', conan_official: 'conan', bushinavi: 'bnavi' }[e.source_code as string]}:${e.external_id}`; }
    const plan = importInto(pendingDb(), evs, NOW, runs);
    expect(plan.stats.landing_pages).toBe(624);
  });

  it('skips the rows with a note while the table is missing', () => {
    const db = newDb();
    const plan = importInto(db, synthetic(40));
    expect(plan.stats.landing_pages).toBe(0);
    expect(plan.notes).toEqual([LANDING_MISSING]);
    expect(plan.statements.some((s) => s.includes('landing_pages'))).toBe(false);
  });

  it('keeps LANDING_PER_DAY events a day in API order, counts all, caps the bytes and the days', () => {
    const many = Array.from({ length: 30 }, (_, d) => Array.from({ length: 20 }, (_, i) => ({
      ...synthetic(1, d * 100 + i)[0], id: `tcgp:d${d}i${i}`, external_id: `d${d}i${i}`, game_code: 'OPCG',
      name: `【SYNTHETIC】${'長い名前'.repeat(20)} ${d}-${i}`, attendance_mode: 'in_person',
      starts_on: new Date(Date.parse(`${TODAY}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10), starts_at: null, time_precision: 'date',
      venue: { name: '【SYNTHETIC】shop', source_id: null, country_code: 'JP', region_code: 'JP-13', region_name: '東京都', city: '千代田区', address: '【SYNTHETIC】address', postal_code: null },
    }))).flat();
    const rows = landingRows(run('OPCG', many.length), many, TODAY);
    expect(rows.map((r: Ev) => r.loc)).toEqual(LANDING_LOCS);
    const t = rows.find((r: Ev) => r.loc === 'JP-13')!;
    const days = JSON.parse(t.days_json);
    expect(Object.keys(days)).toHaveLength(LANDING_DAYS);
    expect(Object.values(days).every((n) => n === 20)).toBe(true);
    const evs = JSON.parse(t.events_json);
    expect(Buffer.byteLength(t.events_json)).toBeLessThanOrEqual(MAX_LANDING_BYTES);
    const perDay = new Map<string, number>();
    for (const e of evs) perDay.set(e.starts_on, (perDay.get(e.starts_on) ?? 0) + 1);
    // fewer a day before any day is dropped: every day keeps the same count
    expect(perDay.size).toBe(LANDING_DAYS);
    expect(new Set(perDay.values()).size).toBe(1);
    expect(Math.max(...perDay.values())).toBeLessThan(LANDING_PER_DAY);
    expect([...perDay.keys()][0]).toBe(TODAY);
    // implied fields are left out
    expect(evs[0].venue).not.toHaveProperty('region_code');
    // one event a day still too big: whole days go from the end
    const huge = many.map((e) => ({ ...e, name: `${e.name}${'あ'.repeat(1500)}` }));
    const h = landingRows(run('OPCG', huge.length), huge, TODAY).find((r: Ev) => r.loc === 'JP-13')!;
    const hev = JSON.parse(h.events_json);
    expect(Buffer.byteLength(h.events_json)).toBeLessThanOrEqual(MAX_LANDING_BYTES);
    expect(new Set(hev.map((e: Ev) => e.starts_on)).size).toBe(hev.length);
    expect(hev[0].starts_on).toBe(TODAY);
    expect(hev.length).toBeLessThan(LANDING_DAYS);
    expect(evs[0]).not.toHaveProperty('fee_text');
    expect(evs[0].venue).not.toHaveProperty('geo');
    expect(JSON.parse(rows.find((r: Ev) => r.loc === 'JP-01')!.days_json)).toEqual({});
  });
});

describe('routing', () => {
  it('maps every game and location, and nothing else', () => {
    expect(PREF_SLUGS).toHaveLength(PREFECTURES.length);
    expect(LOCS).toHaveLength(48);
    expect(landingRoute('/events/onepiece/tokyo/')).toEqual({ kind: 'page', code: 'OPCG', loc: 'JP-13', path: '/events/onepiece/tokyo/' });
    expect(landingRoute('/events/shadowverse-evolve/online/')).toMatchObject({ code: 'SVE', loc: 'online' });
    expect(landingRoute('/events/onepiece/tokyo')).toEqual({ kind: 'redirect', to: '/events/onepiece/tokyo/' });
    for (const p of ['/events/', '/events/index.html', '/events/mtg/tokyo/', '/events/onepiece/Tokyo/', '/events/onepiece/tokyo/x/', '/events/onepiece/jp-13/']) {
      expect(landingRoute(p)).toBeNull();
    }
    expect(landingRoute('/events/sitemap.xml')).toEqual({ kind: 'sitemap' });
  });

  it('leaves the paths to the assets while the flag is off', async () => {
    const db = pendingDb();
    importInto(db, tokyo(60));
    for (const env of [{ LANDING_ENABLED: undefined }, { LANDING_ENABLED: '0' }]) {
      for (const p of ['/events/onepiece/tokyo/', '/events/sitemap.xml']) {
        const { res, text } = await get(db, p, env);
        expect(res.status).toBe(404);
        expect(text).toBe('static-404');
      }
    }
  });

  it('remote-config adds the routes and the var only with the flag', () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    const off = remoteConfig(id);
    expect(off.assets.run_worker_first).toEqual(['/api/*']);
    expect(off.vars.LANDING_ENABLED).toBeUndefined();
    const on = remoteConfig(id, { landing: true });
    expect(on.assets.run_worker_first).toEqual(['/api/*', '/events/*/*', '/events/sitemap.xml']);
    expect(on.vars).toMatchObject({ LANDING_ENABLED: '1', SITE_ORIGIN: 'https://shindan-navi.app' });
  });
});

describe('pages (flag on)', () => {
  let db: SqliteD1;
  beforeEach(() => {
    db = pendingDb();
    importInto(db, tokyo(80));
  });

  it('renders an indexable page with the h1 above the list, rows, Event JSON-LD and links', async () => {
    const { res, text } = await get(db, '/events/onepiece/tokyo/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-robots-tag')).toBeNull();
    expect(robotsNoindex(text)).toBe(false);
    expect(text).toContain('<title>ワンピカードの大会・イベント（東京都）｜トレカカレンダー</title>');
    expect(text).toContain('<link rel="canonical" href="https://shindan-navi.app/events/onepiece/tokyo/">');
    expect(text.indexOf('<h1>東京都のワンピカード 大会・イベント一覧</h1>')).toBeGreaterThan(-1);
    expect(text.indexOf('<h1>')).toBeLessThan(text.indexOf('class="lp-day"'));
    expect(text).toContain('class="ev');
    expect(text).not.toContain('<!--LP_');
    expect(text).toContain('href="/events/onepiece/osaka/"');
    expect(text).toContain('href="/events/pokemon/tokyo/"');
    expect(text).toContain('href="/onepiece/"');
    const blocks = ld(text);
    expect(blocks[0]['@type']).toBe('BreadcrumbList');
    expect(blocks[0].itemListElement.at(-1).item).toBe('https://shindan-navi.app/events/onepiece/tokyo/');
    const events = blocks.filter((b) => b['@type'] === 'Event');
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.name).not.toMatch(/^\s|\s$/);
      expect(e.startDate >= TODAY).toBe(true);
      expect(e.location).toBeTruthy();
      expect(e.eventStatus).toMatch(/^https:\/\/schema\.org\/Event(Scheduled|Cancelled|Postponed)$/);
    }
    expect(text).not.toMatch(/"@type":"(Product|Offer)"/);
  });

  it('drops past days and turns noindex once the data is stale or the page is empty', async () => {
    const later = new Date(Date.parse(`${TODAY}T00:00:00Z`) + (STALE_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    const stale = await get(db, '/events/onepiece/tokyo/', { DEV_TODAY: later });
    expect(stale.res.status).toBe(200);
    expect(stale.res.headers.get('x-robots-tag')).toBe('noindex');
    expect(robotsNoindex(stale.text)).toBe(true);
    for (const m of stale.text.matchAll(/<time datetime="(\d{4}-\d{2}-\d{2})">/g)) expect(m[1] >= later).toBe(true);
    const empty = await get(db, '/events/onepiece/hokkaido/');
    expect(empty.res.status).toBe(200);
    expect(robotsNoindex(empty.text)).toBe(true);
    expect(empty.text).toContain('いま掲載していません');
    expect(ld(empty.text).filter((b) => b['@type'] === 'Event')).toEqual([]);
  });

  it('answers 404 noindex for a game without rows, redirects to the slash URL, refuses POST', async () => {
    const none = await get(db, '/events/hololive/tokyo/');
    expect(none.res.status).toBe(404);
    expect(robotsNoindex(none.text)).toBe(true);
    const r = await get(db, '/events/onepiece/tokyo');
    expect(r.res.status).toBe(301);
    expect(r.res.headers.get('location')).toBe('/events/onepiece/tokyo/');
    expect((await get(db, '/events/onepiece/tokyo/', {}, 'POST')).res.status).toBe(405);
    const head = await get(db, '/events/onepiece/tokyo/', {}, 'HEAD');
    expect(head.res.status).toBe(200);
    expect(head.text).toBe('');
  });

  it('answers 404 noindex while the table is missing, and passes through without a shell', async () => {
    const bare = newDb();
    importInto(bare, tokyo(20));
    const p = await get(bare, '/events/onepiece/tokyo/');
    expect(p.res.status).toBe(404);
    expect(robotsNoindex(p.text)).toBe(true);
    const s = await get(bare, '/events/sitemap.xml');
    expect(s.res.status).toBe(200);
    expect(s.text).not.toContain('<url>');
    const noShell = await worker.fetch(new Request('https://shindan-navi.app/events/onepiece/tokyo/'),
      { DB: db as unknown as D1Database, ASSETS: assets(null), LANDING_ENABLED: '1', DEV_TODAY: TODAY } as any);
    expect(await noShell.text()).toBe('static-404');
  });

  it('lists exactly the indexable pages in the sitemap', async () => {
    importInto(db, synthetic(200, 7).filter((e) => e.game_code === 'PTCG'));
    const { res, text } = await get(db, '/events/sitemap.xml');
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const locs = [...text.matchAll(/<loc>https:\/\/shindan-navi\.app(.*?)<\/loc><lastmod>(.*?)<\/lastmod>/g)].map((m) => m[1]);
    expect(locs).toContain('/events/onepiece/tokyo/');
    expect(locs).not.toContain('/events/onepiece/hokkaido/');
    for (const p of locs) {
      const page = await get(db, p);
      expect(robotsNoindex(page.text)).toBe(false);
    }
    const later = new Date(Date.parse(`${TODAY}T00:00:00Z`) + (STALE_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    expect((await get(db, '/events/sitemap.xml', { DEV_TODAY: later })).text).not.toContain('<url>');
  });

  it('renders the same page from a row as renderLanding does (no row: noindex 404)', () => {
    const out = renderLanding(TEMPLATE, 'PTCG', 'JP-13', null, TODAY);
    expect(out.status).toBe(404);
    expect(out.indexable).toBe(false);
    expect(out.html).toContain('準備中');
  });
});

describe('cache and limits', () => {
  class FakeCache {
    store = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();
    keys: string[] = [];
    async match(req: Request) {
      const hit = this.store.get(req.url);
      return hit ? new Response(hit.body.slice(0), hit.init) : undefined;
    }
    async put(req: Request, res: Response) {
      if (!req.url.includes('/__state')) this.keys.push(req.url);
      this.store.set(req.url, { body: await res.arrayBuffer(), init: { status: res.status, headers: res.headers } });
    }
  }
  let cache: FakeCache;
  beforeEach(() => {
    cache = new FakeCache();
    vi.stubGlobal('caches', { default: cache });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('caches a page per data version, day and shell; a hit reads no landing row', async () => {
    const raw = pendingDb();
    importInto(raw, tokyo(40));
    let reads = 0;
    const db = new Proxy(raw, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv);
        if (prop === 'prepare') return (sql: string) => { if (sql.includes('landing_pages')) reads++; return (v as any).call(t, sql); };
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as unknown as SqliteD1;
    const a = await get(db, '/events/onepiece/tokyo/');
    expect(a.res.headers.get('x-edge-cache')).toBe('miss');
    expect(a.res.headers.get('cache-control')).toBe(`public, max-age=${BROWSER_TTL}`);
    const b = await get(db, '/events/onepiece/tokyo/');
    expect(b.res.headers.get('x-edge-cache')).toBe('hit');
    expect(b.text).toBe(a.text);
    expect(reads).toBe(1);
    expect(cache.keys[0]).toMatch(/\/events\/onepiece\/tokyo\/\?v=\d+&d=2026-11-18&t=[0-9a-z]+$/);
    await get(db, '/events/onepiece/tokyo/', { DEV_TODAY: '2026-11-19' });
    expect(reads).toBe(2);
  });

  it('rate-limits misses with an HTML-safe 429 and answers 503 when D1 fails', async () => {
    const db = pendingDb();
    importInto(db, tokyo(20));
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const r = await get(db, '/events/onepiece/tokyo/', { API_LIMIT: limiter });
    expect(r.res.status).toBe(429);
    expect(r.res.headers.get('retry-after')).toBe('60');
    expect(r.res.headers.get('x-robots-tag')).toBe('noindex');
    const down = new Proxy(newDb(), { get: (t, p, rv) => (p === 'prepare' ? () => { throw new Error('D1 down'); } : Reflect.get(t, p, rv)) });
    const d = await get(down as SqliteD1, '/events/onepiece/tokyo/');
    expect(d.res.status).toBe(503);
  });
});
