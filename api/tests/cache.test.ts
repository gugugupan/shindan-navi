import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { BROWSER_TTL, clientKey, EDGE_TTL, STATE_TTL_MS } from '../src/index';
import { importDir, newDb, run, synthetic, writeDataDir } from './helpers';
import type { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';

/** In-memory stand-in for caches.default (keyed by URL, GET only). Hits carry an Age header like the edge's. */
class FakeCache {
  store = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();
  // Answer puts only; the Worker's own data-state copy is tracked separately.
  puts: Array<{ url: string; cacheControl: string | null }> = [];
  statePuts = 0;
  async match(req: Request) {
    const hit = this.store.get(req.url);
    if (!hit) return undefined;
    const res = new Response(hit.body.slice(0), hit.init);
    res.headers.set('age', '4000');
    return res;
  }
  async put(req: Request, res: Response) {
    if (req.url.endsWith('/api/__state')) this.statePuts++;
    else this.puts.push({ url: req.url, cacheControl: res.headers.get('cache-control') });
    this.store.set(req.url, { body: await res.arrayBuffer(), init: { status: res.status, headers: res.headers } });
  }
}

let raw: SqliteD1;
let db: D1Database;
let down = false;
const stubFailing = () => { down = true; };
let cache: FakeCache;
let queries: number;
let dir: string;
const evs = synthetic(80);

beforeEach(() => {
  raw = newDb();
  dir = writeDataDir(evs);
  importDir(raw, dir, 1_000);
  queries = 0;
  down = false;
  // One proxy per test: the Worker memoizes the data version per database object.
  db = new Proxy(raw, {
    get(target, prop, recv) {
      if (prop === 'prepare') {
        queries++;
        if (down) return () => { throw new Error('D1 down'); };
      }
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

async function call(path: string, method = 'GET', ctx?: ExecutionContext, on = db, limiter?: RateLimit) {
  const res = await worker.fetch(new Request(`https://shindan-navi.app${path}`, { method }), { DB: on, API_LIMIT: limiter }, ctx);
  return { res, text: await res.text() };
}

const EVENTS = '/api/v1/events?from=2026-11-18&until=2026-12-01&game=OPCG&pref=JP-13,JP-14';
const failing = (target: SqliteD1) => new Proxy(target, {
  get(t, prop, recv) {
    if (prop === 'prepare') return () => { throw new Error('D1 down'); };
    return Reflect.get(t, prop, recv);
  },
}) as unknown as D1Database;

describe('edge cache', () => {
  it('serves a repeated GET from the cache, keyed by data version, without an Age header', async () => {
    const a = await call(EVENTS);
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get('x-edge-cache')).toBe('miss');
    expect(a.res.headers.get('cache-control')).toBe(`public, max-age=${BROWSER_TTL}`);
    expect(cache.puts).toEqual([{
      url: 'https://shindan-navi.app/api/v1/events?v=1000&from=2026-11-18&until=2026-12-01&game=OPCG&pref=JP-13%2CJP-14',
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
    await call('/api/v1/events/days?until=2027-01-01&pref=JP-14,JP-13&game=OPCG&from=2026-12-01');
    for (const q of ['from=2026-12-01&until=2027-01-01&game=OPCG&pref=JP-13,JP-14', 'from=2026-12-01&pref=JP-13&pref=JP-14&game=OPCG&until=2027-01-01']) {
      expect((await call(`/api/v1/events/days?${q}`)).res.headers.get('x-edge-cache')).toBe('hit');
    }
    await call(EVENTS);
    expect((await call(`${EVENTS}&limit=50`)).res.headers.get('x-edge-cache')).toBe('hit');
    // Clamped to the data window (from 2026-11-18): the same entry as the in-window spelling.
    await call('/api/v1/events?from=2026-11-18&until=2026-12-01&pref=JP-13');
    expect((await call('/api/v1/events?from=2026-11-10&until=2026-12-01&pref=JP-13')).res.headers.get('x-edge-cache')).toBe('hit');
    expect(cache.puts).toHaveLength(3);
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
    const r = await call('/api/v1/events?from=2026-11-18&until=2026-12-01');
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

  it('keeps serving cached answers when D1 fails after the version memo expired', async () => {
    await call(EVENTS);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + STATE_TTL_MS + 1);
    stubFailing();
    expect((await call(EVENTS)).res.headers.get('x-edge-cache')).toBe('hit');
  });

  it('lets a cold isolate find the last data version in the colo cache while D1 fails', async () => {
    await call(EVENTS);
    expect(cache.statePuts).toBe(1);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cold = failing(raw);
    const r = await call(EVENTS, 'GET', undefined, cold);
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get('x-edge-cache')).toBe('hit');
    expect((await call(EVENTS.replace('OPCG', 'PTCG'), 'GET', undefined, cold)).res.status).toBe(500);
  });

  it('rate-limits misses only', async () => {
    const calls: string[] = [];
    const deny = { limit: async ({ key }: { key: string }) => (calls.push(key), { success: false }) } as unknown as RateLimit;
    const allow = { limit: async () => ({ success: true }) } as unknown as RateLimit;
    await call(EVENTS, 'GET', undefined, db, allow);
    expect((await call(EVENTS, 'GET', undefined, db, deny)).res.headers.get('x-edge-cache')).toBe('hit');
    const r = await call(EVENTS.replace('OPCG', 'PTCG'), 'GET', undefined, db, deny);
    expect(r.res.status).toBe(429);
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(calls).toEqual(['unknown']);
    const breaker = { limit: async ({ key }: { key: string }) => (calls.push(`breaker:${key}`), { success: false }) } as unknown as RateLimit;
    const env = { DB: db, API_LIMIT: allow, API_BREAKER: breaker };
    const res = await worker.fetch(new Request(`https://shindan-navi.app${EVENTS.replace('OPCG', 'CONAN')}`), env);
    expect(res.status).toBe(503);
    expect(calls).toContain('breaker:all');
  });

  it('keys clients by IPv4 address and IPv6 /64', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('2001:db8:0:12:aaaa::1')).toBe('2001:db8:0:12::/64');
    expect(clientKey('2001:DB8:0:12:bbbb:1:2:3')).toBe('2001:db8:0:12::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey(null)).toBe('unknown');
  });

  it('backs off D1 for a few seconds after a failed version read', async () => {
    await call(EVENTS);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = Date.now() + STATE_TTL_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(t);
    stubFailing();
    await call(EVENTS);
    const before = queries;
    await call(EVENTS);
    expect(queries).toBe(before);
  });

  it('hands the cache write to waitUntil when a context is given', async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    await call(EVENTS, 'GET', ctx);
    expect(pending).toHaveLength(2);
    await Promise.all(pending);
    expect(cache.puts).toHaveLength(1);
    expect(cache.statePuts).toBe(1);
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
