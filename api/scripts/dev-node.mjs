#!/usr/bin/env node
// Fallback for machines where workerd cannot run (macOS < 13.5): serves the same Worker fetch
// handler on Node with the SQLite file written by `import-events.mjs --target sqlite`, plus ../dist.
// Asset handling only approximates Workers static assets (index.html for directories, .html suffix).
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

function staticFile(pathname) {
  const p = resolve(dist, `.${decodeURIComponent(pathname)}`);
  if (p !== dist && !p.startsWith(dist + sep)) return null;
  for (const c of [p, join(p, 'index.html'), `${p}.html`]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const ASSETS = {
  async fetch(req) {
    const file = staticFile(new URL(req.url).pathname);
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
    const response = await worker.fetch(request, { DB: db, ASSETS });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end();
  }
}).listen(+opts.port, () => console.log(`dev-node: http://localhost:${opts.port} (db ${opts.sqlite}, assets ${dist})`));
