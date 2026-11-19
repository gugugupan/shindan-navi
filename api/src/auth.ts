import { applyMerge, applyPut, prefsBody, PrefsError, writePrefs, type PrefRow } from './prefs';

export interface AuthEnv {
  DB: D1Database;
  SITE_ORIGIN?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  /** Workers Rate Limiting bindings; absent locally. Login start/callback per client IP. */
  AUTH_LIMIT?: RateLimit;
  /** PUT/merge prefs and DELETE /me per user: bounds one user's D1 writes (api/README.md › D1 budget). */
  AUTH_WRITE_LIMIT?: RateLimit;
  /** GET /me and /me/prefs per session, checked before the session's D1 read. */
  AUTH_READ_LIMIT?: RateLimit;
}

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
export const CALLBACK_PATH = '/api/v1/auth/google/callback';

export const SESSION_COOKIE = '__Host-sn_session';
export const USER_COOKIE = '__Host-sn_user';
export const OAUTH_COOKIE = '__Host-sn_oauth';
export const SESSION_TTL_S = 180 * 86_400;
export const OAUTH_TTL_S = 600;
export const MAX_BODY_BYTES = 64 * 1024;
/** A login keeps the user's newest sessions up to this many (the new one included) and deletes the rest. */
export const MAX_SESSIONS = 10;
// Allowed clock difference for id_token iat (Google's clock vs the Worker's).
const CLOCK_SKEW_S = 300;

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
};

