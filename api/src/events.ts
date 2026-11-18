import { ATTENDANCE_MODES, CATEGORIES, FEES, GAMES, GAME_CODES, MAX_PREFS, ONLINE, REGISTRATION_STATUSES } from './constants';

// The page's page size is the only one accepted: every other value would be a new cache key.
export const PAGE_LIMIT = 50;
// Bounds one query's scan to a month of the selected locations (the page splits longer ranges by month).
export const MAX_RANGE_DAYS = 31;
const ID_RE = /^(tcgp|ptcg|conan):.{1,200}$/;
// 9999-12-31T23:59:59Z, the starts_sort of date-only events.
const MAX_SORT = 253402300799;
// Keeps the bound-parameter total under D1's 100 per query.
export const MAX_TYPES = 20;

export class BadRequest extends Error {}

export interface EventQuery {
  from: string;
  until: string;
  games: string[];
  prefs: string[];
  categories: string[];
  types: string[];
  days: number[];
  fees: string[];
  registration: string[];
  modes: string[];
  limit: number;
  after: [string, number, string] | null;
  /** The range lies outside the loaded data window: answer empty without querying. */
  outside?: boolean;
}

export interface DataWindow {
  from: string;
  until: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PREF_RE = /^(JP-(0[1-9]|[1-3][0-9]|4[0-7])|online)$/;
const TYPE_RE = /^[a-z0-9_]+$/;

function dayNumber(name: string, s: string): number {
  if (!DATE_RE.test(s)) throw new BadRequest(`${name} must be YYYY-MM-DD`);
  const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  if (new Date(t).toISOString().slice(0, 10) !== s) throw new BadRequest(`${name} is not a valid date`);
  return t / 86_400_000;
}

function single(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  if (all.length > 1) throw new BadRequest(`${name} given more than once`);
  return all.length ? all[0] : null;
}

function list(params: URLSearchParams, name: string, allowed?: readonly string[], re?: RegExp): string[] {
  const values = [...new Set(params.getAll(name).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean))];
  for (const v of values) {
    if ((allowed && !allowed.includes(v)) || (re && !re.test(v))) throw new BadRequest(`invalid ${name}: ${v}`);
  }
  return values.sort();
}

function parseDays(params: URLSearchParams): number[] {
  const out = new Set<number>();
  for (const v of list(params, 'days')) {
    if (v === 'weekend') [0, 6].forEach((d) => out.add(d));
    else if (v === 'weekday') [1, 2, 3, 4, 5].forEach((d) => out.add(d));
    else if (/^[0-6]$/.test(v)) out.add(+v);
    else throw new BadRequest(`invalid days: ${v}`);
  }
  return [...out].sort();
}

