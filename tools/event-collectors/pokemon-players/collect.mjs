// Collect PTCG events from players.pokemon-card.com into data/events/PTCG/ (see README.md).
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chunks, collectChunk, PAGE_SIZE, searchUrl } from './lib/collect.mjs';
import { normalizeEvent, sortEvents } from './lib/normalize.mjs';
import { buildOutputs, makeValidators } from './lib/output.mjs';
import { openBrowserTransport } from './lib/transport.mjs';
import { applyGeo, geoPass, tokyoDate, venueLookups } from './lib/geo.mjs';
import { loadCache, saveCache } from '../lib/venue-cache.mjs';

export const COLLECTOR_VERSION = 'pokemon-players/0.2.0';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');

const { values: opt } = parseArgs({
  options: {
    from: { type: 'string', default: '2026-11-18' },
    until: { type: 'string', default: '2027-02-18' },
    'chunk-days': { type: 'string', default: '1' },
    'delay-ms': { type: 'string', default: '1000' },
    'max-requests': { type: 'string', default: '1500' },
    'max-detail-requests': { type: 'string', default: '3000' },
    geo: { type: 'string', default: 'lookup' },
    profile: { type: 'string', default: process.env.PTCG_PROFILE ?? join(here, '.session', 'chrome') },
    headless: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'from-raw': { type: 'string' },
    note: { type: 'string', multiple: true, default: [] },
  },
});

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const plan = chunks(opt.from, opt.until, Number(opt['chunk-days']));
if (!['lookup', 'cache'].includes(opt.geo)) throw new Error('--geo must be lookup or cache');
const dataDir = join(repo, 'data', 'events');

let transport = null;
async function openTransport() {
  transport ??= await openBrowserTransport({
    profileDir: resolve(opt.profile),
    headless: opt.headless,
    delayMs: Number(opt['delay-ms']),
    maxRequests: Number(opt['max-requests']) + Number(opt['max-detail-requests']),
  });
  return transport;
}

// --from-raw re-normalizes a saved out/run-*/raw.json without touching the network.
const fetched = opt['from-raw'] ? loadRaw(resolve(opt['from-raw'])) : await fetchAll();
const { fetchedAt, results, windowBefore, windowAfter, requests } = fetched;
const outDir = join(here, 'out', `run-${fetchedAt.replace(/:/g, '-')}`);
const raw = results.flatMap((r) => r.rows);

function loadRaw(file) {
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  let meta = saved.meta;
  if (!meta) {
    const q = JSON.parse(readFileSync(join(dirname(file), 'summary.json'), 'utf8')).query;
    meta = { windowBefore: q.window_event_count.before, windowAfter: q.window_event_count.after, requests: q.requests };
  }
  const rows = new Map(saved.rows.map((r) => [String(r.event_holding_id), r]));
  const results = saved.chunks.map((c) => ({ ...c, rows: [] }));
  for (const r of saved.rows) {
    const day = String(r.event_date_params);
    const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
    results.find((c) => iso >= c.chunk.startDate && iso <= c.chunk.endDate).rows.push(r);
  }
  if (rows.size !== saved.rows.length) throw new Error('raw file has duplicate ids');
  return { fetchedAt: saved.fetchedAt, results, ...meta };
}

async function fetchAll() {
  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const outDir = join(here, 'out', `run-${fetchedAt.replace(/:/g, '-')}`);
  mkdirSync(outDir, { recursive: true });
  await openTransport();
  const results = [];
  const windowCheck = { startDate: opt.from, endDate: plan.at(-1).endDate };
  const windowCount = async () => (await collectChunk(transport.fetchJson, windowCheck, { maxPages: 1, countOnly: true })).total;
  let failure = null;
  let windowBefore = null;
  let windowAfter = null;
  try {
    windowBefore = await windowCount();
    log(`window ${windowCheck.startDate}..${windowCheck.endDate} eventCount=${windowBefore}`);
    for (const c of plan) {
      const r = await collectChunk(transport.fetchJson, c);
      log(`${c.startDate}..${c.endDate} total=${r.total} pages=${r.pages} requests=${transport.requests()}`);
      results.push(r);
    }
    windowAfter = await windowCount();
    const sum = results.reduce((n, r) => n + r.total, 0);
    if (sum !== windowAfter) throw new Error(`chunk totals ${sum} != whole-window eventCount ${windowAfter} (before: ${windowBefore})`);
  } catch (err) {
    failure = err;
  }
  const meta = { windowBefore, windowAfter, requests: transport.requests() };
  const rows = results.flatMap((r) => r.rows);
  writeFileSync(join(outDir, 'raw.json'), `${JSON.stringify({ fetchedAt, plan, meta, chunks: results.map(({ rows: _, ...m }) => m), rows }, null, 2)}\n`);
  if (failure) {
    await transport.close();
    writeFileSync(join(outDir, 'failure.txt'), `${failure.stack}\n`);
    console.error(`FAILED: ${failure.message}\nNothing written to data/events/. Diagnostics: ${outDir}`);
    process.exit(1);
  }
  return { fetchedAt, results, ...meta };
}

const sourceTotal = results.reduce((n, r) => n + r.total, 0);
const ids = new Set(raw.map((r) => String(r.event_holding_id)));
if (ids.size !== raw.length || ids.size !== sourceTotal) {
  console.error(`FAILED: ${ids.size} distinct ids, ${raw.length} rows, source total ${sourceTotal}`);
  process.exit(1);
}

