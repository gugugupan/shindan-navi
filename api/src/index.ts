import { BadRequest, listDays, listEvents } from './events';
import { guessRegion } from './geo';
import { getMeta } from './meta';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
};

// Edge copies live in the colo's Cache API; browsers revalidate sooner so a fresh import shows up
// within EDGE_TTL + BROWSER_TTL at most. Local runs (no Cache API) keep `no-store`.
export const EDGE_TTL = 600;
export const BROWSER_TTL = 60;
const BROWSER_CACHE = `public, max-age=${BROWSER_TTL}`;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

const ROUTES: Record<string, (db: D1Database, params: URLSearchParams) => Promise<unknown>> = {
  '/api/v1/events': listEvents,
  '/api/v1/events/days': listDays,
  '/api/v1/events/meta': (db) => getMeta(db),
};

function edgeCache(): Cache | null {
  return typeof caches !== 'undefined' && caches.default ? caches.default : null;
}

/** Same query in any parameter order shares one cache entry; host, path and values stay as sent. */
export function cacheKey(url: URL): Request {
  const key = new URL(url);
  key.hash = '';
  key.searchParams.sort();
  return new Request(key.toString(), { method: 'GET' });
}

function withHeaders(res: Response, headers: Record<string, string>, body = true): Response {
  const out = new Response(body ? res.body : null, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

async function query(handler: (typeof ROUTES)[string], env: Env, url: URL): Promise<Response> {
  try {
    return json(await handler(env.DB, url.searchParams));
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: 'internal error' }, 500);
  }
}

async function handleApi(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  if (url.pathname === '/api/v1/geo' && request.method === 'GET') return json(guessRegion(request), 200, { 'cache-control': 'private, no-store' });
  const handler = ROUTES[url.pathname];
  if (!handler) return json({ error: 'not found' }, 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
  const head = request.method === 'HEAD';
  const cache = edgeCache();
  if (!cache) {
    const res = await query(handler, env, url);
    return head ? withHeaders(res, {}, false) : res;
  }
  const key = cacheKey(url);
  const hit = await cache.match(key);
  if (hit) return withHeaders(hit, { 'cache-control': BROWSER_CACHE, 'x-edge-cache': 'hit' }, !head);
  const res = await query(handler, env, url);
  if (res.status !== 200) return withHeaders(res, { 'x-edge-cache': 'miss' }, !head);
  const stored = cache.put(key, withHeaders(res.clone(), { 'cache-control': `public, max-age=${EDGE_TTL}` }));
  if (ctx) ctx.waitUntil(stored);
  else await stored;
  return withHeaders(res, { 'cache-control': BROWSER_CACHE, 'x-edge-cache': 'miss' }, !head);
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, url, ctx);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
