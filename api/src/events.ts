import { ALL_GAME_BITS, GAMES, GAME_CODES, MAX_PREFS } from './constants';

// The page's page size is the only one accepted: every other value would be a new cache key.
export const PAGE_LIMIT = 50;
// With game/type/days filters, /events reads at most this many rows per location and filters them in the
// Worker; a page that hits the cap returns what matched plus a cursor to continue. Above the busiest
// location-day so far (178 events), so a page normally covers its first matching day.
export const SCAN_LIMIT = 200;
// Printable ASCII only: ids are tcgp:/ptcg:/conan:/bnavi: + digits or hex; anything else (NUL, quotes…) is a forgery.
const ID_RE = /^(tcgp|ptcg|conan|bnavi):[\x21-\x7e]{1,200}$/;
// 9999-12-31T23:59:59Z, the starts_sort of date-only events.
const MAX_SORT = 253402300799;
// Keeps the bound-parameter total under D1's 100 per query.
export const MAX_TYPES = 20;

export class BadRequest extends Error {}

export interface DataWindow {
  from: string;
  until: string;
}

export interface Filters {
  /** Range actually queried: the requested one clamped to the data window. */
  from: string;
  until: string;
  /** Range as requested; the cursor fingerprint uses it so a window change does not void cursors. */
  reqFrom: string;
  reqUntil: string;
  games: string[];
  prefs: string[];
  types: string[];
  days: '' | 'weekend' | 'weekday';
  /** The range lies outside the data window: answer empty without querying. */
  outside: boolean;
}

export interface EventQuery extends Filters {
  limit: number;
  after: [string, number, string] | null;
  fp: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PREF_RE = /^(JP-(0[1-9]|[1-3][0-9]|4[0-7])|online)$/;
const TYPE_RE = /^[a-z0-9_]+$/;

function validDate(name: string, s: string | null): string {
  if (!s) throw new BadRequest(`${name} is required`);
  if (!DATE_RE.test(s)) throw new BadRequest(`${name} must be YYYY-MM-DD`);
  const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  if (new Date(t).toISOString().slice(0, 10) !== s) throw new BadRequest(`${name} is not a valid date`);
  return s;
}

const firstOfNextMonth = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 1)).toISOString().slice(0, 10);

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

