// Collect Bushiroad title events from the Bushi Navi event search into data/events/<GAME>/ (see README.md).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chunks, collectChunk, CoverageError, LIST_PATH, listPath, PAGE_SIZE, rawCoverageGaps } from './lib/collect.mjs';
import { makeTransport } from './lib/http.mjs';
import { GAMES, normalizeEvent, sortEvents } from './lib/normalize.mjs';
import { buildOutputs, makeValidators } from './lib/output.mjs';

export const COLLECTOR_VERSION = 'bushi-navi/0.1.0';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');

const { values: opt } = parseArgs({
  options: {
    from: { type: 'string', default: '2026-11-18' },
    until: { type: 'string', default: '2027-02-18' },
    games: { type: 'string', default: Object.keys(GAMES).join(',') },
    'chunk-days': { type: 'string', default: '7' },
    'delay-ms': { type: 'string', default: '1100' },
    'max-requests': { type: 'string', default: '1500' },
    'dry-run': { type: 'boolean', default: false },
    resume: { type: 'string' },
    'from-raw': { type: 'string' },
    note: { type: 'string', multiple: true, default: [] },
  },
});

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const games = opt.games.split(',').map((s) => s.trim()).filter(Boolean);
for (const g of games) if (!GAMES[g]) throw new Error(`unknown game ${g}; one of ${Object.keys(GAMES).join(', ')}`);
const days = Number(opt['chunk-days']);
if (!/^\d+$/.test(opt['chunk-days']) || days < 1) {
  console.error(`FAILED: --chunk-days must be a positive integer, got ${JSON.stringify(opt['chunk-days'])}`);
  process.exit(1);
}
const plan = games.flatMap((game) => chunks(opt.from, opt.until, days).map((c) => ({ game, gameTitleId: GAMES[game].id, ...c })));
const chunkFile = (c) => `${c.game}-${c.startDate}.json`;

const fetched = opt['from-raw'] ? loadRaw(resolve(opt['from-raw'])) : await fetchAll();
const { fetchedAt, results, requests } = fetched;
const outDir = join(here, 'out', `run-${fetchedAt.replace(/:/g, '-')}`);

// The output window and _run.json `complete: true` come from the CLI flags, so the saved chunks must be exactly the
// requested plan; otherwise an import would drop events in weeks the capture never fetched.
function loadRaw(file) {
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const gaps = rawCoverageGaps(plan, saved.chunks.map((c) => c.chunk));
  if (gaps.length) {
    console.error(`FAILED: --from-raw ${file} does not match the requested window; pass the --from/--until/--games/--chunk-days it was fetched with.\n  ${gaps.slice(0, 10).join('\n  ')}${gaps.length > 10 ? `\n  ... ${gaps.length - 10} more` : ''}`);
    process.exit(1);
  }
  return { fetchedAt: saved.fetchedAt, requests: saved.requests, results: saved.chunks.filter((c) => games.includes(c.chunk.game)).map((c) => ({ ...c, rows: saved.rows.filter((r) => r._chunk === chunkFile(c.chunk)).map(({ _chunk, ...r }) => r) })) };
}

// Each finished chunk is saved under out/run-<ts>/chunks/, so `--resume out/run-<ts>` continues an interrupted run
// with the same fetched_at, window and games.
async function fetchAll() {
  let runDir;
  let state;
  if (opt.resume) {
    runDir = resolve(opt.resume);
    state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    if (state.from !== opt.from || state.until !== opt.until || state.games.join() !== games.join() || state.days !== days) {
      throw new Error(`--resume: ${runDir} was started with ${JSON.stringify(state)}; pass the same --from/--until/--games/--chunk-days`);
    }
  } else {
    const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    runDir = join(here, 'out', `run-${fetchedAt.replace(/:/g, '-')}`);
    state = { fetchedAt, from: opt.from, until: opt.until, games, days, requests: 0 };
  }
  mkdirSync(join(runDir, 'chunks'), { recursive: true });
  const saveState = () => writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  saveState();
  const transport = makeTransport({ delayMs: Number(opt['delay-ms']), maxRequests: Number(opt['max-requests']) });
  const results = [];
  let failure = null;
  try {
    for (const c of plan) {
      const file = join(runDir, 'chunks', chunkFile(c));
      if (existsSync(file)) { results.push(JSON.parse(readFileSync(file, 'utf8'))); continue; }
      let r;
      // A total that moves mid-pagination (an organizer just published or withdrew) is retried twice.
      for (let attempt = 1; ; attempt += 1) {
        try {
          r = await collectChunk(transport.fetchJson, c);
          break;
        } catch (err) {
          if (!(err instanceof CoverageError) || !/total changed/.test(err.message) || attempt >= 3) throw err;
          log(`retry: ${err.message}`);
        }
      }
      r.chunk = { game: c.game, ...r.chunk };
      writeFileSync(file, `${JSON.stringify(r)}\n`);
      results.push(r);
      state.requests = (state.requests ?? 0) + r.pages;
      saveState();
      log(`${c.game} ${c.startDate}..${c.endDate} groups=${r.total} events=${r.rows.length} pages=${r.pages} requests=${transport.requests()}`);
    }
  } catch (err) {
    failure = err;
  }
  if (failure) {
    writeFileSync(join(runDir, 'failure.txt'), `${failure.stack}\n`);
    console.error(`FAILED: ${failure.message}\nNothing written to data/events/. Resume: node collect.mjs --resume ${runDir}`);
    process.exit(1);
  }
  const rows = results.flatMap((r) => r.rows.map((row) => ({ _chunk: chunkFile(r.chunk), ...row })));
  writeFileSync(join(runDir, 'raw.json'), `${JSON.stringify({ fetchedAt: state.fetchedAt, requests: state.requests, plan, chunks: results.map(({ rows: _, ...m }) => m), rows }, null, 2)}\n`);
  return { fetchedAt: state.fetchedAt, results, requests: state.requests };
}

