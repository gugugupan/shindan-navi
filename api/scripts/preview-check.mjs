#!/usr/bin/env node
// Check the current build on a version preview URL before (or while) shindan-navi.app points at the Worker:
// upload it as a new version (not deployed) and request its preview URL.
//
//   node api/scripts/preview-check.mjs [--strict]            (repo root; needs wrangler.remote.json + Cloudflare auth)
//   node api/scripts/preview-check.mjs [--strict] --url URL  (only the checks)
//
// Always fails on a broken build (/, /events/). Data checks (meta lists games with events, Tokyo has events in
// the next 31 days) fail only with --strict, used for the first domain attach; CI warns instead, so a D1 hiccup or stale
// data never blocks publishing the release calendar. The preview URL is masked in GitHub Actions logs.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WRANGLER = `wrangler@${process.env.WRANGLER_VERSION || '4.164.0'}`;
const { values: opts } = parseArgs({ options: { url: { type: 'string' }, strict: { type: 'boolean', default: false } } });
const actions = !!process.env.GITHUB_ACTIONS;
const fail = (msg) => {
  console.error(`${actions ? '::error::' : ''}preview-check: ${msg}`);
  process.exit(1);
};
const dataProblem = (msg) => {
  if (opts.strict) fail(msg);
  console.log(`${actions ? '::warning::' : ''}preview-check: ${msg}`);
};

let url = opts.url;
if (!url) {
  const r = spawnSync('npx', ['--yes', WRANGLER, 'versions', 'upload', '--config', 'wrangler.remote.json'], {
    cwd: REPO_DIR, encoding: 'utf8', env: { ...process.env, CI: '1' },
  });
  url = /Version Preview URL:\s*(https:\/\/\S+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  // The upload output names the preview URL and account subdomain: never echo it, and mask the URL first.
  if (url && actions) console.log(`::add-mask::${url}`);
  if (r.status !== 0) fail(`wrangler versions upload failed (exit ${r.status}); run it locally to see the output`);
  if (!url) fail('no Version Preview URL in the upload output (are preview_urls and the workers.dev subdomain enabled?)');
} else if (actions) console.log(`::add-mask::${url}`);
url = url.replace(/\/+$/, '');

async function get(path, { retries = 12 } = {}) {
  // A fresh version can take a few seconds to answer everywhere.
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${url}${path}`, { redirect: 'manual' });
      if (res.status === 200) return res;
      last = `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 404) break;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { error: `${path}: ${last}` };
}

const home = await get('/');
if (home.error) fail(home.error);
const releases = await get('/releases/');
if (releases.error) fail(releases.error);
const page = await get('/events/');
if (page.error) fail(page.error);
if (!(await page.text()).includes('/api/v1')) fail('/events/ does not look like the events page');

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
const addMonth = (d) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 1)).toISOString().slice(0, 10);
const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 31 * 86_400_000).toISOString().slice(0, 10);
const metaRes = await get('/api/v1/events/meta', { retries: 3 });
if (metaRes.error) {
  dataProblem(`API: ${metaRes.error}`);
} else {
  const meta = await metaRes.json();
  const games = (meta.games ?? []).filter((g) => g.record_count > 0);
  if (!games.length) dataProblem('meta lists no game with events: import into D1 first');
  else {
    // /days takes whole months: this month and the next cover today .. today+31 even at a month's end.
    let ahead = 0;
    let error = null;
    for (let m = `${today.slice(0, 7)}-01`; m < horizon && !error; m = addMonth(m)) {
      const res = await get(`/api/v1/events/days?from=${m}&until=${addMonth(m)}&pref=JP-13`, { retries: 3 });
      if (res.error) error = res.error;
      else ahead += ((await res.json()).days ?? []).filter((d) => d.date >= today && d.date < horizon).reduce((n, d) => n + d.count, 0);
    }
    if (error) dataProblem(`API: ${error}`);
    else if (!ahead) dataProblem(`no Tokyo events between ${today} and ${horizon}: the data looks stale`);
    else console.log(`preview-check: ok (${games.map((g) => `${g.code} ${g.record_count}`).join(', ')}; Tokyo ${ahead} events in the next 31 days)`);
  }
}