function fingerprint(q: Filters): string {
  // Filters only: several requested ranges can clamp to one cache entry, whose cursor must then work for all of
  // them. The cursor's own day is checked against each request's range instead.
  const s = JSON.stringify([q.games, q.prefs, q.types, q.days]);
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

// Exactly what the page sends. Each extra dimension would multiply the cache keys and the work per miss.
const FILTER_PARAMS = ['from', 'until', 'game', 'pref', 'type', 'days'];
export const EVENTS_PARAMS = [...FILTER_PARAMS, 'limit', 'cursor'];
export const DAYS_PARAMS = FILTER_PARAMS;

function rejectUnknown(params: URLSearchParams, allowed: readonly string[]) {
  for (const k of params.keys()) if (!allowed.includes(k)) throw new BadRequest(`unknown parameter: ${k}`);
}

/**
 * Validates the query. Ranges are month-shaped: /days takes whole months (from=YYYY-MM-01, until=first of the
 * next month), /events any start day up to the end of that month. With a data window (union of the latest import
 * windows) the range is clamped to it, so dates beyond the data neither reach D1 nor make new cache keys.
 */
export function parseFilters(params: URLSearchParams, kind: 'events' | 'days', window: DataWindow | null = null): Filters {
  rejectUnknown(params, kind === 'days' ? DAYS_PARAMS : EVENTS_PARAMS);
  const reqFrom = validDate('from', single(params, 'from'));
  const reqUntil = validDate('until', single(params, 'until'));
  if (reqUntil !== firstOfNextMonth(reqFrom)) throw new BadRequest('until must be the first day of the month after from');
  if (kind === 'days' && reqFrom.slice(8) !== '01') throw new BadRequest('days takes whole months: from must be the first of a month');

  const prefs = list(params, 'pref', undefined, PREF_RE);
  if (!prefs.length) throw new BadRequest('pref is required (JP-01..JP-47 or online)');
  if (prefs.length > MAX_PREFS) throw new BadRequest(`at most ${MAX_PREFS} pref values`);
  const types = list(params, 'type', undefined, TYPE_RE);
  if (types.length > MAX_TYPES) throw new BadRequest(`at most ${MAX_TYPES} type values`);
  const days = single(params, 'days') ?? '';
  if (days !== '' && days !== 'weekend' && days !== 'weekday') throw new BadRequest(`invalid days: ${days}`);

  let range = { from: reqFrom, until: reqUntil, outside: false };
  if (window) {
    if (reqUntil <= window.from || reqFrom >= window.until) range = { ...range, outside: true };
    else range = { from: reqFrom < window.from ? window.from : reqFrom, until: reqUntil > window.until ? window.until : reqUntil, outside: false };
  }
  return { ...range, reqFrom, reqUntil, games: list(params, 'game', GAME_CODES), prefs, types, days };
}

export function parseEventQuery(params: URLSearchParams, window: DataWindow | null = null): EventQuery {
  const base = parseFilters(params, 'events', window);
  const rawLimit = single(params, 'limit');
  if (rawLimit !== null && rawLimit !== String(PAGE_LIMIT)) throw new BadRequest(`limit must be ${PAGE_LIMIT}`);
  const fp = fingerprint(base);
  const cursor = single(params, 'cursor');
  return { ...base, limit: PAGE_LIMIT, after: cursor ? decodeCursor(cursor, fp, base.reqFrom, base.reqUntil) : null, fp };
}

/** One spelling per filter set (clamped range), so equivalent URLs share a cache entry. */
export function canonicalFilters(q: Filters): URLSearchParams {
  const out = new URLSearchParams({ from: q.from, until: q.until });
  if (q.games.length) out.set('game', q.games.join(','));
  out.set('pref', q.prefs.join(','));
  if (q.types.length) out.set('type', q.types.join(','));
  if (q.days) out.set('days', q.days);
  return out;
}

export function canonicalEventQuery(q: EventQuery): URLSearchParams {
  const out = canonicalFilters(q);
  if (q.after) out.set('cursor', encodeCursor(q.fp, q.after));
  return out;
}

const gameBits = (games: string[]) => GAMES.filter((g) => games.includes(g.code)).reduce((m, g) => m | g.bit, 0);
const DAY_SETS = { weekend: [0, 6], weekday: [1, 2, 3, 4, 5] } as const;
const dowSql = (days: 'weekend' | 'weekday') => `CAST(strftime('%w', starts_on) AS INTEGER) IN (${DAY_SETS[days].join(', ')})`;
const marks = (values: readonly unknown[]) => values.map(() => '?').join(', ');
const locSql = (prefs: string[]) => (prefs.length === 1 ? 'loc = ?' : `loc IN (${marks(prefs)})`);

const SELECT = `SELECT
  id, game_mask, source_code, external_id, source_url, group_source_id, group_name, category, event_type_code,
  name, attendance_mode, venue_json, starts_on, ends_on, starts_at, ends_at, timezone, time_precision, format_text,
  eligibility_text, capacity, fee_amount, fee_currency, fee_text, registration_method, registration_platform,
  registration_url, registration_opens_at, registration_closes_at, registration_status, event_status,
  source_status_text, starts_sort`;

type Row = Record<string, unknown>;

const isFiltered = (q: Filters) => q.games.length > 0 || q.types.length > 0 || q.days !== '';

/** Filters applied in the Worker to the scanned rows (same meaning as the /days SQL). */
function matches(q: Filters): (r: Row) => boolean {
  const bits = gameBits(q.games);
  const dows: readonly number[] | null = q.days ? DAY_SETS[q.days] : null;
  return (r) => (!bits || (Number(r.game_mask) & bits) !== 0)
    && (!q.types.length || q.types.includes(r.event_type_code as string))
    && (!dows || dows.includes(new Date(`${r.starts_on}T00:00:00Z`).getUTCDay()));
}

const ORDER = 'ORDER BY starts_on, starts_sort, id';

// Unfiltered pages: per location, this range in index order on idx_events_loc, limit+1 rows each, merged. With a
// cursor each location reads the cursor's day after the cursor and the later days as two index seeks on
// (loc, starts_on, starts_sort[, id]), so no earlier row is read again and no part needs a sort.
export function eventsSql(q: EventQuery): { sql: string; binds: unknown[] } {
  const take = q.limit + 1;
  const part = (where: string) => `SELECT * FROM (${SELECT}\nFROM events\nWHERE loc = ? AND game_mask <> 0 AND ${where}\n${ORDER}\nLIMIT ${take})`;
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const loc of q.prefs) {
    if (q.after) {
      const [day, sort, id] = q.after;
      parts.push(part('starts_on = ? AND (starts_sort, id) > (?, ?)'), part('starts_on > ? AND starts_on < ?'));
      binds.push(loc, day, sort, id, loc, day < q.from ? q.from : day, q.until);
    } else {
      parts.push(part('starts_on >= ? AND starts_on < ?'));
      binds.push(loc, q.from, q.until);
    }
  }
  return { sql: `${parts.join('\nUNION ALL\n')}\n${ORDER}\nLIMIT ${take}`, binds };
}

