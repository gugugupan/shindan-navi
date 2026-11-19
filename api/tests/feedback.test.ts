import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { issueSession } from '../src/auth';
import { buildMail, encodeWord, FEEDBACK_FROM, MAX_MESSAGE, parseFeedback, TURNSTILE_VERIFY_URL } from '../src/feedback';
import { newDb } from './helpers';

const ORIGIN = 'https://shindan-navi.app';
const TO = 'owner@example.invalid';
const AUTH = { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret', SESSION_SECRET: 'x'.repeat(64) };

let db: any;
let env: Record<string, any>;
let sent: { from: string; to: string; raw: string }[];
let mailError: Error | null;
let verify: { body: Record<string, unknown>; status: number; calls: URLSearchParams[] };
let allow: boolean;

beforeEach(() => {
  db = newDb();
  sent = [];
  mailError = null;
  allow = true;
  verify = { body: { success: true, hostname: 'shindan-navi.app', action: 'feedback' }, status: 200, calls: [] };
  env = {
    DB: db,
    SITE_ORIGIN: ORIGIN,
    TURNSTILE_SECRET_KEY: 'ts-secret',
    FEEDBACK_TO: TO,
    FEEDBACK_EMAIL: { send: vi.fn(async (m: { from: string; to: string; raw: string }) => { if (mailError) throw mailError; sent.push(m); return { messageId: 'x' }; }) },
    FEEDBACK_LIMIT: { limit: vi.fn(async () => ({ success: allow })) },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    verify.calls.push(new URLSearchParams(init.body as URLSearchParams));
    return new Response(JSON.stringify(verify.body), { status: verify.status });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const GOOD = { kind: 'bug', message: 'カレンダーの日付がずれています', reply_to: 'me@example.com', page: '/pokemon/', turnstile: 'tok' };

async function post(body: unknown, opts: { headers?: Record<string, string>; e?: Record<string, any>; method?: string } = {}) {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1/feedback`, {
    method: opts.method ?? 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', ...opts.headers },
    body: opts.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), (opts.e ?? env) as any);
  return { status: res.status, body: await res.json() as any, headers: res.headers };
}

const rows = async (): Promise<any[]> => (await db.prepare('SELECT * FROM feedback').all()).results;

function decodeMail(raw: string) {
  const [head, body] = raw.split('\r\n\r\n');
  const text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, '')), (c) => c.charCodeAt(0)));
  const subject = head.match(/^Subject: ([\s\S]*?)\r\n(?=\S)/m)![1].split('\r\n ')
    .map((w) => new TextDecoder().decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0)))).join('');
  return { head, text, subject };
}

describe('POST /api/v1/feedback', () => {
  it('stores the feedback, verifies Turnstile and mails it', async () => {
    const res = await post(GOOD);
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(verify.calls).toHaveLength(1);
    expect(Object.fromEntries(verify.calls[0])).toEqual({ secret: 'ts-secret', response: 'tok', remoteip: '203.0.113.9' });
    expect(env.FEEDBACK_LIMIT.limit).toHaveBeenCalledWith({ key: 'ip:203.0.113.9' });
    const [row] = await rows();
    expect(row).toMatchObject({ id: res.body.id, kind: 'bug', message: GOOD.message, reply_to: 'me@example.com', page: '/pokemon/', user_id: null, email_status: 'sent', email_error: null });
    expect(sent).toHaveLength(1);
    expect([sent[0].from, sent[0].to]).toEqual([FEEDBACK_FROM, TO]);
    const mail = decodeMail(sent[0].raw);
    expect(mail.head).toContain(`To: <${TO}>`);
    expect(mail.head).toContain('Reply-To: <me@example.com>');
    expect(mail.head).toContain(`Message-ID: <${res.body.id}@shindan-navi.app>`);
    expect(mail.head).toMatch(/^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m);
    expect(mail.head).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mail.subject).toBe(`[新弾ナビ] 不具合: ${GOOD.message}`);
    expect(mail.text).toContain(`送信元ページ: ${ORIGIN}/pokemon/`);
    expect(mail.text).toContain('ユーザー: (未ログイン)');
    expect(mail.text).toContain(GOOD.message);
  });

  it('records the logged-in user and omits Reply-To without an address', async () => {
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind('u1', now).run();
    const s = await issueSession(db as any, AUTH.SESSION_SECRET, 'u1');
    await db.batch(s.statements);
    const cookie = s.cookies.map((c: string) => c.split(';')[0]).join('; ');
    const res = await post({ kind: 'request', message: 'ダークモード\r\nがほしい', turnstile: 'tok' }, { headers: { cookie }, e: { ...env, ...AUTH } });
    expect(res.status).toBe(202);
    const [row] = await rows();
    expect(row).toMatchObject({ user_id: 'u1', reply_to: null, page: null, message: 'ダークモード\nがほしい' });
    expect(sent[0].raw).not.toContain('Reply-To');
    expect(decodeMail(sent[0].raw).text).toContain('ユーザー: u1');
  });

  it('a failed mail keeps the feedback and records the failure', async () => {
    mailError = Object.assign(new Error('nope'), { code: 'E_RECIPIENT_NOT_ALLOWED' });
    const res = await post(GOOD);
    expect(res.status).toBe(202);
    const [row] = await rows();
    expect(row).toMatchObject({ email_status: 'failed', email_error: 'E_RECIPIENT_NOT_ALLOWED', message: GOOD.message });
  });

  it('rejects a failed, foreign or wrong-action Turnstile token without writing', async () => {
    for (const body of [
      { success: false, 'error-codes': ['invalid-input-response'] },
      { success: true, hostname: 'evil.example', action: 'feedback' },
      { success: true, hostname: 'shindan-navi.app', action: 'login' },
    ]) {
      verify.body = body;
      expect((await post(GOOD)).status).toBe(403);
    }
    verify.status = 500;
    const res = await post(GOOD);
    expect([res.status, res.headers.get('retry-after')]).toEqual([503, '60']);
    expect(await rows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('is rate limited per client before Turnstile and D1', async () => {
    allow = false;
    const res = await post(GOOD);
    expect([res.status, res.headers.get('retry-after')]).toEqual([429, '60']);
    expect(verify.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it('validates input strictly', async () => {
    const bad: unknown[] = [
      [], 'x', { ...GOOD, kind: 'praise' }, { ...GOOD, message: '   ' }, { ...GOOD, message: 'a'.repeat(MAX_MESSAGE + 1) },
      { ...GOOD, message: 'bell\u0007' }, { ...GOOD, reply_to: 'no-at' }, { ...GOOD, reply_to: 'a@b.c\r\nBcc: x@y.z' },
      { ...GOOD, reply_to: 'a b@example.com' }, { ...GOOD, page: 'https://evil.example/' }, { ...GOOD, page: '//evil.example/' },
      { ...GOOD, page: '/a b' }, { ...GOOD, turnstile: '' }, { ...GOOD, turnstile: undefined }, { ...GOOD, extra: 1 },
    ];
    for (const b of bad) expect((await post(b)).status, JSON.stringify(b)).toBe(400);
    expect((await post('{')).status).toBe(400);
    expect((await post({ ...GOOD, message: 'a'.repeat(20_000) })).status).toBe(413);
    expect(verify.calls).toEqual([]);
    expect(await rows()).toEqual([]);
    // 2,000 characters counted as code points, not UTF-16 units
    expect(parseFeedback({ ...GOOD, message: '😀'.repeat(MAX_MESSAGE) }).message).toHaveLength(MAX_MESSAGE * 2);
    expect(parseFeedback({ ...GOOD, reply_to: '', page: '' })).toMatchObject({ reply_to: null, page: null });
  });

  it('needs the same origin and a JSON body', async () => {
    expect((await post(GOOD, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await post(GOOD, { headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await post(GOOD, { method: 'GET' })).status).toBe(405);
  });

  it('answers 404 while any part of its configuration is missing', async () => {
    for (const k of ['SITE_ORIGIN', 'TURNSTILE_SECRET_KEY', 'FEEDBACK_TO', 'FEEDBACK_EMAIL']) {
      const res = await post(GOOD, { e: { ...env, [k]: undefined } });
      expect([k, res.status, res.body.error]).toEqual([k, 404, 'feedback disabled']);
    }
    expect((await post(GOOD, { e: { ...env, FEEDBACK_TO: 'not an address' } })).status).toBe(404);
    expect((await post(GOOD, { e: { ...env, SITE_ORIGIN: 'https://other.example' } })).status).toBe(404);
    expect(verify.calls).toEqual([]);
  });

  it('deletes feedback older than a year on insert', async () => {
    await db.prepare("INSERT INTO feedback (id, created_at, kind, message) VALUES ('old', '2000-01-01T00:00:00.000Z', 'other', 'x')").run();
    expect((await post(GOOD)).status).toBe(202);
    expect((await rows()).map((r) => r.id)).not.toContain('old');
  });

  it('a D1 failure is a 500 and sends no mail', async () => {
    const res = await post(GOOD, { e: { ...env, DB: { ...db, prepare: db.prepare.bind(db), batch: async () => { throw new Error('D1 down'); } } } });
    expect(res.status).toBe(500);
    expect(sent).toEqual([]);
  });

  it('deleting the account unlinks its feedback', async () => {
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind('u1', now).run();
    await db.prepare("INSERT INTO feedback (id, created_at, kind, message, user_id) VALUES ('f1', ?, 'bug', 'x', 'u1')").bind(now).run();
    const s = await issueSession(db as any, AUTH.SESSION_SECRET, 'u1');
    await db.batch(s.statements);
    const cookie = s.cookies.map((c: string) => c.split(';')[0]).join('; ');
    const res = await worker.fetch(new Request(`${ORIGIN}/api/v1/me`, { method: 'DELETE', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie } }), { ...env, ...AUTH } as any);
    expect(res.status).toBe(204);
    expect((await rows())[0]).toMatchObject({ id: 'f1', user_id: null });
  });
});

describe('mail encoding', () => {
  it('splits encoded words on character boundaries within 75 characters', () => {
    const s = 'あ😀'.repeat(30);
    const words = encodeWord(s).split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    const back = words.map((w) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0)))).join('');
    expect(back).toBe(s);
    expect(encodeWord('plain ascii')).toBe('plain ascii');
  });
  it('keeps header lines short and never lets user text into a header unencoded', () => {
    const raw = buildMail({ id: 'id1', createdAt: '2026-11-19T00:00:00.000Z', origin: ORIGIN, to: TO, userId: null,
      feedback: { kind: 'other', message: 'Subject: x\nBcc: y@z.example\n' + 'あ'.repeat(500), reply_to: null, page: null } });
    const head = raw.split('\r\n\r\n')[0];
    expect(head).not.toMatch(/^Bcc:/m);
    for (const line of head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
    expect(raw.split('\r\n\r\n')[1].split('\r\n').every((l) => l.length <= 76)).toBe(true);
  });
});
