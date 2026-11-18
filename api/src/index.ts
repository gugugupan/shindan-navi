import {
  BadRequest, canonicalEventQuery, canonicalFilters, DAYS_PARAMS, listDays, listEvents, parseEventQuery, parseFilters, type DataWindow,
} from './events';
import { guessRegion } from './geo';
import { getMeta, readState, type DataState } from './meta';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** Workers Rate Limiting binding; absent locally, in which case nothing is limited. */
  API_LIMIT?: RateLimit;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
};

// Data changes only through a manual import, and every import bumps the data version that is part of
// the cache key, so edge copies can live long. Browsers keep a short copy because they cannot see the version.
export const EDGE_TTL = 86_400;
export const BROWSER_TTL = 300;
const BROWSER_CACHE = `public, max-age=${BROWSER_TTL}`;
// How long an isolate trusts its last read of the data version (one D1 row).
export const STATE_TTL_MS = 60_000;
// Last good data state, kept in the colo cache so a cold isolate can still find cached answers while D1 fails.
const STATE_PATH = '/api/__state';
const STATE_EDGE_TTL = 7 * 86_400;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

interface Parsed {
  outside?: boolean;
}

interface Route {
  /** Validates the query (throws BadRequest), clamped to the data window. */
  parse(params: URLSearchParams, window: DataWindow | null): Parsed;
  /** Canonical query used in the cache key. */
  key(parsed: Parsed): string;
  run(db: D1Database, parsed: Parsed, state: DataState | null): Promise<unknown>;
}

type EventQ = ReturnType<typeof parseEventQuery>;
type DaysQ = ReturnType<typeof parseFilters>;

const ROUTES: Record<string, Route> = {
  '/api/v1/events': {
    parse: (p, w) => parseEventQuery(p, w),
    key: (q) => canonicalEventQuery(q as EventQ).toString(),
    run: (db, q, state) => listEvents(db, q as EventQ, state?.fetched_at ?? {}),
  },
  '/api/v1/events/days': {
    parse: (p, w) => parseFilters(p, DAYS_PARAMS, w),
    key: (q) => canonicalFilters(q as DaysQ).toString(),
    run: (db, q) => listDays(db, q as DaysQ),
  },
  '/api/v1/events/meta': {
    parse: (p) => {
      for (const k of p.keys()) throw new BadRequest(`unknown parameter: ${k}`);
      return {};
    },
    key: () => '',
    run: (db) => getMeta(db),
  },
};

function edgeCache(): Cache | null {
  return typeof caches !== 'undefined' && caches.default ? caches.default : null;
}

const stateMemo = new WeakMap<D1Database, { at: number; state: DataState | null }>();

/**
 * The data version. With the Cache API it is memoized per isolate for STATE_TTL_MS and, when D1 fails,
 * the last known state (memo, then the colo cache) is used so cached answers keep being served.
 */
async function dataState(db: D1Database, cache: Cache | null, origin: string, ctx?: ExecutionContext): Promise<DataState | null> {
  if (!cache) return readState(db);
  const memo = stateMemo.get(db);
  if (memo && Date.now() - memo.at < STATE_TTL_MS) return memo.state;
  const stateKey = new Request(`${origin}${STATE_PATH}`, { method: 'GET' });
  try {
    const state = await readState(db);
    stateMemo.set(db, { at: Date.now(), state });
    if (state) {
      const put = cache.put(stateKey, json(state, 200, { 'cache-control': `public, max-age=${STATE_EDGE_TTL}` }));
      if (ctx) ctx.waitUntil(put);
      else await put;
    }
    return state;
  } catch (e) {
    console.error(e);
    if (memo) return memo.state;
    const hit = await cache.match(stateKey);
    if (!hit) throw e;
    const state = (await hit.json()) as DataState;
    stateMemo.set(db, { at: Date.now(), state });
    return state;
  }
}

export function cacheKey(origin: string, path: string, version: string, canonical: string): Request {
  return new Request(`${origin}${path}?v=${encodeURIComponent(version)}${canonical ? `&${canonical}` : ''}`, { method: 'GET' });
}

function withHeaders(res: Response, headers: Record<string, string>, body = true, drop: string[] = []): Response {
  const out = new Response(body ? res.body : null, res);
  for (const k of drop) out.headers.delete(k);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

function failure(e: unknown): Response {
  if (e instanceof BadRequest) return json({ error: e.message }, 400);
  console.error(e);
  return json({ error: 'internal error' }, 500);
}

async function handleApi(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  if (url.pathname === '/api/v1/geo' && request.method === 'GET') return json(guessRegion(request), 200, { 'cache-control': 'private, no-store' });
  const route = ROUTES[url.pathname];
  if (!route) return json({ error: 'not found' }, 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
  const head = request.method === 'HEAD';
  const cache = edgeCache();
  let res: Response;
  try {
    const state = await dataState(env.DB, cache, url.origin, ctx);
    const parsed = route.parse(url.searchParams, state?.window ?? null);
    // Nothing is cached before the first import (no version) or for ranges outside the data (no D1 read).
    const key = cache && state && !parsed.outside ? cacheKey(url.origin, url.pathname, state.version, route.key(parsed)) : null;
    const hit = key ? await cache!.match(key) : undefined;
    if (hit) return withHeaders(hit, { 'cache-control': BROWSER_CACHE, 'x-edge-cache': 'hit' }, !head, ['age']);
    // Only misses reach D1, so only misses count against the per-client limit.
    if (env.API_LIMIT && !parsed.outside) {
      const { success } = await env.API_LIMIT.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' });
      if (!success) {
        const limited = json({ error: 'too many requests' }, 429, { 'retry-after': '60' });
        return head ? withHeaders(limited, {}, false) : limited;
      }
    }
    res = json(await route.run(env.DB, parsed, state));
    if (key) {
      const stored = cache!.put(key, withHeaders(res.clone(), { 'cache-control': `public, max-age=${EDGE_TTL}` }));
      if (ctx) ctx.waitUntil(stored);
      else await stored;
      res = withHeaders(res, { 'cache-control': BROWSER_CACHE, 'x-edge-cache': 'miss' });
    }
  } catch (e) {
    res = failure(e);
  }
  return head ? withHeaders(res, {}, false) : res;
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, url, ctx);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