const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;

/**
 * Filtered pages: per location, the cursor's day after the cursor and the later matching days, each part capped at
 * SCAN_LIMIT / 2 rows (so at most SCAN_LIMIT rows per location), reading just the columns the Worker filters on.
 * Both parts are index seeks on (loc, starts_on, starts_sort, id). Days come from day_counts and the cursor is
 * validated, so they are inlined (binding them per part would pass D1's 100-parameter limit).
 */
export const PART_LIMIT = SCAN_LIMIT / 2;
export function scanSql(q: EventQuery, days: string[]): { sql: string; binds: unknown[] } {
  const part = (n: number, where: string) => `SELECT * FROM (SELECT id, loc, ${n} AS part, starts_on, starts_sort, game_mask, event_type_code
  FROM events WHERE loc = ? AND game_mask <> 0 AND ${where}\n  ${ORDER} LIMIT ${PART_LIMIT})`;
  const parts: string[] = [];
  let laterDays = days;
  if (q.after) {
    const [day, sort, id] = q.after;
    laterDays = days.filter((d) => d > day);
    if (days.includes(day)) parts.push(part(0, `starts_on = ${lit(day)} AND (starts_sort, id) > (${sort}, ${lit(id)})`));
  }
  if (laterDays.length) parts.push(part(1, `starts_on IN (${laterDays.map(lit).join(', ')})`));
  return {
    sql: `${q.prefs.flatMap(() => parts).join('\nUNION ALL\n')}\n${ORDER}`,
    binds: q.prefs.flatMap((p) => parts.map(() => p)),
  };
}

const lowerBound = (q: EventQuery) => (q.after && q.after[0] > q.from ? q.after[0] : q.from);
// day_counts rows read to find the next matching days: a total across the locations, in day order.
export const DAY_ROWS = 62;

/** The next days (from the cursor on) with at least one event matching the filters, from day_counts. */
export function matchingDaysSql(q: EventQuery): { sql: string; binds: unknown[] } {
  const { parts, binds } = dayCountsWhere(q, lowerBound(q));
  return { sql: `SELECT starts_on FROM day_counts\nWHERE ${parts.join(' AND ')}\nORDER BY starts_on\nLIMIT ${DAY_ROWS}`, binds };
}

const keyOf = (r: Row): [string, number, string] => [r.starts_on as string, Number(r.starts_sort), r.id as string];
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const cmpKey = (a: [string, number, string], b: [string, number, string]) =>
  (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));

export async function listEvents(db: D1Database, q: EventQuery, fetchedAt: Record<string, string>) {
  if (q.outside) return { events: [], next_cursor: null };
  if (!isFiltered(q)) {
    const { sql, binds } = eventsSql(q);
    const rows = (await db.prepare(sql).bind(...binds).all<Row>()).results;
    const shown = rows.slice(0, q.limit);
    const next = rows.length > q.limit ? keyOf(shown[shown.length - 1]) : null;
    return { events: shown.map((r) => rowToEvent(r, fetchedAt)), next_cursor: next ? encodeCursor(q.fp, next) : null };
  }

  const m = matchingDaysSql(q);
  const dayRows = (await db.prepare(m.sql).bind(...m.binds).all<Row>()).results;
  const days = [...new Set(dayRows.map((r) => r.starts_on as string))];
  if (!days.length) return { events: [], next_cursor: null };
  const s = scanSql(q, days);
  let rows = (await db.prepare(s.sql).bind(...s.binds).all<Row>()).results;
  // A part (location × cursor day / later days) that hit its cap was read only up to its last row; nothing after
  // the earliest such row is complete.
  let cut: [string, number, string] | null = null;
  const parts = new Map<string, Row[]>();
  for (const r of rows) parts.set(`${r.loc}\t${r.part}`, [...(parts.get(`${r.loc}\t${r.part}`) ?? []), r]);
  for (const mine of parts.values()) {
    if (mine.length === PART_LIMIT) {
      const k = keyOf(mine[mine.length - 1]);
      if (!cut || cmpKey(k, cut) < 0) cut = k;
    }
  }
  if (cut) rows = rows.filter((r) => cmpKey(keyOf(r), cut!) <= 0);
  const found = rows.filter(matches(q));
  let shown = found;
  let next: [string, number, string] | null = null;
  if (found.length > q.limit) {
    shown = found.slice(0, q.limit);
    next = keyOf(shown[shown.length - 1]);
  } else if (cut) {
    next = cut;
  } else if (dayRows.length === DAY_ROWS) {
    // More matching days may follow the ones looked up: continue at the start of the next day
    // (starts_sort 0 = 1970, before every real event).
    const d = nextDay(days[days.length - 1]);
    if (d < q.until) next = [d, 0, 'tcgp:0'];
  }
  let events: Row[] = [];
  if (shown.length) {
    const full = (await db.prepare(`${SELECT}\nFROM events WHERE id IN (${marks(shown)})`).bind(...shown.map((r) => r.id)).all<Row>()).results;
    const byId = new Map(full.map((r) => [r.id, r]));
    events = shown.map((r) => byId.get(r.id)!);
  }
  return { events: events.map((r) => rowToEvent(r, fetchedAt)), next_cursor: next ? encodeCursor(q.fp, next) : null };
}

