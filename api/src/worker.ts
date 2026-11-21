import {
  BadRequest, canonicalEventQuery, canonicalFilters, listDays, listEvents, parseEventQuery, parseFilters, type DataWindow,
} from './events';
import { handleAccount, isAccountPath } from './auth';
import { FEEDBACK_PATH, handleFeedback, type FeedbackEnv } from './feedback';
import { guessRegion } from './geo';

import { getMeta, readState, type DataState } from './meta';
import { latestVoices, listVoices, RawJson, readVoicesState, type VoicesState } from './voices';

export interface Env extends FeedbackEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** Workers Rate Limiting bindings (uncached requests only); absent locally, where nothing is limited. */
  API_LIMIT?: RateLimit;
  API_BREAKER?: RateLimit;
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
// Last good data state per kind, kept in the colo cache so a cold isolate can still find cached answers while D1 fails.
// Events and voices have separate versions (site_meta 'state' / voice_meta 'version'), bumped by their own importers.
type StateKind = 'events' | 'voices';
type AnyState = DataState | VoicesState;
const STATES: Record<StateKind, { path: string; read: (db: D1Database) => Promise<AnyState | null> }> = {
  events: { path: '/api/__state', read: readState },
  voices: { path: '/api/__state/voices', read: readVoicesState },
};
const STATE_EDGE_TTL = 7 * 86_400;
// After a failed D1 read, wait this long before trying D1 again for the data version.
export const STATE_RETRY_MS = 5_000;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body instanceof RawJson ? body.text : JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

interface Parsed {
  outside?: boolean;
}

interface Route {
  /** Whose data version keys the cache (default events). */
  state?: StateKind;
  /** Validates the query (throws BadRequest), clamped to the data window. */
  parse(params: URLSearchParams, window: DataWindow | null): Parsed;
  /** Canonical query used in the cache key. */
  key(parsed: Parsed): string;
  run(db: D1Database, parsed: Parsed, state: AnyState | null): Promise<unknown>;
}

const noParams = (p: URLSearchParams): Parsed => {
  for (const k of p.keys()) throw new BadRequest(`unknown parameter: ${k}`);
  return {};
};

type EventQ = ReturnType<typeof parseEventQuery>;
type DaysQ = ReturnType<typeof parseFilters>;

const ROUTES: Record<string, Route> = {
  '/api/v1/events': {
    parse: (p, w) => parseEventQuery(p, w),
    key: (q) => canonicalEventQuery(q as EventQ).toString(),
    run: (db, q, state) => listEvents(db, q as EventQ, (state as DataState | null)?.fetched_at ?? {}),
  },
  '/api/v1/events/days': {
    parse: (p, w) => parseFilters(p, 'days', w),
    key: (q) => canonicalFilters(q as DaysQ).toString(),
    run: (db, q) => listDays(db, q as DaysQ),
  },
  '/api/v1/events/meta': {
    parse: noParams,
    key: () => '',
    run: (db) => getMeta(db),
  },
  '/api/v1/voices': {
    state: 'voices',
    parse: noParams,
    key: () => '',
    run: (db, _q, state) => listVoices(db, state as VoicesState | null),
  },
  '/api/v1/voices/latest': {
    state: 'voices',
    parse: noParams,
    key: () => '',
    run: (db, _q, state) => latestVoices(db, state as VoicesState | null),
  },
};

function edgeCache(): Cache | null {
  return typeof caches !== 'undefined' && caches.default ? caches.default : null;
}

// Per database object and state kind, so the events and voices versions never mix.
const stateMemos = new WeakMap<D1Database, Map<StateKind, { at: number; state: AnyState | null }>>();
const stateFails = new WeakMap<D1Database, Map<StateKind, number>>();
const perDb = <T>(m: WeakMap<D1Database, Map<StateKind, T>>, db: D1Database) => {
  let x = m.get(db);
  if (!x) m.set(db, (x = new Map()));
  return x;
};

