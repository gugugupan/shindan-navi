import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACTS = path.resolve(HERE, '../../contracts');
export const COLLECTOR_VERSION = 'tcg-plus-collector/1';
const fail = message => { throw new Error(message); };

// Ordered: the first match wins, so specific series names come before generic words.
const SERIES_RULES = [
  [/ティーチング|体験会|講習|教室|はじめて|初めて|ビギナー/, 'teaching', 'teaching'],
  [/CHAMPIONSHIP|チャンピオンシップ/i, 'tournament', /予選/, 'championship_qualifier', 'championship'],
  [/スタンダードバトル|Standard\s*Battle/i, 'tournament', 'standard_battle'],
  [/フラッグシップバトル|Flagship\s*Battle/i, 'tournament', 'flagship_battle'],
  [/ユニチケゲットバトル/, 'tournament', 'unichike_get_battle'],
  [/ユニオンレア争奪バトル/, 'tournament', 'union_rare_battle'],
  [/ONE\s*BATTLE\s*CUP/i, 'tournament', 'one_battle_cup'],
  [/交流会/, 'casual', 'meetup'],
  [/フリー対戦|フリープレイ/, 'casual', 'free_play'],
  [/フェス|フェスタ|Fest/i, 'festival', null],
  [/バトル|大会|CS|ジムバトル|杯|カップ|CUP|予選/i, 'tournament', null]
];

export function classifySeries(title) {
  const text = String(title || '');
  for (const rule of SERIES_RULES) {
    if (!rule[0].test(text)) continue;
    if (rule.length === 5) return { category: rule[1], event_type_code: rule[2].test(text) ? rule[3] : rule[4] };
    return { category: rule[1], event_type_code: rule[2] };
  }
  return { category: 'unknown', event_type_code: null };
}

const offsetCache = new Map();
// Offset (minutes) of an IANA zone at a given UTC instant; null when the zone is unknown to Intl.
function zoneOffsetMinutes(timeZone, instant) {
  let format = offsetCache.get(timeZone);
  if (format === undefined) {
    try { format = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }); } catch { format = null; }
    offsetCache.set(timeZone, format);
  }
  if (!format) return null;
  const name = format.formatToParts(instant).find(part => part.type === 'timeZoneName')?.value || '';
  if (name === 'GMT') return 0;
  const match = name.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : null;
}

export function isJstZone(timeZone, localDate) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  return zoneOffsetMinutes(timeZone, new Date(`${localDate}T03:00:00Z`)) === 540;
}

export function toJst(utcText) {
  if (utcText == null || utcText === '') return null;
  const ms = Date.parse(utcText);
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(utcText) || !Number.isFinite(ms)) fail(`Unparseable source timestamp: ${utcText}`);
  return new Date(ms + 9 * 3600e3).toISOString().slice(0, 19) + '+09:00';
}

const START = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const REGION = /^JP-(0[1-9]|[1-3][0-9]|4[0-7])$/;
const truthy = value => value === true || value === 1 || value === '1';
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

export function registrationStatus(record, fetchedAt) {
  if (truthy(record.is_canceled_source) || record.no_use_tcg_plus_source === true) return 'unknown';
  const status = Number(record.status_id_source);
  const now = Date.parse(fetchedAt);
  const opens = record.apply_start_datetime_source ? Date.parse(record.apply_start_datetime_source) : null;
  const closes = record.apply_end_datetime_source ? Date.parse(record.apply_end_datetime_source) : null;
  if (status === 11) {
    if (opens != null && opens > now) return 'not_open';
    // The site shows 応募受付中 / キャンセル待ち受付中 for this combination.
    if (String(record.application_open_source) === '1' && opens != null && (closes == null || closes >= now)) {
      return record.is_over_max_join_count_source === true ? 'waitlist' : 'open';
    }
    return 'unknown';
  }
  if ([21, 31, 51, 61].includes(status)) return 'closed';
  return 'unknown';
}

export function eventStatus(record) {
  if (truthy(record.is_canceled_source)) return 'cancelled';
  if (Number(record.status_id_source) === 61) return 'completed';
  if ([11, 21, 31, 51].includes(Number(record.status_id_source))) return 'scheduled';
  return 'unknown';
}

const ENTRY_METHOD = { 1: 'first_come', 2: 'lottery', 3: 'other' };

