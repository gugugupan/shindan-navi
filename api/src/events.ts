import { ATTENDANCE_MODES, CATEGORIES, FEES, GAME_CODES, REGISTRATION_STATUSES } from './constants';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;
export const MAX_RANGE_DAYS = 92;
export const COUNT_CAP = 10000;
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
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PREF_RE = /^JP-(0[1-9]|[1-3][0-9]|4[0-7])$/;
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

function decodeCursor(cursor: string, fp: string): [string, number, string] {
  let v: unknown;
  try {
    v = JSON.parse(b64urlDecode(cursor));
  } catch {
    throw new BadRequest('invalid cursor');
  }
  if (!Array.isArray(v) || v.length !== 5 || v[0] !== 1 || typeof v[2] !== 'string' || !DATE_RE.test(v[2])
    || !Number.isSafeInteger(v[3]) || typeof v[4] !== 'string') {
    throw new BadRequest('invalid cursor');
  }
  if (v[1] !== fp) throw new BadRequest('cursor does not match these filters');
  return [v[2], v[3], v[4]];
}

type Filters = Omit<EventQuery, 'limit' | 'after'>;

export function parseFilters(params: URLSearchParams): Filters {
  const from = single(params, 'from');
  const until = single(params, 'until');
  if (!from) throw new BadRequest('from is required');
  if (!until) throw new BadRequest('until is required');
  const span = dayNumber('until', until) - dayNumber('from', from);
  if (span <= 0) throw new BadRequest('until must be after from');
  if (span > MAX_RANGE_DAYS) throw new BadRequest(`until must be at most ${MAX_RANGE_DAYS} days after from`);

  const types = list(params, 'type', undefined, TYPE_RE);
  if (types.length > MAX_TYPES) throw new BadRequest(`at most ${MAX_TYPES} type values`);
  return {
    from,
    until,
    games: list(params, 'game', GAME_CODES),
    prefs: list(params, 'pref', undefined, PREF_RE),
    categories: list(params, 'category', CATEGORIES),
    types,
    days: parseDays(params),
    fees: list(params, 'fee', FEES),
    registration: list(params, 'registration', REGISTRATION_STATUSES),
    modes: list(params, 'mode', ATTENDANCE_MODES),
  };
}

export function parseEventQuery(params: URLSearchParams): EventQuery & { fp: string } {
  const base = parseFilters(params);
  let limit = DEFAULT_LIMIT;
  const rawLimit = single(params, 'limit');
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || +rawLimit < 1) throw new BadRequest(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    limit = Math.min(+rawLimit, MAX_LIMIT);
  }
  const fp = fingerprint(base);
  const cursor = single(params, 'cursor');
  return { ...base, limit, after: cursor ? decodeCursor(cursor, fp) : null, fp };
}

const SELECT = `SELECT
  e.id, e.game_codes, e.source_code, e.external_id, e.source_url,
  g.source_id AS g_source_id, g.name AS g_name, g.category AS g_category, g.event_type_code AS g_event_type_code,
  e.name, e.attendance_mode,
  e.venue_id, v.name AS v_name, v.source_id AS v_source_id, v.country_code AS v_country_code,
  v.region_code AS v_region_code, v.region_name AS v_region_name, v.city AS v_city, v.address AS v_address,
  v.postal_code AS v_postal_code,
  e.starts_on, e.ends_on, e.starts_at, e.ends_at, e.timezone, e.time_precision, e.format_text,
  e.eligibility_text, e.capacity, e.fee_amount, e.fee_currency, e.fee_text, e.registration_method,
  e.registration_platform, e.registration_url, e.registration_opens_at, e.registration_closes_at,
  e.registration_status, e.event_status, e.source_status_text, e.last_seen_at, e.starts_sort`;

const FROM = `FROM events e JOIN event_groups g ON g.id = e.event_group_id`;