const pairs = raw.map((row) => ({ event: normalizeEvent(row, fetchedAt), row }))
  .filter(({ event: e }) => e.starts_on >= opt.from && e.starts_on < opt.until);
const events = sortEvents(pairs.map((p) => p.event));

// Geo pass: one detail request per venue not yet in data/events/.venues/ptcg.json. --dry-run and
// --geo cache only read the cache.
const today = tokyoDate();
const cache = loadCache(dataDir, 'ptcg');
const lookups = venueLookups(pairs);
let geoStats = { venues: lookups.length, todo: 0, requests: 0, found: 0, negative: 0, skipped: 0, errors: 0, stopped: 'lookups disabled' };
if (opt.geo === 'lookup' && !opt['dry-run']) {
  const t = await openTransport();
  const save = () => saveCache(dataDir, cache);
  const onSignal = () => { save(); console.error('interrupted; venue cache saved'); process.exit(130); };
  process.once('SIGINT', onSignal).once('SIGTERM', onSignal);
  const pending = lookups.length;
  log(`geo pass: ${pending} venues, looking up those not cached (>=${opt['delay-ms']} ms apart)`);
  try {
    geoStats = await geoPass({ fetchJson: t.fetchJson, cache, lookups, today, save, maxRequests: Number(opt['max-detail-requests']), log });
  } finally {
    process.off('SIGINT', onSignal).off('SIGTERM', onSignal);
  }
  log(`geo pass: ${JSON.stringify(geoStats)}`);
}
if (transport) await transport.close();
const geoCoverage = applyGeo(events, cache, today);
const cachedVenues = lookups.filter((l) => cache.entries[l.key]).length;
const geoVenues = lookups.filter((l) => cache.entries[l.key]?.geo).length;
log(`geo: venues ${geoVenues}/${lookups.length} with coordinates (${cachedVenues} looked up), events ${geoCoverage.events_with_geo}/${geoCoverage.events_with_venue}`);
const run = {
  game_code: 'PTCG',
  source_code: 'pokemon_players',
  fetched_at: fetchedAt,
  window: { from: opt.from, until: opt.until },
  query: {
    endpoint: 'https://players.pokemon-card.com/event_search',
    params: { order: 1, start_date: 'YYYY/MM/DD (chunk start)', end_date: 'YYYY/MM/DD (chunk end, inclusive)', offset: `0..step ${PAGE_SIZE}` },
    example: searchUrl({ ...plan[0], offset: 0 }),
    chunks: results.map((r) => ({ start_date: r.chunk.startDate, end_date: r.chunk.endDate, event_count: r.total, pages: r.pages })),
    window_event_count: { before: windowBefore, after: windowAfter },
    requests,
    geo: {
      endpoint: 'https://players.pokemon-card.com/event_detail_search',
      params: 'event_holding_id, trainers_flg, shop_id, event_date, date_id of one event per venue',
      venues: lookups.length,
      venues_with_geo: geoVenues,
      venues_checked: cachedVenues,
      detail_requests: geoStats.requests,
      detail_errors: geoStats.errors,
      stopped: geoStats.stopped,
      ...geoCoverage,
    },
  },
  source_total: sourceTotal,
  record_count: events.length,
  complete: events.length === sourceTotal,
  collector_version: COLLECTOR_VERSION,
  notes: [
    'Source: players.pokemon-card.com /event_search (public, no login), fetched from a normal Chrome page because plain HTTPS clients get a Cloudflare 403.',
    `Coverage: ${results.length} one-day chunks; each chunk paged until distinct event_holding_id == eventCount; chunk sum checked against whole-window eventCount (before ${windowBefore}, after ${windowAfter}).`,
    'Window: the source only lists events organizers have already published; later dates fill in over time, so empty future days are not an error.',
    `Geo: venue.geo from the event detail field geocoding ("lat,lng"), one detail request per venue (shop_id, else name+address), cached in data/events/.venues/ptcg.json; ${geoVenues}/${lookups.length} venues and ${geoCoverage.events_with_geo}/${geoCoverage.events_with_venue} events have coordinates.`,
    'registration_method/status/platform are unknown: the list API carries no application state (the site derives it client-side from per-event detail data).',
    ...opt.note,
  ],
};

const validators = makeValidators(repo);
const files = buildOutputs(events, run, validators);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify({ ...run, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Array.isArray(v) ? v.length : 'run'])) }, null, 2)}\n`);
log(`source_total=${sourceTotal} record_count=${events.length} files=${Object.keys(files).join(',')}`);
if (opt['dry-run']) {
  log(`dry run: data/events/PTCG not touched; see ${outDir}`);
  process.exit(0);
}

const target = join(repo, 'data', 'events', 'PTCG');
const staging = join(outDir, 'PTCG');
mkdirSync(staging, { recursive: true });
for (const [name, body] of Object.entries(files)) writeFileSync(join(staging, name), `${JSON.stringify(body, null, 2)}\n`);
mkdirSync(target, { recursive: true });
for (const old of readdirSync(target)) if (/^(\d{4}-\d{2}|_run)\.json$/.test(old)) rmSync(join(target, old));
for (const name of Object.keys(files)) renameSync(join(staging, name), join(target, name));
log(`wrote ${Object.keys(files).length} files to ${target}`);
JSON.parse(readFileSync(join(target, '_run.json'), 'utf8'));
