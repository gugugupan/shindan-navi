import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { b64url, b64urlDecode, safeReturn, sessionHash, validateIdToken } from '../src/auth';
import { readBaseConfig, remoteConfig } from '../scripts/remote-config.mjs';
import { newDb } from './helpers';
import type { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';

const ORIGIN = 'https://shindan-navi.app';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const SECRETS = { GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret', SESSION_SECRET: 'x'.repeat(64) };
const STAR = (n: number) => `i${n.toString(16).padStart(10, '0')}`;

let raw: SqliteD1;
let queries: number;
let env: Record<string, unknown>;
let cacheSpy: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
let google: { claims: Record<string, unknown>; requests: URLSearchParams[]; status: number };

function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  return `${part({ alg: 'RS256', kid: 'k' })}.${part(claims)}.c2ln`;
}

beforeEach(() => {
  raw = newDb();
  queries = 0;
  const db = new Proxy(raw, {
    get(target, prop, recv) {
      if (prop === 'prepare') queries++;
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  env = { DB: db, SITE_ORIGIN: ORIGIN, ...SECRETS };
  cacheSpy = { match: vi.fn(), put: vi.fn() };
  vi.stubGlobal('caches', { default: cacheSpy });
  google = { claims: {}, requests: [], status: 200 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://oauth2.googleapis.com/token');
    google.requests.push(new URLSearchParams(init.body as URLSearchParams));
    return new Response(JSON.stringify({ id_token: idToken(google.claims), access_token: 'unused' }), { status: google.status });
  }));
});

afterEach(() => {
  expect(cacheSpy.match).not.toHaveBeenCalled();
  expect(cacheSpy.put).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Res = Omit<Response, 'json'> & { json(): Promise<any> };

async function call(path: string, init: RequestInit & { cookies?: string } = {}, e = env): Promise<Res> {
  const headers = new Headers(init.headers);
  if (init.cookies) headers.set('cookie', init.cookies);
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), e as any);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  return res;
}

const send = (path: string, method: string, body?: unknown, cookies?: string) =>
  call(path, { method, cookies, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** name=value pairs of the Set-Cookie headers, for sending back. */
const jar = (res: Res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
const setCookie = (res: Res, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

function oauthState(res: Res) {
  const value = setCookie(res, '__Host-sn_oauth')!.split(';')[0].split('=')[1];
  return JSON.parse(new TextDecoder().decode(b64urlDecode(value.slice(0, value.lastIndexOf('.')))));
}

const claimsFor = (nonce: string, extra: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: 'google-sub-1', email: 'a@example.invalid', email_verified: true, name: 'Test User', picture: 'https://lh3.googleusercontent.com/a/x', iat: now, exp: now + 3600, nonce, ...extra };
};

/** Full login; returns the callback response. */
async function login(opts: { ret?: string; claims?: Record<string, unknown> } = {}): Promise<Res> {
  const start = await call(`/api/v1/auth/google/start${opts.ret ? `?return=${encodeURIComponent(opts.ret)}` : ''}`);
  const st = oauthState(start);
  google.claims = claimsFor(st.n, opts.claims);
  return call(`/api/v1/auth/google/callback?state=${st.s}&code=auth-code`, { cookies: jar(start) });
}

async function loggedIn(claims?: Record<string, unknown>): Promise<string> {
  const res = await login({ claims });
  expect(setCookie(res, '__Host-sn_session')).toBeTruthy();
  return jar(res);
}

const count = (sql: string) => (raw.db.prepare(sql).get() as { n: number }).n;

describe('dark until enabled', () => {
  const paths: Array<[string, string]> = [
    ['GET', '/api/v1/auth/google/start'], ['GET', '/api/v1/auth/google/callback'], ['POST', '/api/v1/auth/logout'],
    ['GET', '/api/v1/me'], ['DELETE', '/api/v1/me'], ['GET', '/api/v1/me/prefs'], ['PUT', '/api/v1/me/prefs'],
    ['POST', '/api/v1/me/prefs/merge'], ['POST', '/api/v1/billing/webhook'],
  ];
  it('answers 404 on every account route while a secret is missing', async () => {
    for (const k of Object.keys(SECRETS)) {
      const e = { ...env, [k]: undefined };
      for (const [method, path] of paths) {
        const res = await call(path, { method }, e);
        expect([path, res.status, await res.json()]).toEqual([path, 404, { error: 'auth disabled' }]);
      }
    }
    expect(queries).toBe(0);
  });
  it('answers 404 on another origin (preview URLs, wrangler dev)', async () => {
    const res = await worker.fetch(new Request('https://x.workers.dev/api/v1/me'), env as any);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
  it('the committed config sets SITE_ORIGIN and AUTH_LIMIT, and remote-config keeps them', () => {
    const c = remoteConfig('12345678-90ab-4cde-8f01-23456789abcd', { base: readBaseConfig() });
    expect(c.vars).toEqual({ SITE_ORIGIN: ORIGIN });
    expect(c.ratelimits.find((r: any) => r.name === 'AUTH_LIMIT')).toMatchObject({ simple: { limit: 30, period: 60 } });
    expect(new Set(c.ratelimits.map((r: any) => r.namespace_id)).size).toBe(c.ratelimits.length);
  });
});

describe('login start', () => {
  it('redirects to Google with state, PKCE S256 and nonce in a signed short-lived cookie', async () => {
    const res = await call('/api/v1/auth/google/start?return=/events/?pref=JP-13');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const st = oauthState(res);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({
      client_id: CLIENT_ID, redirect_uri: `${ORIGIN}/api/v1/auth/google/callback`, response_type: 'code', scope: 'openid email profile',
      state: st.s, nonce: st.n, code_challenge_method: 'S256',
    });
    expect(loc.searchParams.has('access_type')).toBe(false);
    expect(loc.searchParams.get('code_challenge')).toBe(createHash('sha256').update(st.v).digest('base64url'));
    expect(st.r).toBe('/events/?pref=JP-13');
    expect(setCookie(res, '__Host-sn_oauth')).toMatch(/; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    expect(queries).toBe(0);
  });
  it('accepts only same-origin relative return paths', () => {
    for (const bad of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'evil', '/a\nb', '/a\u0000', `/${'a'.repeat(512)}`, '/api/v1/me', '/api', '', null]) {
      expect(safeReturn(bad, ORIGIN)).toBe('/');
    }
    expect(safeReturn('/pokemon/', ORIGIN)).toBe('/pokemon/');
    expect(safeReturn('/events/?pref=JP-13#x', ORIGIN)).toBe('/events/?pref=JP-13#x');
    expect(safeReturn('/a/../api/v1/me', ORIGIN)).toBe('/');
  });
});

describe('login callback', () => {
  it('creates the user, identity and a hashed session; sets both cookies and returns to the path', async () => {
    const res = await login({ ret: '/pokemon/' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/pokemon/`);
    expect(setCookie(res, '__Host-sn_session')).toMatch(/; Max-Age=15552000; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    expect(setCookie(res, '__Host-sn_user')).toBe('__Host-sn_user=1; Max-Age=15552000; Path=/; Secure; SameSite=Lax');
    expect(setCookie(res, '__Host-sn_oauth')).toMatch(/^__Host-sn_oauth=; Max-Age=0;/);
    const sent = google.requests[0];
    expect(sent.get('client_secret')).toBe('client-secret');
    expect(sent.get('redirect_uri')).toBe(`${ORIGIN}/api/v1/auth/google/callback`);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sid = setCookie(res, '__Host-sn_session')!.split(';')[0].split('=')[1].split('.')[0];
    expect(raw.db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: await sessionHash(sid) }]);
    expect(raw.db.prepare('SELECT display_name, avatar_url, plan FROM users').all()).toEqual([{ display_name: 'Test User', avatar_url: 'https://lh3.googleusercontent.com/a/x', plan: 'free' }]);
    expect(raw.db.prepare('SELECT provider, subject, email FROM user_identities').all()).toEqual([{ provider: 'google', subject: 'google-sub-1', email: 'a@example.invalid' }]);
  });
  it('reuses the account for the same sub, never links by email, and drops expired sessions', async () => {
    await loggedIn();
    raw.db.prepare('UPDATE sessions SET expires_at = 1').run();
    await loggedIn({ name: 'Renamed' });
    expect(count('SELECT COUNT(*) AS n FROM users')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM sessions')).toBe(1);
    expect(raw.db.prepare('SELECT display_name FROM users').get()).toEqual({ display_name: 'Renamed' });
    await loggedIn({ sub: 'google-sub-2' });
    expect(count('SELECT COUNT(*) AS n FROM users')).toBe(2);
  });
  it('refuses a wrong, missing, forged or expired state without calling Google', async () => {
    const start = await call('/api/v1/auth/google/start?return=/pokemon/');
    const st = oauthState(start);
    const cookie = jar(start);
    const [name, value] = cookie.split('=');
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ ...st, r: '/x' })));
    const cases = [
      { q: `state=wrong&code=c`, cookies: cookie },
      { q: `state=${st.s}&code=c`, cookies: undefined },
      { q: `state=${st.s}&code=c`, cookies: `${name}=${forged}.${value.split('.')[1]}` },
      { q: `state=${st.s}&code=c`, cookies: `${name}=${value.slice(0, -2)}xx` },
    ];
    for (const c of cases) {
      const res = await call(`/api/v1/auth/google/callback?${c.q}`, { cookies: c.cookies });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
      expect(setCookie(res, '__Host-sn_session')).toBeUndefined();
    }
    vi.useFakeTimers({ now: Date.now() + 601_000, toFake: ['Date'] });
    const late = await call(`/api/v1/auth/google/callback?state=${st.s}&code=c`, { cookies: cookie });
    vi.useRealTimers();
    expect(setCookie(late, '__Host-sn_session')).toBeUndefined();
    expect(google.requests).toHaveLength(0);
    expect(count('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });
  it('returns without a session when the user cancels or the token endpoint fails', async () => {
    const start = await call('/api/v1/auth/google/start?return=/pokemon/');
    const st = oauthState(start);
    const cancelled = await call(`/api/v1/auth/google/callback?state=${st.s}&error=access_denied`, { cookies: jar(start) });
    expect(cancelled.headers.get('location')).toBe(`${ORIGIN}/pokemon/`);
    expect(setCookie(cancelled, '__Host-sn_session')).toBeUndefined();
    google.status = 400;
    const failed = await call(`/api/v1/auth/google/callback?state=${st.s}&code=c`, { cookies: jar(start) });
    expect(failed.headers.get('location')).toBe(`${ORIGIN}/pokemon/`);
    expect(setCookie(failed, '__Host-sn_session')).toBeUndefined();
  });
  it('rejects id_token claims: aud, azp, iss, exp, iat, nonce, email_verified', async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad: Array<[string, Record<string, unknown>]> = [
      ['aud', { aud: 'other-client' }], ['azp', { aud: [CLIENT_ID, 'other'], azp: 'other' }], ['azp', { azp: 'other' }],
      ['iss', { iss: 'https://evil.example' }], ['exp', { exp: now - 1 }], ['exp', { exp: undefined }],
      ['iat', { iat: now + 3600 }], ['nonce', { nonce: 'other-nonce' }], ['email_verified', { email_verified: false }],
      ['email_verified', { email_verified: undefined }], ['sub', { sub: '' }],
    ];
    for (const [what, extra] of bad) expect(() => validateIdToken(idToken(claimsFor('n0', extra)), CLIENT_ID, 'n0', now), what).toThrow(what);
    expect(validateIdToken(idToken(claimsFor('n0', { iss: 'accounts.google.com' })), CLIENT_ID, 'n0', now).sub).toBe('google-sub-1');
    for (const [, extra] of bad.slice(0, 3)) {
      const res = await login({ claims: extra });
      expect(setCookie(res, '__Host-sn_session')).toBeUndefined();
    }
    const res = await login({ claims: { nonce: 'replayed' } });
    expect(setCookie(res, '__Host-sn_session')).toBeUndefined();
    expect(count('SELECT COUNT(*) AS n FROM users')).toBe(0);
  });
});

describe('/me and sessions', () => {
  it('401 without a session; the user summary with one', async () => {
    const anon = await call('/api/v1/me');
    expect([anon.status, await anon.json()]).toEqual([401, { error: 'unauthenticated' }]);
    expect(setCookie(anon, '__Host-sn_user')).toMatch(/^__Host-sn_user=; Max-Age=0;/);
    const cookies = await loggedIn();
    queries = 0;
    const res = await call('/api/v1/me', { cookies });
    const body = await res.json();
    expect(body).toEqual({ user: { id: expect.any(String), display_name: 'Test User', avatar_url: 'https://lh3.googleusercontent.com/a/x', plan: 'free' } });
    expect(Object.keys(body.user)).toEqual(['id', 'display_name', 'avatar_url', 'plan']);
    expect(queries).toBe(1);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
  it('a tampered or expired session cookie is 401; tampering costs no D1 read', async () => {
    const cookies = await loggedIn();
    const session = cookies.split('; ').find((c) => c.startsWith('__Host-sn_session='))!;
    const [sid, mac] = session.split('=')[1].split('.');
    queries = 0;
    for (const forged of [`${sid}x.${mac}`, `${sid}.${mac.slice(0, -2)}AA`, sid, `${sid}.`, '']) {
      expect((await call('/api/v1/me', { cookies: `__Host-sn_session=${forged}` })).status).toBe(401);
    }
    expect(queries).toBe(0);
    raw.db.prepare('UPDATE sessions SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
    expect((await call('/api/v1/me', { cookies })).status).toBe(401);
  });
  it('logout deletes the session and clears both cookies', async () => {
    const cookies = await loggedIn();
    const res = await send('/api/v1/auth/logout', 'POST', undefined, cookies);
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().map((c) => c.split(';')[0]).sort()).toEqual(['__Host-sn_session=', '__Host-sn_user=']);
    expect(count('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
    expect((await call('/api/v1/me', { cookies })).status).toBe(401);
  });
});

describe('CSRF', () => {
  it('rejects non-GET without the site Origin or without a JSON content type', async () => {
    const cookies = await loggedIn();
    const routes: Array<[string, string]> = [['PUT', '/api/v1/me/prefs'], ['POST', '/api/v1/me/prefs/merge'], ['DELETE', '/api/v1/me'], ['POST', '/api/v1/auth/logout']];
    for (const [method, path] of routes) {
      const body = method === 'DELETE' ? undefined : '{}';
      const noOrigin = await call(path, { method, cookies, headers: { 'content-type': 'application/json' }, body });
      const evil = await call(path, { method, cookies, headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body });
      const form = await call(path, { method, cookies, headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body });
      expect([noOrigin.status, evil.status, form.status]).toEqual([403, 403, 415]);
      expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(count('SELECT COUNT(*) AS n FROM sessions')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM users')).toBe(1);
  });
});

describe('prefs', () => {
  it('PUT applies star add/remove server-side and replaces the other keys', async () => {
    const cookies = await loggedIn();
    expect(await (await call('/api/v1/me/prefs', { cookies })).json()).toEqual({ prefs: {}, updated_at: {} });
    let res = await send('/api/v1/me/prefs', 'PUT', { stars: { add: [STAR(1), STAR(2), STAR(3)] }, event_filters: { pref: 'JP-13', game: 'OPCG' }, ask_calendar: 'off' }, cookies);
    expect(res.status).toBe(200);
    res = await send('/api/v1/me/prefs', 'PUT', { stars: { add: [STAR(4), STAR(1)], remove: [STAR(2)] }, event_filters: { pref: 'JP-27' } }, cookies);
    const body = await res.json();
    expect(body.prefs).toEqual({ stars: [STAR(1), STAR(3), STAR(4)], event_filters: { pref: 'JP-27' }, ask_calendar: 'off' });
    expect(Object.keys(body.updated_at).sort()).toEqual(['ask_calendar', 'event_filters', 'stars']);
    expect(await (await call('/api/v1/me/prefs', { cookies })).json()).toEqual(body);
    res = await send('/api/v1/me/prefs', 'PUT', { event_filters: null }, cookies);
    expect((await res.json()).prefs).toEqual({ stars: [STAR(1), STAR(3), STAR(4)], ask_calendar: 'off' });
  });
  it('writes only keys whose value changed', async () => {
    const cookies = await loggedIn();
    await send('/api/v1/me/prefs', 'PUT', { ask_calendar: true }, cookies);
    const before = raw.db.prepare('SELECT updated_at FROM user_prefs').get();
    await new Promise((r) => setTimeout(r, 5));
    await send('/api/v1/me/prefs', 'PUT', { ask_calendar: true, stars: { remove: [STAR(9)] } }, cookies);
    expect(raw.db.prepare('SELECT key, updated_at FROM user_prefs').all()).toEqual([{ key: 'ask_calendar', ...(before as object) }, { key: 'stars', updated_at: expect.any(String) }]);
  });
  it('validates values and sizes; nothing is written on error', async () => {
    const cookies = await loggedIn();
    const many = (n: number) => Array.from({ length: n }, (_, i) => STAR(i));
    await send('/api/v1/me/prefs', 'PUT', { stars: { add: many(1999) } }, cookies);
    const bad: unknown[] = [
      { stars: { add: ['2026-01-01|name'] } }, { stars: [STAR(1)] }, { stars: { add: [STAR(5000), STAR(5001)] } },
      { stars: { add: many(2001) } }, { event_filters: { pref: 13 } }, { event_filters: { q: 'x' } },
      { event_filters: { type: 'a'.repeat(1100) } }, { event_filters: ['x'] }, { ask_calendar: 'maybe' }, { theme: 'dark' }, [],
    ];
    for (const b of bad) expect((await send('/api/v1/me/prefs', 'PUT', b, cookies)).status, JSON.stringify(b).slice(0, 80)).toBe(400);
    expect((await send('/api/v1/me/prefs', 'PUT', { event_filters: { type: 'a'.repeat(70_000) } }, cookies)).status).toBe(413);
    const broken = await call('/api/v1/me/prefs', { method: 'PUT', cookies, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{' });
    expect(broken.status).toBe(400);
    expect(((await (await call('/api/v1/me/prefs', { cookies })).json()).prefs.stars).length).toBe(1999);
    expect(count('SELECT COUNT(*) AS n FROM user_prefs')).toBe(1);
  });
  it('merge: stars union (server first), server filters and ask_calendar win when present', async () => {
    const cookies = await loggedIn();
    let res = await send('/api/v1/me/prefs/merge', 'POST', { stars: [STAR(2), STAR(1)], event_filters: { pref: 'JP-13' } }, cookies);
    expect((await res.json()).prefs).toEqual({ stars: [STAR(2), STAR(1)], event_filters: { pref: 'JP-13' } });
    res = await send('/api/v1/me/prefs/merge', 'POST', { stars: [STAR(3), STAR(1)], event_filters: { pref: 'JP-27' }, ask_calendar: 'off' }, cookies);
    expect((await res.json()).prefs).toEqual({ stars: [STAR(2), STAR(1), STAR(3)], event_filters: { pref: 'JP-13' }, ask_calendar: 'off' });
    res = await send('/api/v1/me/prefs/merge', 'POST', { stars: [], ask_calendar: true }, cookies);
    expect((await res.json()).prefs.ask_calendar).toBe('off');
    const all = Array.from({ length: 2000 }, (_, i) => STAR(100 + i));
    res = await send('/api/v1/me/prefs/merge', 'POST', { stars: all }, cookies);
    const stars = (await res.json()).prefs.stars;
    expect(stars).toHaveLength(2000);
    expect(stars.slice(0, 3)).toEqual([STAR(2), STAR(1), STAR(3)]);
    expect((await send('/api/v1/me/prefs/merge', 'POST', { stars: ['bad'] }, cookies)).status).toBe(400);
  });
  it('needs a session', async () => {
    expect((await call('/api/v1/me/prefs')).status).toBe(401);
    expect((await send('/api/v1/me/prefs', 'PUT', { ask_calendar: true })).status).toBe(401);
    expect((await send('/api/v1/me/prefs/merge', 'POST', { stars: [] })).status).toBe(401);
  });
});

describe('account deletion', () => {
  it('DELETE /me removes every row of the user and nobody else', async () => {
    const other = await loggedIn({ sub: 'other-sub' });
    await send('/api/v1/me/prefs', 'PUT', { ask_calendar: true }, other);
    const cookies = await loggedIn();
    await send('/api/v1/me/prefs', 'PUT', { stars: { add: [STAR(1)] }, ask_calendar: 'off' }, cookies);
    const { user } = await (await call('/api/v1/me', { cookies })).json();
    raw.db.prepare("INSERT INTO entitlements (user_id, feature, source, starts_at) VALUES (?, 'x', 'test', '2026-01-01')").run(user.id);
    raw.db.prepare("INSERT INTO billing_customers (user_id, provider, customer_id) VALUES (?, 'stripe', 'cus_test')").run(user.id);
    const res = await send('/api/v1/me', 'DELETE', undefined, cookies);
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().map((c) => c.split(';')[0]).sort()).toEqual(['__Host-sn_session=', '__Host-sn_user=']);
    for (const t of ['users', 'user_identities', 'sessions', 'user_prefs']) expect(count(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(1);
    for (const t of ['entitlements', 'billing_customers']) expect(count(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    expect((await call('/api/v1/me', { cookies })).status).toBe(401);
    expect((await call('/api/v1/me', { cookies: other })).status).toBe(200);
  });
});

describe('limits and misc', () => {
  it('rate-limits login by client IP and writes by user, not GET /me', async () => {
    const keys: string[] = [];
    let allow = true;
    env.AUTH_LIMIT = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: allow }; } };
    const cookies = await loggedIn();
    await send('/api/v1/me/prefs', 'PUT', { ask_calendar: true }, cookies);
    await call('/api/v1/me', { cookies });
    expect(keys.map((k) => k.split(':')[0])).toEqual(['ip', 'ip', 'user']);
    allow = false;
    const res = await call('/api/v1/auth/google/start', { headers: { 'cf-connecting-ip': '2001:db8:1:2:3:4:5:6' } });
    expect([res.status, res.headers.get('retry-after')]).toEqual([429, '60']);
    expect(keys.at(-1)).toBe('ip:2001:db8:1:2::/64');
    expect((await send('/api/v1/me/prefs', 'PUT', { ask_calendar: false }, cookies)).status).toBe(429);
    expect((await call('/api/v1/me', { cookies })).status).toBe(200);
  });
  it('billing webhook is a 501 placeholder; unknown routes 404, wrong methods 405', async () => {
    expect((await call('/api/v1/billing/webhook', { method: 'POST' })).status).toBe(501);
    expect((await call('/api/v1/me/other')).status).toBe(404);
    expect((await call('/api/v1/me/prefs', { method: 'POST' })).status).toBe(405);
    expect((await call('/api/v1/auth/google/start', { method: 'POST' })).status).toBe(405);
  });
  it('the Worker bundle has no dev login', async () => {
    const out = await build({ entryPoints: [join(__dirname, '../src/index.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' });
    const code = out.outputFiles[0].text;
    expect(code).toContain('/api/v1/auth/google/callback');
    expect(code).not.toMatch(/__dev|dev-login|devLogin/);
  });
});
