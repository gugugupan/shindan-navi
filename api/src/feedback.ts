import { sessionUserId, type AuthEnv } from './auth';

export interface FeedbackEnv extends AuthEnv {
  /** Cloudflare Turnstile secret for the /feedback/ widget (wrangler secret). */
  TURNSTILE_SECRET_KEY?: string;
  /** Where notifications go: a verified Email Routing destination address (wrangler secret, never in git). */
  FEEDBACK_TO?: string;
  /** send_email binding (wrangler.jsonc), restricted to FEEDBACK_FROM as sender, no fixed destination. */
  FEEDBACK_EMAIL?: SendEmail;
  /** Workers Rate Limiting bindings; absent locally. Per client IP, and for everyone together (key "all"). */
  FEEDBACK_LIMIT?: RateLimit;
  FEEDBACK_BREAKER?: RateLimit;
}

export const FEEDBACK_PATH = '/api/v1/feedback';
export const FEEDBACK_FROM = 'feedback-form@shindan-navi.app';
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ACTION = 'feedback';
export const KINDS = { bug: '不具合', request: '要望', data: 'データの誤り', other: 'その他' } as const;
export type Kind = keyof typeof KINDS;
export const MAX_MESSAGE = 2000;
export const MAX_EMAIL = 254;
export const MAX_PAGE = 512;
export const MAX_BODY_BYTES = 16 * 1024;
export const RETENTION_DAYS = 365;

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
};

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

class HttpError extends Error {
  constructor(public status: number, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

// Same pattern as src/feedback.html (keep them in sync). Deliberately narrower than RFC 5321: one @, no spaces, quotes, angle brackets, commas or control characters, so the
// value is safe in a Reply-To header as is.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isEmail = (s: string) => s.length <= MAX_EMAIL && EMAIL.test(s);

interface Config {
  origin: string;
  secret: string;
  to: string;
  mail: SendEmail;
}

/** All of SITE_ORIGIN (matching the request), the Turnstile secret, the recipient and the mail binding, or null. */
export function feedbackConfig(env: FeedbackEnv, url: URL): Config | null {
  const { SITE_ORIGIN: origin, TURNSTILE_SECRET_KEY: secret, FEEDBACK_TO: to, FEEDBACK_EMAIL: mail } = env;
  if (!origin || !secret || !to || !mail || url.origin !== origin || !isEmail(to.trim())) return null;
  return { origin, secret, to: to.trim(), mail };
}

export interface Feedback {
  kind: Kind;
  message: string;
  reply_to: string | null;
  page: string | null;
  turnstile: string;
}

const FIELDS = new Set(['kind', 'message', 'reply_to', 'page', 'turnstile']);
// C0/C1 controls except tab and newline; the message keeps line breaks.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** Throws HttpError(400) on anything but exactly what the page sends. */
export function parseFeedback(body: unknown): Feedback {
  const bad = (m: string) => new HttpError(400, m);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!FIELDS.has(k)) throw bad(`unknown field: ${k}`);
  if (typeof b.kind !== 'string' || !Object.hasOwn(KINDS, b.kind)) throw bad('kind');
  if (typeof b.message !== 'string') throw bad('message');
  const message = b.message.replace(/\r\n?/g, '\n').trim();
  if (!message || [...message].length > MAX_MESSAGE) throw bad('message');
  if (CONTROL.test(message)) throw bad('message contains control characters');
  let reply: string | null = null;
  if (b.reply_to !== undefined && b.reply_to !== null && b.reply_to !== '') {
    if (typeof b.reply_to !== 'string' || !isEmail(b.reply_to.trim())) throw bad('reply_to');
    reply = b.reply_to.trim();
  }
  let page: string | null = null;
  if (b.page !== undefined && b.page !== null && b.page !== '') {
    const p = b.page;
    if (typeof p !== 'string' || p.length > MAX_PAGE || !p.startsWith('/') || p.startsWith('//') || p.includes('\\') || /[\u0000- \u007f]/.test(p)) throw bad('page');
    page = p;
  }
  if (typeof b.turnstile !== 'string' || !b.turnstile || b.turnstile.length > 2048) throw bad('turnstile');
  return { kind: b.kind as Kind, message, reply_to: reply, page, turnstile: b.turnstile };
}

/** Siteverify: success, our hostname and the page's action. Network or Cloudflare errors → 503. */
async function verifyTurnstile(cfg: Config, token: string, ip: string | null): Promise<void> {
  const form = new URLSearchParams({ secret: cfg.secret, response: token });
  if (ip) form.set('remoteip', ip);
  let out: { success?: boolean; hostname?: string; action?: string; 'error-codes'?: string[] };
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    out = await res.json();
  } catch (e) {
    console.error(`turnstile: ${(e as Error).message}`);
    throw new HttpError(503, 'verification unavailable', { 'retry-after': '60' });
  }
  if (out.success !== true || out.hostname !== new URL(cfg.origin).hostname || out.action !== TURNSTILE_ACTION) {
    throw new HttpError(403, 'verification failed');
  }
}

