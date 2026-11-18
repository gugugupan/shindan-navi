import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { BROWSER_TTL, cacheKey, EDGE_TTL } from '../src/index';
import { importDir, newDb, synthetic, writeDataDir } from './helpers';
import type { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';

/** In-memory stand-in for caches.default (keyed by URL, GET only, like the Workers Cache API). */
class FakeCache {
  store = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();
  puts: Array<{ url: string; cacheControl: string | null }> = [];
  async match(req: Request) {
    const hit = this.store.get(req.url);
    return hit ? new Response(hit.body.slice(0), hit.init) : undefined;
  }
  async put(req: Request, res: Response) {
    this.puts.push({ url: req.url, cacheControl: res.headers.get('cache-control') });
    this.store.set(req.url, { body: await res.arrayBuffer(), init: { status: res.status, headers: res.headers } });
  }
}

let db: SqliteD1;
let cache: FakeCache;
let queries: number;

beforeAll(() => {
  db = newDb();
  importDir(db, writeDataDir(synthetic(80)));
});

beforeEach(() => {
  cache = new FakeCache();
  vi.stubGlobal('caches', { default: cache });
  queries = 0;
});

afterEach(() => vi.unstubAllGlobals());

async function call(path: string, method = 'GET', ctx?: ExecutionContext) {
  const counting = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'batch') queries++;
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const res = await worker.fetch(new Request(`https://shindan-navi.app${path}`, { method }), { DB: counting as unknown as D1Database }, ctx);
  return { res, text: await res.text() };
}

const EVENTS = '/api/v1/events?from=2026-11-18&until=2027-01-01&game=OPCG';

describe('edge cache', () => {
  it('serves a repeated GET from the cache without touching D1', async () => {
    const a = await call(EVENTS);
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get('x-edge-cache')).toBe('miss');
    expect(a.res.headers.get('cache-control')).toBe(`public, max-age=${BROWSER_TTL}`);
    expect(cache.puts).toEqual([{ url: cacheKey(new URL(`https://shindan-navi.app${EVENTS}`)).url, cacheControl: `public, max-age=${EDGE_TTL}` }]);
    const b = await call(EVENTS);
    expect(b.res.headers.get('x-edge-cache')).toBe('hit');
    expect(b.res.headers.get('cache-control')).toBe(`public, max-age=${BROWSER_TTL}`);
    expect(b.text).toBe(a.text);
    expect(queries).toBe(1);
  });

  it('shares one entry across parameter order', async () => {
    await call('/api/v1/events/days?until=2027-01-01&game=OPCG&from=2026-11-18');
    const b = await call('/api/v1/events/days?from=2026-11-18&game=OPCG&until=2027-01-01');
    expect(b.res.headers.get('x-edge-cache')).toBe('hit');
    expect(queries).toBe(1);
  });

  it('keeps different queries apart', async () => {
    await call(EVENTS);
    const b = await call(EVENTS.replace('OPCG', 'PTCG'));
    expect(b.res.headers.get('x-edge-cache')).toBe('miss');
    expect(queries).toBe(2);
  });

  it('caches meta', async () => {
    await call('/api/v1/events/meta');
    expect((await call('/api/v1/events/meta')).res.headers.get('x-edge-cache')).toBe('hit');
    expect(queries).toBe(1);
  });

  it('does not cache errors', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await call('/api/v1/events?from=2026-11-18');
      expect(r.res.status).toBe(400);
      expect(r.res.headers.get('cache-control')).toBe('no-store');
    }
    expect((await call('/api/v1/nope')).res.status).toBe(404);
    expect(cache.puts).toEqual([]);
  });

  it('does not cache 5xx', async () => {
    const broken = { batch: async () => { throw new Error('boom'); } } as unknown as D1Database;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(new Request(`https://shindan-navi.app${EVENTS}`), { DB: broken });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(cache.puts).toEqual([]);
  });

  it('never caches geo', async () => {
    const r = await call('/api/v1/geo');
    expect(r.res.headers.get('cache-control')).toBe('private, no-store');
    expect(cache.puts).toEqual([]);
  });

  it('answers HEAD from the same entry without a body', async () => {
    await call(EVENTS);
    const h = await call(EVENTS, 'HEAD');
    expect(h.res.status).toBe(200);
    expect(h.res.headers.get('x-edge-cache')).toBe('hit');
    expect(h.text).toBe('');
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
