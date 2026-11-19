// Collect CONAN 公認店イベント from the official Takara Tomy eventsearch page into data/events/CONAN/ (see README.md).
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fingerprint, normalizeEvent, parseStart, sortEvents } from './lib/normalize.mjs';
import { buildOutputs, makeValidators } from './lib/output.mjs';
import { parseRows, parseSeriesOptions, searchUrl } from './lib/parse.mjs';
import { geocodeVenues, loadApiKey, tokyoDate } from '../lib/google-geocode.mjs';
import { geoForEvent, getEntry, loadCache, saveCache } from '../lib/venue-cache.mjs';

export const COLLECTOR_VERSION = 'conan-official/0.1.0';
const USER_AGENT = 'Mozilla/5.0 (compatible; shindan-navi-event-collector/0.1)';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');

const { values: opt } = parseArgs({
  options: {
    from: { type: 'string', default: '2026-11-18' },
    until: { type: 'string', default: '2027-02-18' },
    'delay-ms': { type: 'string', default: '1500' },
    'dry-run': { type: 'boolean', default: false },
    'accept-fingerprint-ids': { type: 'boolean', default: false },
    'from-raw': { type: 'string' },
    note: { type: 'string', multiple: true, default: [] },
    'no-geocode': { type: 'boolean', default: false },
    'geocode-max': { type: 'string' },
  },
});

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dayBefore = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const windowUrl = searchUrl({ date_from: opt.from, date_to: dayBefore(opt.until) });
const allUrl = searchUrl({});
const MAX_REQUESTS = 2;

async function fetchPages(outDir) {
  const delay = Math.max(1000, Number(opt['delay-ms']));
  const pages = {};
  let n = 0;
  for (const [name, url] of [['window', windowUrl], ['all', allUrl]]) {
    if (++n > MAX_REQUESTS) throw new Error('request budget exceeded');
    if (n > 1) await new Promise((r) => setTimeout(r, delay));
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000), redirect: 'error' });
    const body = await res.text();
    writeFileSync(join(outDir, `${name}.html`), body);
    log(`GET ${url} -> ${res.status} ${body.length} chars`);
    if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
    pages[name] = body;
  }
  return pages;
}

let fetchedAt;
let outDir;
let pages;
if (opt['from-raw']) {
  // --from-raw re-normalizes a saved out/run-*/ directory without touching the network.
  outDir = resolve(opt['from-raw']);
  fetchedAt = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8')).fetchedAt;
  pages = { window: readFileSync(join(outDir, 'window.html'), 'utf8'), all: readFileSync(join(outDir, 'all.html'), 'utf8') };
} else {
  fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  outDir = join(here, 'out', `run-${fetchedAt.replace(/:/g, '-')}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify({ fetchedAt, windowUrl, allUrl }, null, 2)}\n`);
  try {
    pages = await fetchPages(outDir);
  } catch (err) {
    writeFileSync(join(outDir, 'failure.txt'), `${err.stack}\n`);
    console.error(`FAILED: ${err.message}\nNothing written to data/events/. Diagnostics: ${outDir}`);
    process.exit(1);
  }
}

function fail(msg) {
  writeFileSync(join(outDir, 'failure.txt'), `${msg}\n`);
  console.error(`FAILED: ${msg}\nNothing written to data/events/. Diagnostics: ${outDir}`);
  process.exit(1);
}

const inWindow = (row) => {
  const d = parseStart(row.open_date).date;
  return d >= opt.from && d < opt.until;
};
const series = parseSeriesOptions(pages.window);
const rows = parseRows(pages.window);
const allRows = parseRows(pages.all);
const allInWindow = allRows.filter(inWindow);

// Coverage checks: the filtered query must return exactly the unfiltered list's rows for the window,
// every row must be in the window and belong to a listed series, and fingerprints must be unique.
if (rows.some((r) => !inWindow(r))) fail('filtered query returned rows outside the window');
if (rows.some((r) => !series.includes(r.series))) fail('row with a series missing from the eventtype options');
const ids = rows.map(fingerprint);
if (new Set(ids).size !== rows.length) fail(`fingerprint collision: ${rows.length} rows, ${new Set(ids).size} ids`);
const allIds = new Set(allInWindow.map(fingerprint));
if (allIds.size !== ids.length || ids.some((id) => !allIds.has(id))) {
  fail(`filtered (${ids.length}) and unfiltered (${allIds.size}) window rows differ`);
}

const events = sortEvents(rows.map((row) => normalizeEvent(row, fetchedAt)));