// ---- mail (RFC 5322 + MIME, built by hand: one UTF-8 text/plain part)

const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * RFC 2047 encoded words split on character boundaries, folded with CRLF + space. 39 bytes of UTF-8 → 52 base64
 * characters + 12 = 64 per word, so even after "Subject: " every header line stays within 78 characters.
 */
export function encodeWord(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text) && !/=\?/.test(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const ch of text) {
    if (enc.encode(chunk + ch).length > 39) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(enc.encode(w))}?=`).join('\r\n ');
}

export interface MailInput {
  id: string;
  createdAt: string;
  feedback: Omit<Feedback, 'turnstile'>;
  loggedIn: boolean;
  origin: string;
  to: string;
}

export function buildMail(m: MailInput): string {
  const f = m.feedback;
  const first = [...f.message.replace(/\s+/g, ' ')].slice(0, 40).join('');
  const subject = `[トレカカレンダー] ${KINDS[f.kind]}: ${first}${[...f.message].length > 40 ? '…' : ''}`;
  const body = [
    `種類: ${KINDS[f.kind]}`,
    `送信元ページ: ${f.page ? m.origin + f.page : '(なし)'}`,
    `返信先: ${f.reply_to ?? '(なし)'}`,
    `ログインユーザー: ${m.loggedIn ? 'はい' : 'いいえ'}`,
    `受付 ID: ${m.id}`,
    `受付日時: ${m.createdAt}`,
    '',
    f.message,
    '',
  ].join('\r\n').replace(/\r?\n/g, '\r\n');
  const date = new Date(m.createdAt).toUTCString().replace(/GMT$/, '+0000');
  const headers = [
    `From: ${encodeWord('トレカカレンダー フィードバック')}\r\n <${FEEDBACK_FROM}>`,
    `To: <${m.to}>`,
    ...(f.reply_to ? [`Reply-To: <${f.reply_to}>`] : []),
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date}`,
    `Message-ID: <${m.id}@shindan-navi.app>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const lines = b64(enc.encode(body)).match(/.{1,76}/g) ?? [];
  return `${headers.join('\r\n')}\r\n\r\n${lines.join('\r\n')}\r\n`;
}

async function sendMail(cfg: Config, raw: string): Promise<void> {
  // Only the Workers runtime has this module; tests alias it (vitest.config.ts), dev-node has no mail binding.
  const { EmailMessage } = await import('cloudflare:email');
  await cfg.mail.send(new EmailMessage(FEEDBACK_FROM, cfg.to, raw));
}

// ---- route

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  const text = await request.text();
  if (enc.encode(text).length > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

async function submit(request: Request, env: FeedbackEnv, cfg: Config, url: URL, client: string): Promise<Response> {
  if (request.headers.get('origin') !== cfg.origin) throw new HttpError(403, 'forbidden');
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported media type');
  // Before Turnstile and D1: a limited request costs neither a siteverify call nor a write.
  for (const [binding, key] of [[env.FEEDBACK_LIMIT, `ip:${client}`], [env.FEEDBACK_BREAKER, 'all']] as const) {
    if (binding && !(await binding.limit({ key })).success) throw new HttpError(429, 'too many requests', { 'retry-after': '60' });
  }
  const f = parseFeedback(await readJson(request));
  await verifyTurnstile(cfg, f.turnstile, request.headers.get('cf-connecting-ip'));
  const userId = await sessionUserId(request, env, url);
  const id = crypto.randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
  const db = env.DB;
  await db.batch([
    db.prepare('INSERT INTO feedback (id, created_at, kind, message, reply_to, page, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, createdAt, f.kind, f.message, f.reply_to, f.page, userId),
    db.prepare('DELETE FROM feedback WHERE created_at < ?').bind(cutoff),
  ]);
  let status: 'sent' | 'failed' = 'sent';
  let error: string | null = null;
  try {
    await sendMail(cfg, buildMail({ id, createdAt, feedback: f, loggedIn: userId !== null, origin: cfg.origin, to: cfg.to }));
  } catch (e) {
    status = 'failed';
    const err = e as Error & { code?: string };
    error = String(err.code ?? err.message ?? e).slice(0, 200);
    console.error(`feedback ${id}: mail failed: ${error}`);
  }
  try {
    await db.prepare('UPDATE feedback SET email_status = ?, email_error = ? WHERE id = ?').bind(status, error, id).run();
  } catch (e) {
    console.error(e);
  }
  return json({ ok: true, id }, 202);
}

/** POST /api/v1/feedback. 404 while any part of its configuration is missing; never cached. */
export async function handleFeedback(request: Request, env: FeedbackEnv, url: URL, client: string): Promise<Response> {
  const cfg = feedbackConfig(env, url);
  if (!cfg) return json({ error: 'feedback disabled' }, 404);
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  try {
    return await submit(request, env, cfg, url, client);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, e.headers);
    console.error(e);
    return json({ error: 'internal error' }, 500);
  }
}
