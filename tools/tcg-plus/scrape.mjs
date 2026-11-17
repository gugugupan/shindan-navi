import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { requestJson } from './trial.mjs';
import { redactText } from './core.mjs';

const API = 'https://api.bandai-tcg-plus.com';
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };

function positiveInt(value, label) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail(`Invalid ${label}.`);
  return Number(value);
}

function dateOption(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('Dates must be valid YYYY-MM-DD values.');
  return value;
}

export function parseScrapeOptions(args) {
  const options = { gameTitleId: 8, country: 'JP', pageSize: 20, maxPages: 10000, from: null, until: null, help: false };
  const names = { '--game-title-id': 'gameTitleId', '--page-size': 'pageSize', '--max-pages': 'maxPages', '--from': 'from', '--until': 'until' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { options.help = true; continue; }
    const name = names[args[i]];
    if (!name) fail(`Unknown option: ${args[i]}`);
    const value = args[++i];
    options[name] = ['from', 'until'].includes(name) ? dateOption(value) : positiveInt(value, name);
  }
  if (![20, 40, 60, 80, 100].includes(options.pageSize)) fail('Page size must be one of the website options: 20, 40, 60, 80, 100.');
  if (options.maxPages > 10000) fail('Maximum page budget is 10000.');
  if (options.from && options.until && options.from > options.until) fail('--from must not be later than --until.');
  return options;
}

export function eventListUrl(options, offset) {
  const url = new URL('/api/user/event/list', API);
  for (const [key, value] of Object.entries({ game_title_id: options.gameTitleId, 'country_code[]': options.country, limit: options.pageSize, offset, application_open_flg: 0, order: 1 })) url.searchParams.set(key, String(value));
  // Preserve the date form observed in successful live list requests.
  if (options.from) url.searchParams.set('start_date', options.from);
  if (options.until) url.searchParams.set('end_date', options.until);
  return url;
}

const textOrNull = value => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail('Unexpected public text field type in an event record.');
  return redactText(value);
};
const scalarOrNull = value => {
  if (value === null || value === undefined) return null;
  if (!['string', 'number', 'boolean'].includes(typeof value)) fail('Unexpected public scalar field type in an event record.');
  return typeof value === 'string' ? redactText(value) : value;
};

export function prefectureNames(master) {
  const names = new Map();
  for (const area of Object.values(master.area || {})) {
    for (const country of Object.values(area.country_list || {})) {
      if (country.country_code !== 'JP') continue;
      for (const [key, pref] of Object.entries(country.pref_list || {})) {
        if (typeof pref.name === 'string') names.set(String(pref.pref_code || key), redactText(pref.name));
      }
    }
  }
  return names;
}

export function projectEvent(row, prefNames = new Map()) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('Invalid event record.');
  const id = String(positiveInt(row.id, 'event ID'));
  const title = row.event_title ?? row.title ?? row.event_series_title;
  if (typeof title !== 'string' || !title.trim()) fail('Missing event title; source field mapping needs review.');
  const groupId = row.event_series_id == null ? null : String(positiveInt(row.event_series_id, 'event-series ID'));
  return {
    source: 'bandai_tcg_plus', external_id: id, game_code: 'OPCG',
    title: redactText(title), event_series_id: groupId,
    event_series_title: textOrNull(row.event_series_title ?? row.series_title),
    canonical_url: `https://www.bandai-tcg-plus.com/event/${id}`,
    start_datetime_source: textOrNull(row.start_datetime),
    start_datetime_hidden_type_source: scalarOrNull(row.start_datetime_hidden_type),
    timezone_source: scalarOrNull(row.timezone),
    organizer_id: row.organizer_id == null ? null : String(positiveInt(row.organizer_id, 'organizer ID')),
    venue_name: textOrNull(row.organizer_name), country_code: 'JP',
    pref_code_source: scalarOrNull(row.pref_code), pref_name: textOrNull(row.pref_name ?? prefNames.get(String(row.pref_code))),
    city_address: textOrNull(row.city_address), street_address: textOrNull(row.street_address),
    postcode: scalarOrNull(row.postcode), online_flag_source: scalarOrNull(row.online_flag),
    entry_fee_source: scalarOrNull(row.entry_fee ?? row.entryFee), entry_fee_currency_code: textOrNull(row.entry_fee_currency_code),
    entry_fee_hidden_source: scalarOrNull(row.entry_fee_hidden ?? row.hidden_entry_fee),
    capacity_source: scalarOrNull(row.max_join_count), capacity_hidden_source: scalarOrNull(row.is_capacity_hidden),
    status_id_source: scalarOrNull(row.status_id), is_canceled_source: scalarOrNull(row.is_canceled),
    apply_start_datetime_source: textOrNull(row.apply_start_datetime),
    apply_end_datetime_source: textOrNull(row.apply_end_datetime),
    application_open_source: scalarOrNull(row.applicationOpen),
    registration_status: 'unknown'
  };
}

function successCode(response) {
  if (response.code !== 200) fail('Unexpected source API code; collection stopped without saving event data.');
  return response;
}