// Venue geo from the google cache (data/events/.venues/google.json). New lookups only with the key and
// without --dry-run / --no-geocode; cached geo older than 30 days is dropped either way.
const dataDir = join(repo, 'data', 'events');
const today = tokyoDate();
const geoCache = loadCache(dataDir, 'google');
const apiKey = loadApiKey(join(repo, '.env'));
let geoNote;
if (!apiKey || opt['dry-run'] || opt['no-geocode']) {
  geoNote = `Geocoding: skipped (${!apiKey ? 'no GOOGLE_GEOCODING_API_KEY' : opt['dry-run'] ? '--dry-run' : '--no-geocode'}); geo from the cache only.`;
  log(geoNote);
} else {
  const venues = events.map((e) => e.venue);
  const stats = await geocodeVenues(venues, geoCache, {
    key: apiKey,
    today,
    dataDir,
    max: opt['geocode-max'] ? Number(opt['geocode-max']) : Infinity,
    log,
  });
  geoNote = `Geocoding (Google, ${today}): ${stats.looked_up} venues looked up, ${stats.found} found, ${stats.negative} not found, ${stats.skipped_fresh} cached${stats.aborted ? `; aborted: ${stats.aborted}` : ''}.`;
  log(geoNote);
}
for (const e of events) if (e.venue) e.venue.geo = geoForEvent(getEntry(geoCache, e.venue), today);
// Rewriting the cache drops expired google lat/lng (place_id stays) even when nothing was looked up.
if (!opt['dry-run'] && Object.keys(geoCache.entries).length) saveCache(dataDir, geoCache, { today });
const withGeo = events.filter((e) => e.venue?.geo).length;
const seriesCounts = Object.fromEntries(series.map((s) => [s, rows.filter((r) => r.series === s).length]));
const external = events.filter((e) => /external_venue=/.test(e.source_status_text));
const run = {
  game_code: 'CONAN',
  source_code: 'conan_official',
  fetched_at: fetchedAt,
  window: { from: opt.from, until: opt.until },
  query: {
    endpoint: `https://www.takaratomy.co.jp/products/conan-cardgame/eventsearch`,
    params: { date_from: opt.from, date_to: `${dayBefore(opt.until)} (inclusive)` },
    window_url: windowUrl,
    crosscheck_url: allUrl,
    series_options: series,
    rows_per_series: seriesCounts,
    unfiltered_rows_total: allRows.length,
    unfiltered_rows_in_window: allInWindow.length,
  },
  source_total: null,
  record_count: events.length,
  complete: false,
  collector_version: COLLECTOR_VERSION,
  notes: [
    'Source: official Takara Tomy site, 公認店イベント 開催日程検索 (/products/conan-cardgame/eventsearch), server-rendered HTML, plain HTTPS GET, no login. One row = one store-hosted event with date and start time.',
    'Identity: the source exposes no event or store id. id = conan:sha1(series option | store name | store address | listed start)[:16]; a store edit to any of these yields a new id.',
    `Coverage: the page is unpaginated and states no total, so complete=false. Filtered query (${events.length} rows) matched the unfiltered list restricted to the window (${allInWindow.length}).`,
    `Searchable series at fetch time: ${series.join(', ')}. Later months are published as new series options; dates after the last listed series are empty because they are not published yet, not because they were skipped.`,
    'Not covered: official one-off events published only as article pages (e.g. ペア交流会 2026-11 at カードラボ stores, 探偵サミット), which have no structured listing.',
    'fee_amount comes from 参加条件: 0 only for 無料/0円, N for a plain N円, otherwise null (purchase conditions, table fees) with the text in fee_text. registration_* unknown: store notices are free text and not mapped.',
    `Venue: ${external.length} rows carry an [外部会場] notice; the stated external venue is used (name + address, or address only with the store name when the notice gives no venue name; source_status_text external_venue=1|address_only).`,
    'Store phone numbers listed on the page are not collected; notices (お知らせ) are not stored.',
    `${geoNote} ${withGeo}/${events.length} events have venue.geo (source google; shown on Google Maps only, dropped 30 days after geocoded_at).`,
    ...opt.note,
  ],
};

const validators = makeValidators(repo);
let files;
try {
  files = buildOutputs(events, run, validators);
} catch (err) {
  fail(err.message);
}
const staging = join(outDir, 'CONAN');
mkdirSync(staging, { recursive: true });
for (const [name, body] of Object.entries(files)) writeFileSync(join(staging, name), `${JSON.stringify(body, null, 2)}\n`);
log(`record_count=${events.length} series=${JSON.stringify(seriesCounts)} files=${Object.keys(files).join(',')}`);
log(`staged in ${staging}`);

if (opt['dry-run']) process.exit(0);
if (!opt['accept-fingerprint-ids']) {
  log('data/events/CONAN not touched: ids are content fingerprints; pass --accept-fingerprint-ids once the lead accepts them.');
  process.exit(0);
}
const target = join(repo, 'data', 'events', 'CONAN');
mkdirSync(target, { recursive: true });
for (const old of readdirSync(target)) if (/^(\d{4}-\d{2}|_run)\.json$/.test(old)) rmSync(join(target, old));
for (const name of Object.keys(files)) renameSync(join(staging, name), join(target, name));
log(`wrote ${Object.keys(files).length} files to ${target}`);
