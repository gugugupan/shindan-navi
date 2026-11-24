#!/usr/bin/env node
// Fallback for machines where workerd cannot run (macOS < 13.5): serves the same Worker fetch
// handler on Node with the SQLite file written by `import-events.mjs --target sqlite`, plus ../dist.
// Asset handling approximates Workers static assets (see resolveAsset); public/_headers is not applied.
// Accounts: SITE_ORIGIN is http://localhost:<port>; the three secrets come from ../.env (npm run dev:node loads it
// with --env-file-if-exists). --dev-login adds GET /__dev/login?name=… (this file only, never in the Worker), which
// signs in a local test user without Google and fills missing secrets with throwaway values.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { API_DIR, REPO_DIR } from './lib/importer.mjs';
import { SqliteD1 } from './lib/sqlite-d1.mjs';

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    sqlite: { type: 'string', default: join(API_DIR, '.local', 'events.sqlite3') },
    dist: { type: 'string', default: join(REPO_DIR, 'dist') },
    'dev-login': { type: 'boolean', default: false },
    // serve the database as it is (e.g. a schema from before a migration, tools/verify/landing.mjs)
    'no-migrate': { type: 'boolean', default: false },
  },
});

const outfile = join(API_DIR, '.local', 'worker-node.mjs');
// The Worker entry plus the two auth helpers /__dev/login needs; the entry itself exports only the handler.
await build({
  stdin: { contents: "export { default } from './src/index.ts';\nexport { issueSession, safeReturn } from './src/auth.ts';", resolveDir: API_DIR, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'warning', external: ['cloudflare:*'],
});
const mod = await import(`${outfile}?t=${Date.now()}`);
const worker = mod.default;
const db = opts['no-migrate'] ? new SqliteD1(opts.sqlite) : new SqliteD1(opts.sqlite).migrate();
const dist = resolve(opts.dist);

const SECRETS = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'SESSION_SECRET'];
const env = { DB: db, SITE_ORIGIN: `http://localhost:${opts.port}` };
// Event landing pages: LANDING_ENABLED=1 as on the Worker; DEV_TODAY=YYYY-MM-DD pins their "today".
for (const k of ['LANDING_ENABLED', 'DEV_TODAY']) if (process.env[k]) env[k] = process.env[k];
for (const k of SECRETS) {
  if (process.env[k]) env[k] = process.env[k];
  else if (opts['dev-login']) env[k] = k === 'SESSION_SECRET' ? randomBytes(32).toString('hex') : 'dev-login-only';
}
const missing = SECRETS.filter((k) => !process.env[k]);
if (missing.length) console.log(`dev-node: ${missing.join(', ')} not set${opts['dev-login'] ? ' (dev placeholders: Google login will not work, /__dev/login does)' : ': account routes answer 404'}`);

/** Local-only login: creates (or reuses) a test user and session directly in SQLite. */
async function devLogin(url) {
  const name = (url.searchParams.get('name') || 'dev').slice(0, 40);
  const subject = `dev:${name}`;
  const now = new Date().toISOString();
  let userId = (await db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?').bind('dev', subject).first())?.user_id;
  if (!userId) {
    userId = crypto.randomUUID();
    await db.batch([
      db.prepare('INSERT INTO users (id, created_at, display_name) VALUES (?, ?, ?)').bind(userId, now, name),
      db.prepare('INSERT INTO user_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)').bind('dev', subject, userId, now),
    ]);
  }
  const session = await mod.issueSession(db, env.SESSION_SECRET, userId);
  await db.batch(session.statements);
  const res = new Response(null, { status: 302, headers: { location: mod.safeReturn(url.searchParams.get('return'), env.SITE_ORIGIN), 'cache-control': 'no-store' } });
  for (const c of session.cookies) res.headers.append('set-cookie', c);
  return res;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
};

const isFile = (p) => existsSync(p) && statSync(p).isFile();

// Mirrors html_handling "auto-trailing-slash": /dir -> 307 /dir/, /dir/index.html -> 307 /dir/,
// /page.html -> 307 /page; everything else is served as-is or falls through to 404.html.
function resolveAsset(pathname) {
  const p = resolve(dist, `.${decodeURIComponent(pathname)}`);
  if (p !== dist && !p.startsWith(dist + sep)) return { file: null };
  if (pathname.endsWith('/index.html') && isFile(p)) return { redirect: pathname.slice(0, -'index.html'.length) };
  if (pathname.endsWith('.html') && isFile(p)) return { redirect: pathname.slice(0, -'.html'.length) };
  if (pathname.endsWith('/')) return { file: isFile(join(p, 'index.html')) ? join(p, 'index.html') : null };
  if (isFile(p)) return { file: p };
  if (isFile(`${p}.html`)) return { file: `${p}.html` };
  if (isFile(join(p, 'index.html'))) return { redirect: `${pathname}/` };
  return { file: null };
}

const ASSETS = {
  async fetch(req) {
    const url = new URL(req.url);
    const { file, redirect } = resolveAsset(url.pathname);
    if (redirect) return new Response(null, { status: 307, headers: { location: redirect + url.search } });
    if (!file) {
      const nf = join(dist, '404.html');
      return existsSync(nf) ? new Response(readFileSync(nf), { status: 404, headers: { 'content-type': TYPES['.html'] } }) : new Response('Not found', { status: 404 });
    }
    return new Response(readFileSync(file), { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } });
  },
};

createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) for (const x of [v].flat()) if (x !== undefined) headers.append(k, x);
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method: req.method, headers, body });
    // DEV_GEO_REGION=13 emulates Cloudflare's IP geolocation for /api/v1/geo
    if (process.env.DEV_GEO_REGION) Object.defineProperty(request, 'cf', { value: { country: 'JP', regionCode: process.env.DEV_GEO_REGION } });
    const url = new URL(request.url);
    const response = opts['dev-login'] && url.pathname === '/__dev/login' && req.method === 'GET'
      ? await devLogin(url)
      : await worker.fetch(request, { ...env, ASSETS });
    const out = {};
    for (const [k, v] of response.headers) if (k !== 'set-cookie') out[k] = v;
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end();
  }
}).listen(+opts.port, () => console.log(`dev-node: http://localhost:${opts.port} (db ${opts.sqlite}, assets ${dist})`));