class HttpError extends Error {
  constructor(public status: number, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

function json(body: unknown, status = 200, cookies: string[] = [], extra: Record<string, string> = {}): Response {
  const res = new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
  if (body === null) res.headers.delete('content-type');
  for (const c of cookies) res.headers.append('set-cookie', c);
  return res;
}

function redirect(location: string, cookies: string[] = []): Response {
  const res = new Response(null, { status: 302, headers: { location, 'cache-control': HEADERS['cache-control'], 'x-robots-tag': 'noindex' } });
  for (const c of cookies) res.headers.append('set-cookie', c);
  return res;
}

// ---- encoding and crypto

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function sessionHash(sid: string): Promise<string> {
  return [...(await sha256(sid))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    hmacKeys.set(secret, k);
  }
  return k;
}

/** `<value>.<HMAC(purpose:value)>`; purpose keeps an oauth cookie from passing as a session and vice versa. */
async function sign(secret: string, purpose: string, value: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${purpose}:${value}`));
  return `${value}.${b64url(mac)}`;
}

async function unsign(secret: string, purpose: string, signed: string | undefined): Promise<string | null> {
  if (!signed || signed.length > 2048) return null;
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  let mac: Uint8Array;
  try {
    mac = b64urlDecode(signed.slice(dot + 1));
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), mac, enc.encode(`${purpose}:${value}`));
  return ok ? value : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---- cookies

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const cookie = (name: string, value: string, maxAge: number, httpOnly = true) =>
  `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure;${httpOnly ? ' HttpOnly;' : ''} SameSite=Lax`;
const clearCookie = (name: string, httpOnly = true) => cookie(name, '', 0, httpOnly);
const CLEAR_SESSION = [clearCookie(SESSION_COOKIE), clearCookie(USER_COOKIE, false)];

// ---- configuration and guards

interface Config {
  origin: string;
  clientId: string;
  clientSecret: string;
  secret: string;
}

function config(env: AuthEnv, url: URL): Config | null {
  const { SITE_ORIGIN: origin, GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret, SESSION_SECRET: secret } = env;
  if (!origin || !clientId || !clientSecret || !secret || url.origin !== origin) return null;
  return { origin, clientId, clientSecret, secret };
}

/** Non-GET: same-origin Origin header and a JSON content type (a cross-site form cannot send either). */
function checkCsrf(request: Request, cfg: Config): void {
  if (request.headers.get('origin') !== cfg.origin) throw new HttpError(403, 'forbidden');
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported media type');
}

async function limit(binding: RateLimit | undefined, key: string): Promise<void> {
  if (binding && !(await binding.limit({ key })).success) throw new HttpError(429, 'too many requests', { 'retry-after': '60' });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (enc.encode(text).length > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

/** Same-origin relative path to go back to after login; anything else falls back to "/". */
export function safeReturn(ret: string | null | undefined, origin: string): string {
  if (!ret || ret.length > 512 || !ret.startsWith('/') || ret.startsWith('//') || ret.includes('\\')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(ret)) return '/';
  let u: URL;
  try {
    u = new URL(ret, origin);
  } catch {
    return '/';
  }
  if (u.origin !== origin || u.pathname === '/api' || u.pathname.startsWith('/api/')) return '/';
  return `${u.pathname}${u.search}${u.hash}`;
}

// ---- sessions

export interface SessionUser {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  plan: string;
}

/** HMAC first (no D1 read for a forged cookie), then the read limit if given, then one query. */
async function currentUser(request: Request, env: AuthEnv, cfg: Config, readLimit?: RateLimit): Promise<{ user: SessionUser; sessionId: string } | null> {
  const sid = await unsign(cfg.secret, 'session', readCookie(request, SESSION_COOKIE));
  if (!sid) return null;
  const sessionId = await sessionHash(sid);
  await limit(readLimit, `session:${sessionId}`);
  const user = await env.DB.prepare(
    'SELECT u.id, u.display_name, u.avatar_url, u.plan FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?',
  ).bind(sessionId, Math.floor(Date.now() / 1000)).first<SessionUser>();
  return user ? { user, sessionId } : null;
}

async function requireUser(request: Request, env: AuthEnv, cfg: Config, readLimit?: RateLimit) {
  const s = await currentUser(request, env, cfg, readLimit);
  if (!s) throw new HttpError(401, 'unauthenticated');
  return s;
}

/**
 * Statements (run them in one batch, in order) that create a session for the user and delete the user's expired
 * sessions and those beyond the newest MAX_SESSIONS; and the session's two cookies.
 */
export async function issueSession(db: D1Database, secret: string, userId: string, now = Date.now()) {
  const sid = randomToken();
  const id = await sessionHash(sid);
  const nowS = Math.floor(now / 1000);
  const statements = [
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(id, userId, new Date(now).toISOString(), nowS + SESSION_TTL_S),
    db.prepare(
      'DELETE FROM sessions WHERE user_id = ?1 AND id != ?2 AND (expires_at <= ?3 OR id NOT IN ' +
      '(SELECT id FROM sessions WHERE user_id = ?1 AND id != ?2 AND expires_at > ?3 ORDER BY created_at DESC, id LIMIT ?4))',
    ).bind(userId, id, nowS, MAX_SESSIONS - 1),
  ];
  const cookies = [cookie(SESSION_COOKIE, await sign(secret, 'session', sid), SESSION_TTL_S), cookie(USER_COOKIE, '1', SESSION_TTL_S, false)];
  return { statements, cookies };
}

/** Feature gate for paid features (none yet). */
export async function requireEntitlement(db: D1Database, userId: string, feature: string, now = new Date()): Promise<boolean> {
  const iso = now.toISOString();
  const row = await db.prepare(
    'SELECT 1 AS ok FROM entitlements WHERE user_id = ? AND feature = ? AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?) LIMIT 1',
  ).bind(userId, feature, iso, iso).first();
  return !!row;
}

// ---- Google OAuth

interface OAuthState {
  s: string; // state
  v: string; // PKCE verifier
  n: string; // nonce
  r: string; // return path
  e: number; // expiry, Unix seconds
}

async function start(request: Request, env: AuthEnv, cfg: Config, url: URL, ip: string): Promise<Response> {
  await limit(env.AUTH_LIMIT, `ip:${ip}`);
  const st: OAuthState = { s: randomToken(), v: randomToken(), n: randomToken(), r: safeReturn(url.searchParams.get('return'), cfg.origin), e: Math.floor(Date.now() / 1000) + OAUTH_TTL_S };
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${cfg.origin}${CALLBACK_PATH}`,
    response_type: 'code',
    scope: 'openid email profile',
    state: st.s,
    nonce: st.n,
    code_challenge: b64url(await sha256(st.v)),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  const value = await sign(cfg.secret, 'oauth', b64url(enc.encode(JSON.stringify(st))));
  return redirect(`${GOOGLE_AUTH_URL}?${q}`, [cookie(OAUTH_COOKIE, value, OAUTH_TTL_S)]);
}

export interface IdClaims {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

/**
 * The id_token comes straight from Google's token endpoint over TLS, authenticated with the client secret, so its
 * signature is not checked (OpenID Connect Core 3.1.3.7, item 6); the claims are.
 */
export function validateIdToken(idToken: unknown, clientId: string, nonce: string, nowS = Math.floor(Date.now() / 1000)): IdClaims {
  if (typeof idToken !== 'string') throw new Error('no id_token');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const c = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  if (!GOOGLE_ISSUERS.has(c.iss)) throw new Error('iss');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) throw new Error('aud');
  if ((aud.length > 1 || c.azp !== undefined) && c.azp !== clientId) throw new Error('azp');
  if (typeof c.exp !== 'number' || c.exp <= nowS) throw new Error('exp');
  if (typeof c.iat !== 'number' || c.iat > nowS + CLOCK_SKEW_S || c.iat < nowS - OAUTH_TTL_S - CLOCK_SKEW_S) throw new Error('iat');
  if (typeof c.nonce !== 'string' || !timingSafeEqual(c.nonce, nonce)) throw new Error('nonce');
  if (c.email_verified !== true && c.email_verified !== 'true') throw new Error('email_verified');
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw new Error('sub');
  return { sub: c.sub, email: typeof c.email === 'string' ? c.email : undefined, name: c.name, picture: c.picture };
}

const shortText = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const avatar = (v: unknown) => (typeof v === 'string' && v.startsWith('https://') && v.length <= 2048 ? v : null);

async function callback(request: Request, env: AuthEnv, cfg: Config, url: URL, ip: string): Promise<Response> {
  await limit(env.AUTH_LIMIT, `ip:${ip}`);
  const clearOauth = clearCookie(OAUTH_COOKIE);
  const raw = await unsign(cfg.secret, 'oauth', readCookie(request, OAUTH_COOKIE));
  let st: OAuthState | null = null;
  try {
    if (raw) st = JSON.parse(new TextDecoder().decode(b64urlDecode(raw)));
  } catch {
    st = null;
  }
  const nowS = Math.floor(Date.now() / 1000);
  if (!st || typeof st.s !== 'string' || st.e <= nowS || !timingSafeEqual(url.searchParams.get('state') ?? '', st.s)) {
    return redirect(`${cfg.origin}/`, [clearOauth]);
  }
  const back = `${cfg.origin}${safeReturn(st.r, cfg.origin)}`;
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.has('error')) return redirect(back, [clearOauth]);
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: `${cfg.origin}${CALLBACK_PATH}`,
        grant_type: 'authorization_code', code_verifier: st.v,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token endpoint ${tokenRes.status}`);
    const tokens = (await tokenRes.json()) as { id_token?: unknown };
    const claims = validateIdToken(tokens.id_token, cfg.clientId, st.n, nowS);
    const userId = await upsertUser(env.DB, claims);
    const session = await issueSession(env.DB, cfg.secret, userId);
    await env.DB.batch(session.statements);
    return redirect(back, [clearOauth, ...session.cookies]);
  } catch (e) {
    console.error(`login failed: ${(e as Error).message}`);
    return redirect(back, [clearOauth]);
  }
}

/** Identity key is (google, sub); never linked to another account by email. */
async function upsertUser(db: D1Database, c: IdClaims): Promise<string> {
  const now = new Date().toISOString();
  const name = shortText(c.name, 100);
  const pic = avatar(c.picture);
  const email = shortText(c.email, 320);
  const found = await db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?').bind('google', c.sub).first<{ user_id: string }>();
  if (found) {
    await db.batch([
      db.prepare('UPDATE users SET display_name = ?1, avatar_url = ?2 WHERE id = ?3 AND (display_name IS NOT ?1 OR avatar_url IS NOT ?2)').bind(name, pic, found.user_id),
      db.prepare('UPDATE user_identities SET email = ?1 WHERE provider = ?2 AND subject = ?3 AND email IS NOT ?1').bind(email, 'google', c.sub),
    ]);
    return found.user_id;
  }
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare('INSERT INTO users (id, created_at, display_name, avatar_url) VALUES (?, ?, ?, ?)').bind(id, now, name, pic),
    db.prepare('INSERT INTO user_identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)').bind('google', c.sub, id, email, now),
  ]);
  return id;
}

// ---- account routes

async function readPrefRows(db: D1Database, userId: string): Promise<PrefRow[]> {
  return (await db.prepare('SELECT key, value_json, updated_at FROM user_prefs WHERE user_id = ?').bind(userId).all<PrefRow>()).results;
}

async function changePrefs(request: Request, env: AuthEnv, cfg: Config, mode: 'put' | 'merge'): Promise<Response> {
  checkCsrf(request, cfg);
  const { user } = await requireUser(request, env, cfg);
  await limit(env.AUTH_WRITE_LIMIT, `user:${user.id}`);
  const body = await readJson(request);
  const rows = await readPrefRows(env.DB, user.id);
  const current = prefsBody(rows).prefs;
  const changes = mode === 'put' ? applyPut(current, body) : applyMerge(current, body);
  const w = writePrefs(env.DB, user.id, rows, changes, new Date().toISOString());
  if (w.statements.length) await env.DB.batch(w.statements);
  return json(prefsBody(w.rows));
}

async function deleteAccount(request: Request, env: AuthEnv, cfg: Config): Promise<Response> {
  checkCsrf(request, cfg);
  const { user } = await requireUser(request, env, cfg);
  await limit(env.AUTH_WRITE_LIMIT, `user:${user.id}`);
  const db = env.DB;
  await db.batch(['user_prefs', 'sessions', 'user_identities', 'entitlements', 'billing_customers', 'users'].map((t) =>
    db.prepare(`DELETE FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'} = ?`).bind(user.id)));
  return json(null, 204, CLEAR_SESSION);
}

async function logout(request: Request, env: AuthEnv, cfg: Config): Promise<Response> {
  checkCsrf(request, cfg);
  const sid = await unsign(cfg.secret, 'session', readCookie(request, SESSION_COOKIE));
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sessionHash(sid)).run();
  return json(null, 204, CLEAR_SESSION);
}