const validators = makeValidators(repo);
const outputs = {};
const summary = {};
for (const game of games) {
  const mine = results.filter((r) => r.chunk.game === game);
  const rows = mine.flatMap((r) => r.rows);
  const ids = new Set(rows.map((r) => r.id));
  if (ids.size !== rows.length) {
    console.error(`FAILED: ${game}: ${rows.length} rows but ${ids.size} distinct event ids`);
    process.exit(1);
  }
  const events = sortEvents(rows.map((row) => normalizeEvent(row, game, fetchedAt))
    .filter((e) => e.starts_on >= opt.from && e.starts_on < opt.until));
  const withGeo = events.filter((e) => e.venue?.geo).length;
  const cancelled = events.filter((e) => e.event_status === 'cancelled').length;
  const run = {
    game_code: game,
    source_code: 'bushinavi',
    fetched_at: fetchedAt,
    window: { from: opt.from, until: opt.until },
    query: {
      endpoint: `https://api-user.bushi-navi.com${LIST_PATH}`,
      params: { 'game_title_id[]': GAMES[game].id, start_date: 'YYYY-MM-DD (chunk start)', end_date: 'YYYY-MM-DD (chunk end, inclusive)', limit: PAGE_SIZE, offset: `0..step ${PAGE_SIZE}` },
      example: listPath({ gameTitleId: GAMES[game].id, startDate: mine[0].chunk.startDate, endDate: mine[0].chunk.endDate, offset: 0 }),
      chunks: mine.map((r) => ({ start_date: r.chunk.startDate, end_date: r.chunk.endDate, series_groups: r.total, events: r.rows.length, pages: r.pages })),
      requests: mine.reduce((n, r) => n + r.pages, 0),
      geo: { events_with_venue: events.filter((e) => e.venue).length, events_with_geo: withGeo },
    },
    source_total: null,
    record_count: events.length,
    complete: true,
    collector_version: COLLECTOR_VERSION,
    notes: [
      `Source: Bushi Navi event search API (public, no login), game_title_id ${GAMES[game].id} (${GAMES[game].name}).`,
      `Coverage: ${mine.length} chunks of ${days} days; the API's total counts series groups (series x organizer), not events, so source_total is null; each chunk was paged until distinct groups == total with total unchanged across pages, and every event is dated inside its chunk.`,
      'The API lists only events that have not started yet, so days before the fetch are empty; later weeks fill in as organizers publish.',
      `Geo: venue.geo from the event's place_geo (x = latitude, y = longitude); ${withGeo}/${events.length} events. Cancelled: ${cancelled}.`,
      'Organizer phone numbers and free-text notes are dropped at fetch time and never stored.',
      ...opt.note,
    ],
  };
  outputs[game] = buildOutputs(events, run, validators);
  summary[game] = { events: events.length, with_geo: withGeo, cancelled, requests: run.query.requests };
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify({ fetchedAt, requests, games: summary }, null, 2)}\n`);
log(`summary ${JSON.stringify(summary)}`);
if (opt['dry-run']) {
  log(`dry run: data/events not touched; see ${outDir}`);
  process.exit(0);
}

for (const [game, files] of Object.entries(outputs)) {
  const target = join(repo, 'data', 'events', game);
  const staging = join(outDir, game);
  mkdirSync(staging, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(staging, name), `${JSON.stringify(body, null, 2)}\n`);
  mkdirSync(target, { recursive: true });
  for (const old of readdirSync(target)) if (/^(\d{4}-\d{2}|_run)\.json$/.test(old)) rmSync(join(target, old));
  for (const name of Object.keys(files)) renameSync(join(staging, name), join(target, name));
  log(`wrote ${Object.keys(files).length} files to ${target}`);
}
