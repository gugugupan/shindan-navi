import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redactText } from './core.mjs';

const API = 'https://api.bandai-tcg-plus.com';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };

export function parseTrialOptions(args) {
  const options = { gameTitleId: 8, maxPages: 3, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') options.help = true;
    else if (['--game-title-id', '--max-pages'].includes(args[i])) {
      const flag = args[i];
      const value = args[++i];
      if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(Number(value))) fail(`Invalid ${flag}.`);
      options[flag === '--game-title-id' ? 'gameTitleId' : 'maxPages'] = Number(value);
    } else fail(`Unknown option: ${args[i]}`);
  }
  if (options.maxPages > 20) fail('--max-pages must be at most 20 for a trial.');
  return options;
}

export async function requestJson(url, fetchImpl, requests) {
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    fail(`GET ${url.pathname} failed (${error.cause?.code || error.code || error.name}); no response body or credentials recorded.`);
  }
  const observation = { url: url.toString(), status: response.status, duration_ms: Date.now() - started };
  requests.push(observation);
  if (!response.ok) fail(`GET ${url.pathname}: HTTP ${response.status}.`);
  if (!response.body) fail(`GET ${url.pathname}: missing response body.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 8 * 1024 * 1024) fail(`GET ${url.pathname}: response exceeds 8 MiB.`);
    chunks.push(Buffer.from(chunk));
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(`GET ${url.pathname}: invalid JSON.`); }
  if (!body?.success || body.error || typeof body.success.code !== 'number') fail(`GET ${url.pathname}: unexpected API envelope.`);
  observation.api_code = body.success.code;
  return body.success;
}

function sourceId(value, label) {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value > 0) &&
      !(typeof value === 'string' && /^[1-9]\d*$/.test(value))) fail(`Invalid ${label}.`);
  return String(value);
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`Missing ${label}.`);
  return redactText(value);
}

function projectSeries(row) {
  const id = sourceId(row.event_series_id, 'event_series_id');
  const result = { external_id: id, title: nonempty(row.title, 'series title'), canonical_url: `https://www.bandai-tcg-plus.com/series/${id}` };
  // These are application-period strings, not verified event dates or timezones.
  for (const key of ['apply_start_date', 'apply_end_date', 'display_apply_period']) {
    if (row[key] !== null && row[key] !== undefined && typeof row[key] !== 'string') fail(`Invalid series ${key}.`);
    result[key] = typeof row[key] === 'string' ? redactText(row[key]) : null;
  }
  if (row.series_type !== undefined && typeof row.series_type !== 'number') fail('Invalid series_type.');
  result.series_type = row.series_type ?? null;
  return result;
}

export async function collectSeriesTrial(options, { fetchImpl = fetch, delay = pause, requests = [] } = {}) {
  const master = await requestJson(new URL('/api/masterdata', API), fetchImpl, requests);
  if (!Array.isArray(master.game_title)) fail('Missing game_title directory.');
  const game = master.game_title.find(row => String(row.id) === String(options.gameTitleId));
  if (!game || typeof game.title !== 'string' || !/ONE\s*PIECE/i.test(game.title)) fail('Selected game ID is not verified as ONE PIECE by masterdata.');
  const selectedGame = {
    external_id: sourceId(game.id, 'game title ID'), title: redactText(game.title),
    language_code: typeof game.language_code === 'string' ? redactText(game.language_code) : null,
    source_game_title_code: typeof game.game_title_code === 'string' ? redactText(game.game_title_code) : null
  };
  const limit = 11;
  const series = [];
  const ids = new Set();
  let total;
  let pages = 0;
  for (; pages < options.maxPages;) {
    await delay(750);
    const url = new URL('/api/user/eventseries', API);
    url.search = new URLSearchParams({ game_title_id: selectedGame.external_id, country_code: 'JP', limit: String(limit), offset: String(pages * limit) }).toString();
    const page = await requestJson(url, fetchImpl, requests);
    const count = page.total;
    if (!((typeof count === 'string' && /^\d+$/.test(count)) || (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0))) fail('Invalid event-series total.');
    const currentTotal = Number(count);
    if (!Number.isSafeInteger(currentTotal)) fail('Event-series total exceeds integer range.');
    if (total !== undefined && total !== currentTotal) fail('Event-series total changed while paging; retry as a new trial.');
    total = currentTotal;
    if (!Array.isArray(page.event_series_list) || page.event_series_list.length > limit) fail('Invalid event_series_list.');
    for (const row of page.event_series_list) {
      const projected = projectSeries(row);
      if (ids.has(projected.external_id)) fail('Repeated event-series ID across pages; pagination is not stable.');
      ids.add(projected.external_id);
      series.push(projected);
    }
    pages++;
    if (series.length > total) fail('Received more series than the declared total.');
    if (series.length === total) break;
    if (page.event_series_list.length < limit) fail('Short or empty page before declared total; collection is incomplete.');
  }
  return {
    status: series.length ? 'series_sample_collected' : 'series_trial_empty', selected_game: selectedGame,
    country_code: 'JP', pages, declared_total: total, collected: series.length,
    complete_series_listing: series.length === total, multiple_pages_fetched: pages > 1,
    api_code_semantics_verified: false,
    scope: 'Event series only; no individual events, venue/time filters or import verified.',
    requests, series
  };
}

export async function runTrial(options) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', `trial-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const requests = [];
  let report;
  try {
    report = { started_at: startedAt, ...await collectSeriesTrial(options, { requests }) };
  } catch (error) {
    report = { started_at: startedAt, status: 'failed', error: redactText(error.message), requests };
  }
  report.$schema = 'report.schema.json';
  report.finished_at = new Date().toISOString();
  await fs.copyFile(new URL('./trial-report.schema.json', import.meta.url), path.join(out, 'report.schema.json'), fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, collected: report.collected, complete_series_listing: report.complete_series_listing, error: report.error, report: path.join(out, 'report.json') }, null, 2));
  return report.status === 'series_sample_collected' ? 0 : report.status === 'series_trial_empty' ? 2 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseTrialOptions(process.argv.slice(2));
    if (options.help) console.log('Read-only ONE PIECE series trial: trial.mjs [--game-title-id 8] [--max-pages 3]\nGET only; saves an isolated local report. No database or production changes.');
    else process.exitCode = await runTrial(options);
  } catch (error) { console.error(redactText(error.message)); process.exitCode = 1; }
}