export const isAccountPath = (p: string) => /^\/api\/v1\/(auth|me|billing)(\/|$)/.test(p);

type Handler = (request: Request, env: AuthEnv, cfg: Config, url: URL, ip: string) => Promise<Response>;

const ACCOUNT_ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  '/api/v1/auth/google/start': { GET: start },
  '/api/v1/auth/google/callback': { GET: callback },
  '/api/v1/auth/logout': { POST: (r, e, c) => logout(r, e, c) },
  '/api/v1/me': {
    GET: async (r, e, c) => json({ user: (await requireUser(r, e, c, e.AUTH_READ_LIMIT)).user }),
    DELETE: (r, e, c) => deleteAccount(r, e, c),
  },
  '/api/v1/me/prefs': {
    GET: async (r, e, c) => json(prefsBody(await readPrefRows(e.DB, (await requireUser(r, e, c, e.AUTH_READ_LIMIT)).user.id))),
    PUT: (r, e, c) => changePrefs(r, e, c, 'put'),
  },
  '/api/v1/me/prefs/merge': { POST: (r, e, c) => changePrefs(r, e, c, 'merge') },
  '/api/v1/billing/webhook': { POST: async () => json({ error: 'not implemented' }, 501) },
};

/** /api/v1/auth|me|billing. Never touches the Cache API; every answer is private, no-store. */
export async function handleAccount(request: Request, env: AuthEnv, url: URL, ip: string): Promise<Response> {
  const cfg = config(env, url);
  if (!cfg) return json({ error: 'auth disabled' }, 404);
  const route = ACCOUNT_ROUTES[url.pathname];
  if (!route) return json({ error: 'not found' }, 404);
  const handler = route[request.method];
  if (!handler) return json({ error: 'method not allowed' }, 405, [], { allow: Object.keys(route).join(', ') });
  try {
    return await handler(request, env, cfg, url, ip);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, e.status === 401 ? CLEAR_SESSION : [], e.headers);
    if (e instanceof PrefsError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: 'internal error' }, 500);
  }
}