function postalCode(value) {
  const digits = value == null ? '' : String(value).trim();
  return /^\d{7}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3)}` : null;
}

/** Returns { event } or { skip: reason } for one projected TCG+ record (scrape.mjs projectEvent). */
export function normalizeEvent(record, { fetchedAt }) {
  const id = String(record.external_id || '');
  if (!/^[1-9]\d*$/.test(id)) fail('Record without a numeric external_id.');
  const hidden = record.start_datetime_hidden_type_source == null ? null : Number(record.start_datetime_hidden_type_source);
  if (hidden === 2) return { skip: 'start_date_hidden' };
  const start = START.exec(record.start_datetime_source || '');
  if (!start) return { skip: 'start_unparseable' };
  const [, date, hh, mm, ss] = start;
  const timed = hh != null && hidden == null && isJstZone(record.timezone_source, date);

  const seriesTitle = text(record.event_series_title);
  const ownTitle = text(record.title);
  const name = seriesTitle && ownTitle && ownTitle !== seriesTitle ? `${seriesTitle} / ${ownTitle}` : seriesTitle || ownTitle;
  if (!name) return { skip: 'missing_name' };

  const online = record.online_flag_source == null ? null : truthy(record.online_flag_source);
  const attendance = online === null ? 'unknown' : online ? 'online' : 'in_person';
  const venueName = text(record.venue_name);
  const region = REGION.test(record.pref_code_source || '') ? record.pref_code_source : null;
  const venue = attendance === 'online' || !venueName ? null : {
    name: venueName,
    source_id: record.organizer_id == null ? null : String(record.organizer_id),
    country_code: 'JP',
    region_code: region,
    region_name: region ? text(record.pref_name) : null,
    city: null,
    address: [text(record.pref_name), text(record.city_address), text(record.street_address)].filter(Boolean).join('') || null,
    postal_code: postalCode(record.postcode)
  };

  const formats = [...new Set((record.game_format_names || []).filter(Boolean))];
  const usesTcgPlus = record.no_use_tcg_plus_source !== true;
  const singlePlayer = record.team_count_source == null || record.team_count_source === 1;
  const capacity = truthy(record.capacity_hidden_source) || !singlePlayer || record.capacity_source == null ? null : Number(record.capacity_source);
  const group = seriesTitle ? classifySeries(seriesTitle) : { category: 'unknown', event_type_code: null };
  const sourceUrl = `https://www.bandai-tcg-plus.com/event/${id}`;

  return { event: {
    id: `tcgp:${id}`,
    game_code: record.game_code,
    source_code: 'bandai_tcg_plus',
    external_id: id,
    source_url: sourceUrl,
    group: { source_id: record.event_series_id == null ? null : String(record.event_series_id), name: seriesTitle || name, ...group },
    name,
    attendance_mode: attendance,
    venue,
    starts_on: date,
    ends_on: null,
    starts_at: timed ? `${date}T${hh}:${mm}:${ss || '00'}+09:00` : null,
    ends_at: null,
    timezone: 'Asia/Tokyo',
    time_precision: timed ? 'datetime' : 'date',
    format_text: formats.length ? formats.join(' / ') : null,
    eligibility_text: text(record.participation_condition),
    capacity: Number.isSafeInteger(capacity) && capacity >= 0 ? capacity : null,
    // The list API omits hidden_entry_fee, and sampled events report 0 with the fee hidden.
    fee_amount: null,
    fee_currency: null,
    fee_text: null,
    registration_method: usesTcgPlus ? ENTRY_METHOD[record.entry_type_source] || 'unknown' : 'unknown',
    registration_platform: usesTcgPlus ? 'bandai_tcg_plus' : null,
    registration_url: usesTcgPlus ? sourceUrl : null,
    registration_opens_at: toJst(record.apply_start_datetime_source),
    registration_closes_at: toJst(record.apply_end_datetime_source),
    registration_status: registrationStatus(record, fetchedAt),
    event_status: eventStatus(record),
    source_status_text: [
      `status_id=${record.status_id_source ?? ''}`, `canceled=${truthy(record.is_canceled_source) ? 1 : 0}`,
      `applicationOpen=${record.application_open_source ?? ''}`, `entry_type=${record.entry_type_source ?? ''}`,
      `over_max=${record.is_over_max_join_count_source ? 1 : 0}`, `timezone=${record.timezone_source ?? ''}`,
      `start_hidden=${hidden ?? ''}`
    ].join(';'),
    last_seen_at: fetchedAt
  } };
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function sortEvents(events) {
  return events.sort((a, b) => compare(a.starts_on, b.starts_on) ||
    (a.starts_at === b.starts_at ? 0 : a.starts_at == null ? 1 : b.starts_at == null ? -1 : compare(a.starts_at, b.starts_at)) ||
    compare(a.id, b.id));
}

export async function loadValidators(contracts = CONTRACTS) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const read = async name => JSON.parse(await fs.readFile(path.join(contracts, name), 'utf8'));
  return { events: ajv.compile(await read('event.schema.json')), run: ajv.compile(await read('run.schema.json')), ajv };
}

