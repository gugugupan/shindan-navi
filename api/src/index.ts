import { BadRequest, canonicalEventQuery, canonicalFilters, DAYS_PARAMS, listDays, listEvents, parseEventQuery, parseFilters } from './events';
import { guessRegion } from './geo';
import { getMeta, readState, type DataState } from './meta';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
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

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

interface Route {
  /** Validates the query (throws BadRequest) and returns the canonical query used in the cache key. */
  key(params: URLSearchParams): string;
  run(db: D1Database, params: URLSearchParams, state: DataState | null): Promise<unknown>;
}

const ROUTES: Record<string, Route> = {
  '/api/v1/events': {
    key: (p) => canonicalEventQuery(parseEventQuery(p)).toString(),
    run: (db, p, state) => listEvents(db, parseEventQuery(p), state?.fetched_at ?? {}),
  },
  '/api/v1/events/days': {
    key: (p) => canonicalFilters(parseFilters(p, DAYS_PARAMS)).toString(),
    run: (db, p) => listDays(db, parseFilters(p, DAYS_PARAMS)),
  },
  '/api/v1/events/meta': {
    key: (p) => {
      for (const k of p.keys()) throw new BadRequest(`unknown parameter: ${k}`);
      return '';
    },
    run: (db) => getMeta(db),
  },
};

function edgeCache(): Cache | null {
  return typeof caches !== 'undefined' && caches.default ? caches.default : null;
}

const stateMemo = new WeakMap<D1Database, { at: number; state: DataState | null }>();
async function dataState(db: D1Database, memo: boolean): Promise<DataState | null> {
  const hit = memo ? stateMemo.get(db) : undefined;
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.state;
  const state = await readState(db);
  if (memo) stateMemo.set(db, { at: Date.now(), state });
  return state;
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
    const canonical = route.key(url.searchParams);
    const state = await dataState(env.DB, cache !== null);
    // Before the first import there is no version to key on, so nothing is cached.
    const key = cache && state ? cacheKey(url.origin, url.pathname, state.version, canonical) : null;
    const hit = key ? await cache!.match(key) : undefined;
    if (hit) return withHeaders(hit, { 'cache-control': BROWSER_CACHE, 'x-edge-cache': 'hit' }, !head, ['age']);
    res = json(await route.run(env.DB, url.searchParams, state));
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
