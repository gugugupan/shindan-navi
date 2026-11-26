import REGISTRY from '../../data/games.json';

export class PrefsError extends Error {}

export const PREF_KEYS = ['stars', 'event_filters', 'ask_calendar', 'personal_calendar'] as const;
export type PrefKey = (typeof PREF_KEYS)[number];
export type Prefs = Partial<Record<PrefKey, unknown>>;

export const MAX_STARS = 2000;
const STAR_ID = /^i[0-9a-f]{10}$/;
const FILTER_KEYS = new Set(['game', 'pref', 'type', 'days', 'view']);
const MAX_FILTERS_BYTES = 1024;
const ASK_CALENDAR = new Set<unknown>([true, false, 'ask', 'off']);
// every registry title, also those without events (contracts/games.md); the /events/ pref values (events.ts PREF_RE)
const TITLE_CODES = new Set(REGISTRY.map((g) => g.code));
const LOCATION = /^(JP-(0[1-9]|[1-3][0-9]|4[0-7])|online)$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function starList(v: unknown, what = 'stars'): string[] {
  if (!Array.isArray(v)) throw new PrefsError(`${what} must be an array`);
  if (v.length > MAX_STARS) throw new PrefsError(`${what}: at most ${MAX_STARS} ids`);
  for (const id of v) if (typeof id !== 'string' || !STAR_ID.test(id)) throw new PrefsError(`${what}: invalid id`);
  return [...new Set(v as string[])];
}

export function eventFilters(v: unknown): Record<string, string> {
  if (!isObject(v)) throw new PrefsError('event_filters must be an object');
  for (const [k, x] of Object.entries(v)) {
    if (!FILTER_KEYS.has(k)) throw new PrefsError(`event_filters: unknown key ${k}`);
    if (typeof x !== 'string') throw new PrefsError(`event_filters.${k} must be a string`);
  }
  if (new TextEncoder().encode(JSON.stringify(v)).length > MAX_FILTERS_BYTES) throw new PrefsError('event_filters too large');
  return v as Record<string, string>;
}

export function askCalendar(v: unknown): boolean | string {
  if (!ASK_CALENDAR.has(v)) throw new PrefsError('ask_calendar must be true, false, "ask" or "off"');
  return v as boolean | string;
}

export interface PersonalCalendar {
  location: string | null;
  games: string[];
}

/** The home page's マイカレンダー: one /events/ location or null, registry codes ([] = all titles), sorted, deduped. */
export function personalCalendar(v: unknown): PersonalCalendar {
  if (!isObject(v) || Object.keys(v).some((k) => k !== 'location' && k !== 'games')) throw new PrefsError('personal_calendar must be { location, games }');
  const { location, games } = v;
  if (location !== null && (typeof location !== 'string' || !LOCATION.test(location))) throw new PrefsError('personal_calendar.location must be JP-01..JP-47, online or null');
  if (!Array.isArray(games)) throw new PrefsError('personal_calendar.games must be an array');
  for (const c of games) if (typeof c !== 'string' || !TITLE_CODES.has(c)) throw new PrefsError('personal_calendar.games: unknown game code');
  return { location, games: [...new Set(games as string[])].sort() };
}

export interface PrefRow {
  key: PrefKey;
  value_json: string;
  updated_at: string;
}

export function prefsBody(rows: PrefRow[]): { prefs: Prefs; updated_at: Partial<Record<PrefKey, string>> } {
  const prefs: Prefs = {};
  const updated_at: Partial<Record<PrefKey, string>> = {};
  for (const r of rows) {
    if (!(PREF_KEYS as readonly string[]).includes(r.key)) continue;
    prefs[r.key] = JSON.parse(r.value_json);
    updated_at[r.key] = r.updated_at;
  }
  return { prefs, updated_at };
}

/** Changes from a PUT body: undefined = untouched, null = delete. Throws PrefsError on anything invalid. */
export function applyPut(current: Prefs, body: unknown): Prefs {
  if (!isObject(body)) throw new PrefsError('body must be an object');
  const out: Prefs = {};
  for (const k of Object.keys(body)) if (!(PREF_KEYS as readonly string[]).includes(k)) throw new PrefsError(`unknown key ${k}`);
  if (body.stars !== undefined) {
    const s = body.stars;
    if (!isObject(s) || Object.keys(s).some((k) => k !== 'add' && k !== 'remove')) throw new PrefsError('stars must be { add?, remove? }');
    const add = s.add === undefined ? [] : starList(s.add, 'stars.add');
    const remove = new Set(s.remove === undefined ? [] : starList(s.remove, 'stars.remove'));
    const next = [...new Set([...((current.stars as string[]) ?? []), ...add])].filter((id) => !remove.has(id));
    if (next.length > MAX_STARS) throw new PrefsError(`stars: at most ${MAX_STARS} ids`);
    out.stars = next;
  }
  if (body.event_filters !== undefined) out.event_filters = body.event_filters === null ? null : eventFilters(body.event_filters);
  if (body.ask_calendar !== undefined) out.ask_calendar = body.ask_calendar === null ? null : askCalendar(body.ask_calendar);
  if (body.personal_calendar !== undefined) out.personal_calendar = body.personal_calendar === null ? null : personalCalendar(body.personal_calendar);
  return out;
}

/**
 * Changes from a merge body: stars union (server first, capped), the others only where the server has none.
 * personal_calendar is never merged (no browser keeps a copy); it is set by PUT only.
 */
export function applyMerge(current: Prefs, body: unknown): Prefs {
  if (!isObject(body)) throw new PrefsError('body must be an object');
  for (const k of Object.keys(body)) if (!(PREF_KEYS as readonly string[]).includes(k) || k === 'personal_calendar') throw new PrefsError(`unknown key ${k}`);
  const out: Prefs = {};
  const client = body.stars === undefined ? [] : starList(body.stars);
  const filters = body.event_filters === undefined || body.event_filters === null ? undefined : eventFilters(body.event_filters);
  const ask = body.ask_calendar === undefined || body.ask_calendar === null ? undefined : askCalendar(body.ask_calendar);
  if (client.length) out.stars = [...new Set([...((current.stars as string[]) ?? []), ...client])].slice(0, MAX_STARS);
  if (filters !== undefined && current.event_filters === undefined) out.event_filters = filters;
  if (ask !== undefined && current.ask_calendar === undefined) out.ask_calendar = ask;
  return out;
}

/** Statements writing only the keys whose value differs; returns the resulting prefs rows too. */
export function writePrefs(db: D1Database, userId: string, rows: PrefRow[], changes: Prefs, now: string): { statements: D1PreparedStatement[]; rows: PrefRow[] } {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const statements: D1PreparedStatement[] = [];
  for (const [key, value] of Object.entries(changes) as [PrefKey, unknown][]) {
    const old = byKey.get(key);
    if (value === null) {
      if (old) {
        statements.push(db.prepare('DELETE FROM user_prefs WHERE user_id = ? AND key = ?').bind(userId, key));
        byKey.delete(key);
      }
      continue;
    }
    const json = JSON.stringify(value);
    if (old && old.value_json === json) continue;
    statements.push(db.prepare(
      'INSERT INTO user_prefs (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    ).bind(userId, key, json, now));
    byKey.set(key, { key, value_json: json, updated_at: now });
  }
  return { statements, rows: [...byKey.values()] };
}