export async function collectCompetitions(options, { fetchImpl = fetch, sleep = delay, requests = [], onProgress = () => {} } = {}) {
  const master = successCode(await requestJson(new URL('/api/masterdata', API), fetchImpl, requests));
  if (!Array.isArray(master.game_title)) fail('Missing game-title directory.');
  const game = master.game_title.find(entry => String(entry.id) === String(options.gameTitleId));
  if (!game || !/ONE\s*PIECE/i.test(game.title || '') || !/^ja$/i.test(game.language_code || '')) fail('Game ID is not verified as Japanese ONE PIECE in masterdata.');
  const prefNames = prefectureNames(master);
  const events = [];
  const ids = new Set();
  let expectedTotal;
  let sharedSeries;
  let pages = 0;
  while (pages < options.maxPages) {
    await sleep(750);
    const body = successCode(await requestJson(eventListUrl(options, pages * options.pageSize), fetchImpl, requests));
    if (!/^(0|[1-9]\d*)$/.test(String(body.total)) || !Number.isSafeInteger(Number(body.total))) fail('Invalid source total.');
    const total = Number(body.total);
    if (expectedTotal !== undefined && total !== expectedTotal) fail('Source total changed during collection; rerun as a new snapshot.');
    expectedTotal = total;
    if (!Array.isArray(body.event_list) || body.event_list.length > options.pageSize) fail('Invalid event_list response.');
    for (const row of body.event_list) {
      const event = projectEvent(row, prefNames);
      if (ids.has(event.external_id)) fail('Duplicate event ID; source pagination is unstable.');
      let scopeMatch = row.game_title_id == null ? 'query_only' : 'direct_game';
      if (row.game_title_id != null && String(row.game_title_id) !== String(options.gameTitleId)) {
        if (!sharedSeries) {
          const params = successCode(await requestJson(new URL('/api/user/event/list/params', API), fetchImpl, requests));
          if (!Array.isArray(params.event_series_with_game_title_id)) fail('Missing series game-membership directory.');
          sharedSeries = new Map(params.event_series_with_game_title_id.map(series => [String(series.event_series_id), series]));
        }
        const membership = sharedSeries.get(event.event_series_id);
        const gameIds = String(membership?.event_series_game_title_ids || '').split(',').map(id => id.trim());
        if (String(membership?.game_title_id) !== String(row.game_title_id) || !gameIds.includes(String(options.gameTitleId))) fail(`Source returned an event for another game (event ${event.external_id}, game_title_id ${redactText(String(row.game_title_id))}).`);
        scopeMatch = 'series_game_membership';
      }
      if (row.country_code != null && row.country_code !== options.country) fail('Source returned an event for another country.');
      ids.add(event.external_id);
      event.source_game_title_id = row.game_title_id == null ? null : String(row.game_title_id);
      event.game_scope_match = scopeMatch;
      events.push(event);
    }
    pages++;
    onProgress({ pages, collected: events.length, source_total: total });
    if (events.length > total) fail('Event count exceeds source total.');
    if (events.length === total) return {
      selected_game: { external_id: String(game.id), title: redactText(game.title), language_code: game.language_code },
      coverage: { complete_for_source_total: true, source_total: total, collected: events.length, pages },
      events
    };
    if (body.event_list.length < options.pageSize) fail('Premature short or empty page; collection is incomplete.');
  }
  fail('Page budget exhausted before source total; no complete event list saved.');
}

export async function runScrape(options, { collector = collectCompetitions, outRoot = path.join(TOOL_DIR, 'out'), log = console.log, transport = 'direct' } = {}) {
  const out = path.join(outRoot, `events-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const report = {
    started_at: new Date().toISOString(), source: 'bandai_tcg_plus', transport,
    query: { game_title_id: options.gameTitleId, country_code: options.country, from: options.from, until: options.until, application_open_only: false },
    requests: [],
    coverage_note: 'All records counted by this source query. Source defaults, archive retention, unpublished/private events and date-boundary semantics are not independently verified.',
    field_mapping_note: 'Observed public event-list fields. Source date/time, fee, status and hidden-field flags are preserved without inference.'
  };
  try {
    const result = await collector(options, { requests: report.requests, onProgress: state => {
      report.progress = state;
      log(JSON.stringify(state));
    } });
    const dataPath = path.join(out, 'competitions.json');
    const schema = JSON.parse(await fs.readFile(new URL('./competitions.schema.json', import.meta.url), 'utf8'));
    await fs.writeFile(path.join(out, 'competitions.schema.json'), JSON.stringify(schema, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.writeFile(dataPath + '.part', JSON.stringify(result.events, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(dataPath + '.part', dataPath);
    Object.assign(report, { status: result.events.length ? 'collected' : 'empty', selected_game: result.selected_game, coverage: result.coverage, data_file: 'competitions.json', schema_file: 'competitions.schema.json' });
  } catch (error) {
    report.status = 'failed';
    report.error = redactText(error.message);
  }
  report.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  log(JSON.stringify({ status: report.status, collected: report.coverage?.collected, error: report.error, report: path.join(out, 'report.json'), data: report.data_file ? path.join(out, report.data_file) : null }, null, 2));
  return { report, out, exitCode: report.status === 'failed' ? 1 : 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseScrapeOptions(process.argv.slice(2));
    if (options.help) console.log('ONE PIECE Japan event collector\n[--game-title-id 8] [--page-size 20] [--max-pages 10000] [--from YYYY-MM-DD] [--until YYYY-MM-DD]\nExhausts the public source event list. No database import, browser actions or deployment.');
    else process.exitCode = (await runScrape(options)).exitCode;
  } catch (error) { console.error(redactText(error.message)); process.exitCode = 1; }
}