/**
 * The data version of one kind. With the Cache API it is memoized per isolate for STATE_TTL_MS and, when D1 fails,
 * the last known state (memo, then the colo cache) is used so cached answers keep being served.
 */
async function dataState(kind: StateKind, db: D1Database, cache: Cache | null, origin: string, ctx?: ExecutionContext): Promise<AnyState | null> {
  const { path, read } = STATES[kind];
  if (!cache) return read(db);
  const stateMemo = perDb(stateMemos, db);
  const stateFailedAt = perDb(stateFails, db);
  const memo = stateMemo.get(kind);
  if (memo && Date.now() - memo.at < STATE_TTL_MS) return memo.state;
  const stateKey = new Request(`${origin}${path}`, { method: 'GET' });
  if (!memo && Date.now() - (stateFailedAt.get(kind) ?? 0) < STATE_RETRY_MS) {
    const hit = await cache.match(stateKey);
    if (hit) return (await hit.json()) as AnyState;
    throw new Error('D1 unavailable (retrying shortly)');
  }
  try {
    const state = await read(db);
    stateMemo.set(kind, { at: Date.now(), state });
    if (state) {
      const put = cache.put(stateKey, json(state, 200, { 'cache-control': `public, max-age=${STATE_EDGE_TTL}` }));
      if (ctx) ctx.waitUntil(put);
      else await put;
    }
    return state;
  } catch (e) {
    console.error(e);
    stateFailedAt.set(kind, Date.now());
    // Keep using the last known version; try D1 again after STATE_RETRY_MS rather than on every request.
    const retryAt = Date.now() - STATE_TTL_MS + STATE_RETRY_MS;
    if (memo) {
      stateMemo.set(kind, { at: retryAt, state: memo.state });
      return memo.state;
    }
    const hit = await cache.match(stateKey);
    if (!hit) throw e;
    const state = (await hit.json()) as AnyState;
    stateMemo.set(kind, { at: retryAt, state });
    return state;
  }
}

/** IPv4 as is; IPv6 by its /64, the block one subscriber usually holds. */
export function clientKey(ip: string | null): string {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  if (env.API_LIMIT && !(await env.API_LIMIT.limit({ key: clientKey(request.headers.get('cf-connecting-ip')) })).success) {
    return json({ error: 'too many requests' }, 429, { 'retry-after': '60' });
  }
  if (env.API_BREAKER && !(await env.API_BREAKER.limit({ key: 'all' })).success) {
    return json({ error: 'busy' }, 503, { 'retry-after': '60' });
  }
  return null;
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
  // Before ROUTES (GET-only) and before any Cache API use: account answers are per user and never cached.
  if (isAccountPath(url.pathname)) return handleAccount(request, env, url, clientKey(request.headers.get('cf-connecting-ip')));
  if (url.pathname === FEEDBACK_PATH) return handleFeedback(request, env, url, clientKey(request.headers.get('cf-connecting-ip')));
  if (url.pathname === '/api/v1/geo' && request.method === 'GET') return json(guessRegion(request), 200, { 'cache-control': 'private, no-store' });
  const route = ROUTES[url.pathname];
  if (!route) return json({ error: 'not found' }, 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
  const head = request.method === 'HEAD';
  const cache = edgeCache();
  let res: Response;
  try {
    const state = await dataState(route.state ?? 'events', env.DB, cache, url.origin, ctx);
    const parsed = route.parse(url.searchParams, (state as DataState | null)?.window ?? null);
    // Nothing is cached before the first import (no version) or for ranges outside the data (no D1 read).
    const key = cache && state && !parsed.outside ? cacheKey(url.origin, url.pathname, state.version, route.key(parsed)) : null;
    const hit = key ? await cache!.match(key) : undefined;
    if (hit) return withHeaders(hit, { 'cache-control': BROWSER_CACHE, 'x-edge-cache': 'hit' }, !head, ['age']);
    // Only misses reach D1, so only misses count: per client, then for the whole location (a breaker).
    if (!parsed.outside) {
      const limited = await rateLimited(request, env);
      if (limited) return head ? withHeaders(limited, {}, false) : limited;
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
