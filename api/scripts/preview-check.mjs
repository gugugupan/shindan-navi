#!/usr/bin/env node
// Gate before shindan-navi.app points at the Worker: upload the current build as a new version (not deployed),
// then check its version preview URL serves /events/ and an API backed by imported data. Exits non-zero
// otherwise, so the deploy that attaches the domain never runs on an empty D1 or a broken build.
//
//   node api/scripts/preview-check.mjs            (repo root; needs wrangler.remote.json and Cloudflare auth)
//   node api/scripts/preview-check.mjs --url URL  (only the checks, against an existing preview URL)
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WRANGLER = `wrangler@${process.env.WRANGLER_VERSION || '4.164.0'}`;
const { values: opts } = parseArgs({ options: { url: { type: 'string' } } });
const fail = (msg) => {
  console.error(`preview-check: ${msg}`);
  process.exit(1);
};

let url = opts.url;
if (!url) {
  const r = spawnSync('npx', ['--yes', WRANGLER, 'versions', 'upload', '--config', 'wrangler.remote.json'], {
    cwd: REPO_DIR, encoding: 'utf8', env: { ...process.env, CI: '1' },
  });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  if (r.status !== 0) fail('wrangler versions upload failed');
  url = /Version Preview URL:\s*(https:\/\/\S+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  if (!url) fail('no Version Preview URL in the upload output (are preview_urls and the workers.dev subdomain enabled?)');
}
url = url.replace(/\/+$/, '');

async function get(path) {
  // A fresh version can take a few seconds to answer everywhere.
  let last;
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(`${url}${path}`, { redirect: 'manual' });
      if (res.status === 200) return res;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  fail(`${path}: ${last}`);
}

const meta = await (await get('/api/v1/events/meta')).json();
const games = (meta.games ?? []).filter((g) => g.record_count > 0 && g.window);
if (!games.length) fail('meta lists no game with data: import events into D1 before attaching the domain');
const from = games.map((g) => g.window.from).sort()[0];
const until = new Date(Date.parse(`${from}T00:00:00Z`) + 28 * 86_400_000).toISOString().slice(0, 10);
const days = await (await get(`/api/v1/events/days?from=${from}&until=${until}&pref=JP-13`)).json();
if (!Array.isArray(days.days)) fail('/api/v1/events/days returned no days array');
const page = await (await get('/events/')).text();
if (!page.includes('/api/v1')) fail('/events/ does not look like the events page');
console.log(`preview-check: ok ${url} (${games.map((g) => `${g.code} ${g.record_count}`).join(', ')}; JP-13 ${days.days.reduce((n, d) => n + d.count, 0)} events from ${from})`);
