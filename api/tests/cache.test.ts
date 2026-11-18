import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { BROWSER_TTL, EDGE_TTL, STATE_TTL_MS } from '../src/index';
import { importDir, newDb, run, synthetic, writeDataDir } from './helpers';
import type { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';

/** In-memory stand-in for caches.default (keyed by URL, GET only). Hits carry an Age header like the edge's. */
class FakeCache {
  store = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();
  puts: Array<{ url: string; cacheControl: string | null }> = [];
  async match(req: Request) {
    const hit = this.store.get(req.url);
    if (!hit) return undefined;
    const res = new Response(hit.body.slice(0), hit.init);
    res.headers.set('age', '4000');
    return res;
  }
  async put(req: Request, res: Response) {
    this.puts.push({ url: req.url, cacheControl: res.headers.get('cache-control') });
    this.store.set(req.url, { body: await res.arrayBuffer(), init: { status: res.status, headers: res.headers } });
  }
}

let raw: SqliteD1;
let db: D1Database;
let cache: FakeCache;
let queries: number;
let dir: string;
const evs = synthetic(80);

beforeEach(() => {
  raw = newDb();
  dir = writeDataDir(evs);
  importDir(raw, dir, 1_000);
  queries = 0;
  // One proxy per test: the Worker memoizes the data version per database object.
  db = new Proxy(raw, {
    get(target, prop, recv) {
      if (prop === 'prepare') queries++;
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as unknown as D1Database;
  cache = new FakeCache();
  vi.stubGlobal('caches', { default: cache });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function call(path: string, method = 'GET', ctx?: ExecutionContext, on = db) {
  const res = await worker.fetch(new Request(`https://shindan-navi.app${path}`, { method }), { DB: on }, ctx);
  return { res, text: await res.text() };
}

const EVENTS = '/api/v1/events?from=2026-11-18&until=2027-01-01&game=OPCG&pref=JP-13,JP-14';

describe('edge cache', () => {
  it('serves a repeated GET from the cache, keyed by data version, without an Age header', async () => {
    const a = await call(EVENTS);
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get('x-edge-cache')).toBe('miss');
    expect(a.res.headers.get('cache-control')).toBe(`public, max-age=${BROWSER_TTL}`);
    expect(cache.puts).toEqual([{
      url: 'https://shindan-navi.app/api/v1/events?v=1000&from=2026-11-18&until=2027-01-01&game=OPCG&pref=JP-13%2CJP-14&limit=100',
      cacheControl: `public, max-age=${EDGE_TTL}`,
    }]);
    expect(queries).toBe(2);
    const b = await call(EVENTS);
    expect(b.res.headers.get('x-edge-cache')).toBe('hit');
    expect(b.res.headers.get('cache-control')).toBe(`public, max-age=${BROWSER_TTL}`);
    expect(b.res.headers.get('age')).toBeNull();
    expect(b.text).toBe(a.text);
    expect(queries).toBe(2);
  });

  it('shares one entry across spellings of the same filters', async () => {
    await call('/api/v1/events/days?until=2027-01-01&pref=JP-14,JP-13&game=OPCG&from=2026-11-18');
    for (const q of ['from=2026-11-18&until=2027-01-01&game=OPCG&pref=JP-13,JP-14', 'from=2026-11-18&pref=JP-13&pref=JP-14&game=OPCG&until=2027-01-01']) {
      expect((await call(`/api/v1/events/days?${q}`)).res.headers.get('x-edge-cache')).toBe('hit');
    }
    await call(EVENTS);
    expect((await call(`${EVENTS}&limit=100`)).res.headers.get('x-edge-cache')).toBe('hit');
    expect(cache.puts).toHaveLength(2);
  });

  it('keeps different queries apart', async () => {
    await call(EVENTS);
    expect((await call(EVENTS.replace('OPCG', 'PTCG'))).res.headers.get('x-edge-cache')).toBe('miss');
  });

  it('caches meta under its path and version only', async () => {
    await call('/api/v1/events/meta');
    expect((await call('/api/v1/events/meta')).res.headers.get('x-edge-cache')).toBe('hit');
    expect(cache.puts.map((p) => p.url)).toEqual(['https://shindan-navi.app/api/v1/events/meta?v=1000']);
  });

  it('rejects cache-busting parameters instead of caching them', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await call(`${EVENTS}&x=${i}`);
      expect(r.res.status).toBe(400);
      expect(r.res.headers.get('cache-control')).toBe('no-store');
    }
    expect((await call('/api/v1/events/meta?x=1')).res.status).toBe(400);
    expect(cache.puts).toEqual([]);
  });

  it('does not cache errors', async () => {
    const r = await call('/api/v1/events?from=2026-11-18&until=2027-01-01');
    expect(r.res.status).toBe(400);
    expect((await call('/api/v1/nope')).res.status).toBe(404);
    expect(cache.puts).toEqual([]);
  });

  it('does not cache 5xx', async () => {
    const broken = new Proxy(raw, {
      get(target, prop, recv) {
        if (prop === 'prepare') return (sql: string) => (sql.includes('site_meta') ? target.prepare(sql) : { bind: () => ({ all: async () => { throw new Error('boom'); } }) });
        return Reflect.get(target, prop, recv);
      },
    }) as unknown as D1Database;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await call(EVENTS, 'GET', undefined, broken);
    expect(r.res.status).toBe(500);
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(cache.puts).toEqual([]);
  });

  it('never caches geo', async () => {
    expect((await call('/api/v1/geo')).res.headers.get('cache-control')).toBe('private, no-store');
    expect(cache.puts).toEqual([]);
  });

  it('caches nothing before the first import', async () => {
    const empty = newDb() as unknown as D1Database;
    const r = await call('/api/v1/events/meta', 'GET', undefined, empty);
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(cache.puts).toEqual([]);
  });

  it('answers HEAD from the same entry without a body', async () => {
    await call(EVENTS);
    const h = await call(EVENTS, 'HEAD');
    expect(h.res.status).toBe(200);
    expect(h.res.headers.get('x-edge-cache')).toBe('hit');
    expect(h.text).toBe('');
  });

  it('moves to a new key once an import bumps the version and the isolate re-reads it', async () => {
    await call(EVENTS);
    importDir(raw, writeDataDir(evs.slice(1), { OPCG: run('OPCG', evs.filter((e) => e.game_code === 'OPCG').length - 1) }), 2_000);
    expect((await call(EVENTS)).res.headers.get('x-edge-cache')).toBe('hit');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + STATE_TTL_MS + 1);
    const r = await call(EVENTS);
    expect(r.res.headers.get('x-edge-cache')).toBe('miss');
    expect(cache.puts.at(-1)!.url).toContain('?v=2000&');
  });

  it('hands the cache write to waitUntil when a context is given', async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    await call(EVENTS, 'GET', ctx);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(cache.store.size).toBe(1);
  });
});

describe('without the Cache API', () => {
  it('answers with no-store and no cache marker', async () => {
    vi.unstubAllGlobals();
    const r = await call(EVENTS);
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(r.res.headers.get('x-edge-cache')).toBeNull();
  });
});