function whereClause(q: Filters): { sql: string; binds: unknown[] } {
  const parts = ['e.game_codes IS NOT NULL', 'e.starts_on >= ?', 'e.starts_on < ?'];
  const binds: unknown[] = [q.from, q.until];
  const marks = (values: string[]) => values.map(() => '?').join(', ');
  const inList = (col: string, values: string[]) => {
    if (!values.length) return;
    parts.push(`${col} IN (${marks(values)})`);
    binds.push(...values);
  };
  if (q.games.length) {
    parts.push(`EXISTS (SELECT 1 FROM event_games eg WHERE eg.event_id = e.id AND eg.missing_since IS NULL AND eg.game_code IN (${marks(q.games)}))`);
    binds.push(...q.games);
  }
  if (q.prefs.length) {
    inList('e.region_code', q.prefs);
    parts.push(`e.attendance_mode <> 'online'`);
  }
  inList('g.category', q.categories);
  inList('g.event_type_code', q.types);
  inList('e.registration_status', q.registration);
  // Hybrid events count as both in_person and online.
  const modes = q.modes.some((m) => m === 'in_person' || m === 'online') ? [...new Set([...q.modes, 'hybrid'])].sort() : q.modes;
  inList('e.attendance_mode', modes);
  // days are validated integers 0..6, so they are inlined.
  if (q.days.length) parts.push(`CAST(strftime('%w', e.starts_on) AS INTEGER) IN (${q.days.join(', ')})`);
  if (q.fees.length) {
    const fee = { free: 'e.fee_amount = 0', paid: 'e.fee_amount > 0', unknown: 'e.fee_amount IS NULL' } as Record<string, string>;
    parts.push(`(${q.fees.map((f) => fee[f]).join(' OR ')})`);
  }
  return { sql: parts.join('\n  AND '), binds };
}

type Row = Record<string, unknown>;

export function rowToEvent(r: Row) {
  const gameCodes = String(r.game_codes).split(',').sort();
  return {
    id: r.id,
    game_code: gameCodes[0],
    game_codes: gameCodes,
    source_code: r.source_code,
    external_id: r.external_id,
    source_url: r.source_url,
    group: { source_id: r.g_source_id, name: r.g_name, category: r.g_category, event_type_code: r.g_event_type_code },
    name: r.name,
    attendance_mode: r.attendance_mode,
    venue: r.venue_id === null ? null : {
      name: r.v_name,
      source_id: r.v_source_id,
      country_code: r.v_country_code,
      region_code: r.v_region_code,
      region_name: r.v_region_name,
      city: r.v_city,
      address: r.v_address,
      postal_code: r.v_postal_code,
    },
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
    last_seen_at: r.last_seen_at,
  };
}

export async function listEvents(db: D1Database, params: URLSearchParams) {
  const q = parseEventQuery(params);
  const where = whereClause(q);
  const pageBinds = [...where.binds];
  let pageWhere = where.sql;
  if (q.after) {
    pageWhere += '\n  AND (e.starts_on, e.starts_sort, e.id) > (?, ?, ?)';
    pageBinds.push(...q.after);
  }
  const [page, count] = await db.batch<Row>([
    db.prepare(`${SELECT}\n${FROM}\nLEFT JOIN venues v ON v.id = e.venue_id\nWHERE ${pageWhere}\nORDER BY e.starts_on, e.starts_sort, e.id\nLIMIT ?`)
      .bind(...pageBinds, q.limit + 1),
    db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${FROM}\nWHERE ${where.sql}\nLIMIT ${COUNT_CAP})`).bind(...where.binds),
  ]);
  const rows = page.results;
  const more = rows.length > q.limit;
  const shown = more ? rows.slice(0, q.limit) : rows;
  const last = shown[shown.length - 1];
  return {
    events: shown.map(rowToEvent),
    next_cursor: more ? encodeCursor(q.fp, [last.starts_on as string, Number(last.starts_sort), last.id as string]) : null,
    count: Number(count.results[0]?.n ?? 0),
  };
}

export async function listDays(db: D1Database, params: URLSearchParams) {
  const where = whereClause(parseFilters(params));
  // A shared event counts once in count and once per member game in by_game.
  const [totals, perGame] = await db.batch<Row>([
    db.prepare(`SELECT e.starts_on AS date, COUNT(*) AS n ${FROM}\nWHERE ${where.sql}\nGROUP BY e.starts_on ORDER BY e.starts_on`)
      .bind(...where.binds),
    db.prepare(`SELECT e.starts_on AS date, m.game_code, COUNT(*) AS n ${FROM}
JOIN event_games m ON m.event_id = e.id AND m.missing_since IS NULL
WHERE ${where.sql}\nGROUP BY e.starts_on, m.game_code ORDER BY e.starts_on, m.game_code`).bind(...where.binds),
  ]);
  const days = totals.results.map((r) => ({ date: r.date as string, count: Number(r.n), by_game: {} as Record<string, number> }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const r of perGame.results) byDate.get(r.date as string)!.by_game[r.game_code as string] = Number(r.n);
  return { days };
}