function dayCountsWhere(q: Filters, from: string): { parts: string[]; binds: unknown[] } {
  const parts = [locSql(q.prefs), 'starts_on >= ?', 'starts_on < ?'];
  const binds: unknown[] = [...q.prefs, from, q.until];
  if (q.games.length) {
    parts.push('(game_mask & ?) <> 0');
    binds.push(gameBits(q.games));
  }
  if (q.types.length) {
    parts.push(`event_type_code IN (${marks(q.types)})`);
    binds.push(...q.types);
  }
  if (q.days) parts.push(dowSql(q.days));
  return { parts, binds };
}

/** /days reads day_counts (one row per location, day, game mask and type), not the events. */
export function daysSql(q: Filters): { sql: string; binds: unknown[] } {
  const { parts, binds } = dayCountsWhere(q, q.from);
  return { sql: `SELECT starts_on AS date, game_mask AS m, SUM(n) AS n FROM day_counts\nWHERE ${parts.join(' AND ')}\nGROUP BY starts_on, game_mask`, binds };
}

export async function listDays(db: D1Database, q: Filters) {
  if (q.outside) return { days: [] };
  const { sql, binds } = daysSql(q);
  const rows = (await db.prepare(sql).bind(...binds).all<Row>()).results;
  // A shared event counts once in count and once per member game in by_game; with a game filter, by_game
  // reports only the selected games.
  const shown = q.games.length ? gameBits(q.games) : ALL_GAME_BITS;
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
export const gamesOf = (mask: number): string[] => GAMES.filter((g) => mask & g.bit).map((g) => g.code).sort();

// Google Geocoding results may be cached for 30 days. geocoded_at is a date (the lookup may have run at its first
// minute), and a response lives up to EDGE_TTL (1 day) at the edge plus BROWSER_TTL in browsers, so a geo is served
// only while geocoded_at is at most 28 days before today: every copy then ages out within the 30 days.
export const GOOGLE_GEO_MAX_AGE_DAYS = 30;
export const GOOGLE_GEO_SERVE_DAYS = GOOGLE_GEO_MAX_AGE_DAYS - 2;

/** Oldest google geocoded_at (YYYY-MM-DD, Asia/Tokyo) still served at `now`. */
export const googleGeoCutoff = (now: number) =>
  new Date(now + 9 * 3_600_000 - GOOGLE_GEO_SERVE_DAYS * 86_400_000).toISOString().slice(0, 10);

/** venue_json as served: rows imported before venue.geo existed have no geo key; expired google geos become null. */
export function parseVenue(json: unknown, cutoff: string) {
  if (json === null) return null;
  const venue = JSON.parse(String(json));
  const geo = venue.geo ?? null;
  venue.geo = geo && geo.source === 'google' && !(geo.geocoded_at >= cutoff) ? null : geo;
  return venue;
}

/** last_seen_at is the fetched_at of the newest import among the event's games (collectors set it to the run time). */
export function rowToEvent(r: Row, fetchedAt: Record<string, string>, cutoff = googleGeoCutoff(Date.now())) {
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
    venue: parseVenue(r.venue_json, cutoff),
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