/**
 * Builds month files + _run.json for one completed collection. Throws on any coverage or schema failure,
 * so callers can write all-or-nothing.
 */
export function buildOutputs({ records, report, game, window, validators, notes = [] }) {
  const coverage = report.coverage || {};
  if (report.status !== 'collected' && report.status !== 'empty') fail(`Collection status is ${report.status}; nothing written.`);
  if (!(coverage.complete_for_source_total === true && coverage.collected === coverage.source_total && records.length === coverage.source_total)) fail('Collection is not complete for the source total; nothing written.');
  const query = report.source_query || {};
  if (!query.start_date || query.start_date > window.from) fail('Source query does not start on or before the window.');
  if (query.end_date && query.end_date < window.until) fail('Source query ends before the window; nothing written.');
  if (records.some(r => r.game_code !== game)) fail('Collected records belong to another game code.');
  const ids = new Set(records.map(r => r.external_id));
  if (ids.size !== records.length) fail('Duplicate source ids in collection.');

  const fetchedAt = new Date(Date.parse(report.started_at)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const skipped = {};
  const events = [];
  let before = 0, after = 0;
  for (const record of records) {
    const result = normalizeEvent(record, { fetchedAt });
    if (result.skip) { skipped[result.skip] = (skipped[result.skip] || 0) + 1; continue; }
    if (result.event.starts_on < window.from) { before++; continue; }
    if (result.event.starts_on >= window.until) { after++; continue; }
    events.push(result.event);
  }
  sortEvents(events);
  const months = new Map();
  for (const event of events) {
    const month = event.starts_on.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(event);
  }
  for (const [month, list] of months) {
    if (!validators.events(list)) fail(`Month ${month} fails event.schema.json: ${validators.ajv.errorsText(validators.events.errors)}`);
  }
  const count = (key) => events.filter(key).length;
  const run = {
    game_code: game,
    source_code: 'bandai_tcg_plus',
    fetched_at: fetchedAt,
    window: { from: window.from, until: window.until },
    query: { endpoint: '/api/user/event/list', ...query, offset: 'paged', limit: query.limit },
    source_total: coverage.source_total,
    record_count: events.length,
    complete: true,
    collector_version: COLLECTOR_VERSION,
    notes: [
      `source game_title_id=${report.selected_game?.external_id} (${report.selected_game?.title} / ${report.selected_game?.language_code}, ${report.selected_game?.game_title_code}) verified in /api/masterdata`,
      `distinct ids fetched=${records.length} == source total=${coverage.source_total} over ${coverage.pages} pages; query has no end_date, window filtered locally by starts_on`,
      `outside window: before=${before}, on/after until=${after}; skipped: ${Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
      `shared BANDAI CARD GAMES series records (included via event_series_game_title_ids membership): ${records.filter(r => r.game_scope_match === 'series_game_membership' && events.some(e => e.external_id === r.external_id)).length}`,
      `time_precision=date: ${count(e => e.time_precision === 'date')} (source hides the time, or source timezone is not UTC+9)`,
      `registration_status: ${['open', 'waitlist', 'not_open', 'closed', 'unknown'].map(s => `${s}=${count(e => e.registration_status === s)}`).join(', ')}`,
      'fee_amount/fee_text are null for every event: the list API omits hidden_entry_fee and sampled events show entryFee 0 with the fee hidden',
      `registration_closes_at known for ${count(e => e.registration_closes_at)} events (list API sends apply_end_datetime only for some entry types); ends_at/ends_on unknown; venue.city null (source mixes city and town)`,
      'venue.name is the TCG+ organizer name; for official events (series_type=2) that can be the organizer brand rather than the hall, whose name is then in the event title',
      ...notes
    ]
  };
  if (!validators.run(run)) fail(`_run.json fails run.schema.json: ${validators.ajv.errorsText(validators.run.errors)}`);
  const files = new Map([...months].map(([month, list]) => [`${month}.json`, JSON.stringify(list, null, 2) + '\n']));
  files.set('_run.json', JSON.stringify(run, null, 2) + '\n');
  return { files, run, events, skipped };
}

/** Replaces data/events/<GAME>/ with the given files; stages everything first so a write error leaves the old set. */
export async function writeOutputs(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of files) await fs.writeFile(path.join(dir, name + '.part'), content, { flag: 'w' });
  const existing = (await fs.readdir(dir)).filter(name => name.endsWith('.json') && !files.has(name));
  for (const [name] of files) await fs.rename(path.join(dir, name + '.part'), path.join(dir, name));
  for (const name of existing) await fs.rm(path.join(dir, name));
}
