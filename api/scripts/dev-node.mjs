#!/usr/bin/env node
// Fallback for machines where workerd cannot run (macOS < 13.5): serves the same Worker fetch
// handler on Node with the SQLite file written by `import-events.mjs --target sqlite`, plus ../dist.
// Asset handling approximates Workers static assets (see resolveAsset); public/_headers is not applied.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { API_DIR, REPO_DIR } from './lib/importer.mjs';
import { SqliteD1 } from './lib/sqlite-d1.mjs';

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    sqlite: { type: 'string', default: join(API_DIR, '.local', 'events.sqlite3') },
    dist: { type: 'string', default: join(REPO_DIR, 'dist') },
  },
});

const outfile = join(API_DIR, '.local', 'worker-node.mjs');
await build({ entryPoints: [join(API_DIR, 'src/index.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'warning' });
const worker = (await import(`${outfile}?t=${Date.now()}`)).default;
const db = new SqliteD1(opts.sqlite).migrate();
const dist = resolve(opts.dist);

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
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method: req.method });
    // DEV_GEO_REGION=13 emulates Cloudflare's IP geolocation for /api/v1/geo
    if (process.env.DEV_GEO_REGION) Object.defineProperty(request, 'cf', { value: { country: 'JP', regionCode: process.env.DEV_GEO_REGION } });
    const response = await worker.fetch(request, { DB: db, ASSETS });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end();
  }
}).listen(+opts.port, () => console.log(`dev-node: http://localhost:${opts.port} (db ${opts.sqlite}, assets ${dist})`));