function fingerprint(q: Filters): string {
  const s = JSON.stringify([q.from, q.until, q.games, q.prefs, q.categories, q.types, q.days, q.fees, q.registration, q.modes]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeCursor(fp: string, key: [string, number, string]): string {
  return b64urlEncode(JSON.stringify([1, fp, ...key]));
}

function decodeCursor(cursor: string, fp: string, from: string, until: string): [string, number, string] {
  let v: unknown;
  try {
    v = JSON.parse(b64urlDecode(cursor));
  } catch {
    throw new BadRequest('invalid cursor');
  }
  if (!Array.isArray(v) || v.length !== 5 || v[0] !== 1 || typeof v[2] !== 'string' || !DATE_RE.test(v[2])
    || !Number.isSafeInteger(v[3]) || v[3] < 0 || v[3] > MAX_SORT || typeof v[4] !== 'string' || !ID_RE.test(v[4])) {
    throw new BadRequest('invalid cursor');
  }
  if (v[1] !== fp) throw new BadRequest('cursor does not match these filters');
  if (v[2] < from || v[2] >= until) throw new BadRequest('cursor outside the date range');
  return [v[2], v[3], v[4]];
}

type Filters = Omit<EventQuery, 'limit' | 'after'>;

const FILTER_PARAMS = ['from', 'until', 'game', 'pref', 'category', 'type', 'days', 'fee', 'registration', 'mode'];
export const EVENTS_PARAMS = [...FILTER_PARAMS, 'limit', 'cursor'];
export const DAYS_PARAMS = FILTER_PARAMS;

function rejectUnknown(params: URLSearchParams, allowed: readonly string[]) {
  for (const k of params.keys()) if (!allowed.includes(k)) throw new BadRequest(`unknown parameter: ${k}`);
}

/**
 * Validates the query. With a data window (union of the latest import windows) the range is clamped to it,
 * so dates beyond the data neither reach D1 nor make new cache keys.
 */
export function parseFilters(params: URLSearchParams, allowed: readonly string[] = DAYS_PARAMS, window: DataWindow | null = null): Filters {
  rejectUnknown(params, allowed);
  const from = single(params, 'from');
  const until = single(params, 'until');
  if (!from) throw new BadRequest('from is required');
  if (!until) throw new BadRequest('until is required');
  const span = dayNumber('until', until) - dayNumber('from', from);
  if (span <= 0) throw new BadRequest('until must be after from');
  if (span > MAX_RANGE_DAYS) throw new BadRequest(`until must be at most ${MAX_RANGE_DAYS} days after from`);
  let range = { from, until, outside: false };
  if (window) {
    if (until <= window.from || from >= window.until) range = { from, until, outside: true };
    else range = { from: from < window.from ? window.from : from, until: until > window.until ? window.until : until, outside: false };
  }

  const prefs = list(params, 'pref', undefined, PREF_RE);
  if (!prefs.length) throw new BadRequest('pref is required (JP-01..JP-47 or online)');
  if (prefs.length > MAX_PREFS) throw new BadRequest(`at most ${MAX_PREFS} pref values`);
  const types = list(params, 'type', undefined, TYPE_RE);
  if (types.length > MAX_TYPES) throw new BadRequest(`at most ${MAX_TYPES} type values`);
  return {
    ...range,
    games: list(params, 'game', GAME_CODES),
    prefs,
    categories: list(params, 'category', CATEGORIES),
    types,
    days: parseDays(params),
    fees: list(params, 'fee', FEES),
    registration: list(params, 'registration', REGISTRATION_STATUSES),
    modes: list(params, 'mode', ATTENDANCE_MODES),
  };
}

export function parseEventQuery(params: URLSearchParams, window: DataWindow | null = null): EventQuery & { fp: string } {
  const base = parseFilters(params, EVENTS_PARAMS, window);
  const rawLimit = single(params, 'limit');
  if (rawLimit !== null && rawLimit !== String(PAGE_LIMIT)) throw new BadRequest(`limit must be ${PAGE_LIMIT}`);
  const fp = fingerprint(base);
  const cursor = single(params, 'cursor');
  return { ...base, limit: PAGE_LIMIT, after: cursor ? decodeCursor(cursor, fp, base.from, base.until) : null, fp };
}

/** One spelling per filter set, so equivalent URLs share a cache entry. */
export function canonicalFilters(q: Filters): URLSearchParams {
  const out = new URLSearchParams({ from: q.from, until: q.until });
  const lists: Array<[string, readonly (string | number)[]]> = [
    ['game', q.games], ['pref', q.prefs], ['category', q.categories], ['type', q.types], ['days', q.days],
    ['fee', q.fees], ['registration', q.registration], ['mode', q.modes],
  ];
  for (const [k, v] of lists) if (v.length) out.set(k, v.join(','));
  return out;
}

export function canonicalEventQuery(q: EventQuery & { fp: string }): URLSearchParams {
  const out = canonicalFilters(q);
  if (q.after) out.set('cursor', encodeCursor(q.fp, q.after));
  return out;
}

const SELECT = `SELECT
  id, game_mask, source_code, external_id, source_url, group_source_id, group_name, category, event_type_code,
  name, attendance_mode, venue_json, starts_on, ends_on, starts_at, ends_at, timezone, time_precision, format_text,
  eligibility_text, capacity, fee_amount, fee_currency, fee_text, registration_method, registration_platform,
  registration_url, registration_opens_at, registration_closes_at, registration_status, event_status,
  source_status_text, starts_sort`;

// Every shape starts with loc + starts_on so idx_events_loc(loc, starts_on, starts_sort) bounds the scan.
export function whereClause(q: Filters): { sql: string; binds: unknown[] } {
  const marks = (values: readonly unknown[]) => values.map(() => '?').join(', ');
  const parts = [q.prefs.length === 1 ? 'loc = ?' : `loc IN (${marks(q.prefs)})`, 'starts_on >= ?', 'starts_on < ?', 'game_mask <> 0'];
  const binds: unknown[] = [...q.prefs, q.from, q.until];
  const inList = (col: string, values: string[]) => {
    if (!values.length) return;
    parts.push(`${col} IN (${marks(values)})`);
    binds.push(...values);
  };
  if (q.games.length) {
    parts.push('(game_mask & ?) <> 0');
    binds.push(GAMES.filter((g) => q.games.includes(g.code)).reduce((m, g) => m | g.bit, 0));
  }
  inList('category', q.categories);
  inList('event_type_code', q.types);
  inList('registration_status', q.registration);
  // Hybrid events count as both in_person and online.
  const modes = q.modes.some((m) => m === 'in_person' || m === 'online') ? [...new Set([...q.modes, 'hybrid'])].sort() : q.modes;
  inList('attendance_mode', modes);
  // days are validated integers 0..6, so they are inlined.
  if (q.days.length) parts.push(`CAST(strftime('%w', starts_on) AS INTEGER) IN (${q.days.join(', ')})`);
  if (q.fees.length) {
    const fee = { free: 'fee_amount = 0', paid: 'fee_amount > 0', unknown: 'fee_amount IS NULL' } as Record<string, string>;
    parts.push(`(${q.fees.map((f) => fee[f]).join(' OR ')})`);
  }
  return { sql: parts.join('\n  AND '), binds };
}

type Row = Record<string, unknown>;

export const gamesOf = (mask: number): string[] => GAMES.filter((g) => mask & g.bit).map((g) => g.code).sort();

/** last_seen_at is the fetched_at of the newest import among the event's games (collectors set it to the run time). */
export function rowToEvent(r: Row, fetchedAt: Record<string, string>) {
  const gameCodes = gamesOf(Number(r.game_mask));
  const seen = gameCodes.map((g) => fetchedAt[g]).filter(Boolean).sort();
  return {
    id: r.id,
    game_code: gameCodes[0],
    game_codes: gameCodes,
    source_code: r.source_code,
    external_id: r.external_id,
    source_url: r.source_url,
    group: { source_id: r.group_source_id, name: r.group_name, category: r.category, event_type_code: r.event_type_code },
    name: r.name,
    attendance_mode: r.attendance_mode,
    venue: r.venue_json === null ? null : JSON.parse(String(r.venue_json)),
    starts_on: r.starts_on,
    ends_on: r.ends_on,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    timezone: r.timezone,
    time_precision: r.time_precision,
    format_text: r.format_text,
    eligibility_text: r.eligibility_text,
    capacity: r.capacity,
    fee_amount: r.fee_amount,
    fee_currency: r.fee_currency,
    fee_text: r.fee_text,
    registration_method: r.registration_method,
    registration_platform: r.registration_platform,
    registration_url: r.registration_url,
    registration_opens_at: r.registration_opens_at,
    registration_closes_at: r.registration_closes_at,
    registration_status: r.registration_status,
    event_status: r.event_status,
    source_status_text: r.source_status_text,
    last_seen_at: seen[seen.length - 1] ?? null,
  };
}

export function eventsSql(q: EventQuery): { sql: string; binds: unknown[] } {
  // The cursor's day becomes the index lower bound; the row-value test then skips that day's earlier rows.
  const where = whereClause(q.after ? { ...q, from: q.after[0] } : q);
  let sql = where.sql;
  const binds = [...where.binds];
  if (q.after) {
    sql += '\n  AND (starts_on, starts_sort, id) > (?, ?, ?)';
    binds.push(...q.after);
  }
  return { sql: `${SELECT}\nFROM events\nWHERE ${sql}\nORDER BY starts_on, starts_sort, id\nLIMIT ?`, binds: [...binds, q.limit + 1] };
}

export async function listEvents(db: D1Database, q: EventQuery & { fp: string }, fetchedAt: Record<string, string>) {
  if (q.outside) return { events: [], next_cursor: null };
  const { sql, binds } = eventsSql(q);
  const rows = (await db.prepare(sql).bind(...binds).all<Row>()).results;
  const more = rows.length > q.limit;
  const shown = more ? rows.slice(0, q.limit) : rows;
  const last = shown[shown.length - 1];
  return {
    events: shown.map((r) => rowToEvent(r, fetchedAt)),
    next_cursor: more ? encodeCursor(q.fp, [last.starts_on as string, Number(last.starts_sort), last.id as string]) : null,
  };
}

export function daysSql(q: Filters): { sql: string; binds: unknown[] } {
  const where = whereClause(q);
  return { sql: `SELECT starts_on AS date, game_mask AS m, COUNT(*) AS n FROM events\nWHERE ${where.sql}\nGROUP BY starts_on, game_mask`, binds: where.binds };
}

export async function listDays(db: D1Database, q: Filters) {
  if (q.outside) return { days: [] };
  const { sql, binds } = daysSql(q);
  // With a game filter, by_game reports only the selected games (a shared event also carries others).
  const shown = q.games.length ? GAMES.filter((g) => q.games.includes(g.code)).reduce((m, g) => m | g.bit, 0) : 0xff;
  const rows = (await db.prepare(sql).bind(...binds).all<Row>()).results;
  // A shared event counts once in count and once per member game in by_game.
  const byDate = new Map<string, { date: string; count: number; by_game: Record<string, number> }>();
  for (const r of rows) {
    const date = r.date as string;
    const d = byDate.get(date) ?? { date, count: 0, by_game: {} };
    d.count += Number(r.n);
    for (const g of gamesOf(Number(r.m) & shown)) d.by_game[g] = (d.by_game[g] ?? 0) + Number(r.n);
    byDate.set(date, d);
  }
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of days) d.by_game = Object.fromEntries(Object.entries(d.by_game).sort());
  return { days };
}
