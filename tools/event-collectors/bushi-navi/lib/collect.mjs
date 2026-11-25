// Exhaustive offset pagination of /api/user/event/list per game and date chunk, with coverage proof.

export const LIST_PATH = '/api/user/event/list';
export const PAGE_SIZE = 100; // the site's largest page size option
// Stamped on every saved chunk and raw.json. Bump whenever collectChunk's proof gets stricter: older saves may hold
// chunks the new proof would reject (before 2, a group without an events array was silently counted).
export const COVERAGE_VERSION = 2;

// Only these fields are kept from a list row; everything else (organizer phone numbers, free-text notes and
// excerpts that can carry contact details) is dropped before anything is written, raw.json included.
const GROUP_FIELDS = [
  'event_series_id', 'organizer_id', 'series_type', 'team_count', 'game_title_id', 'organizer_name', 'organizer_type',
  'place_geo', 'event_series_title', 'is_event_info_hidden', 'is_start_datetime_hidden', 'is_max_join_count_hidden',
];
const EVENT_FIELDS = [
  'id', 'event_series_id', 'organizer_id', 'status_id', 'start_datetime', 'max_join_count', 'game_format_id',
  'game_format_name', 'pref_code', 'requirement_type', 'entry_fee', 'place', 'place_geo', 'entry_method',
  'is_no_advance_application', 'is_canceled', 'user_apply_deadline_type',
];

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

/** One flat row per event: the event's whitelisted fields plus its series group under `group`. */
export function flattenGroups(groups) {
  const rows = [];
  for (const g of groups) {
    const group = pick(g, GROUP_FIELDS);
    for (const e of g.events ?? []) rows.push({ ...pick(e, EVENT_FIELDS), group });
  }
  return rows;
}

export function listPath({ gameTitleId, startDate, endDate, offset, limit = PAGE_SIZE }) {
  const q = new URLSearchParams();
  q.append('game_title_id[]', String(gameTitleId));
  q.set('start_date', startDate);
  q.set('end_date', endDate);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${LIST_PATH}?${q}`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Half-open [from, until) split into inclusive [start, end] chunks of at most `days` days.
export function chunks(from, until, days) {
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`chunk days must be a positive integer, got ${days}`);
  const out = [];
  for (let s = from; s < until;) {
    let e = addDays(s, days - 1);
    if (e >= until) e = addDays(until, -1);
    out.push({ startDate: s, endDate: e });
    s = addDays(e, 1);
  }
  return out;
}

/** Asia/Tokyo calendar date of an ISO instant. */
export function tokyoDay(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 9 * 3600_000).toISOString().slice(0, 10) : null;
}

export class CoverageError extends Error {}

const groupKey = (g) => `${g.event_series_id}/${g.organizer_id}`;

/**
 * Pages one game + date chunk until offset >= total. `total` counts series groups (series × organizer), so the proof
 * is distinct group keys == total with total unchanged across pages; event ids must be unique and dated (Asia/Tokyo)
 * inside the chunk. Throws CoverageError otherwise.
 */
export async function collectChunk(fetchJson, { gameTitleId, startDate, endDate }, { maxPages = 200 } = {}) {
  const groups = new Map();
  const events = new Map();
  let total = null;
  let pages = 0;
  const where = `game ${gameTitleId} ${startDate}..${endDate}`;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    if (pages >= maxPages) throw new CoverageError(`${where}: page budget ${maxPages} exhausted`);
    const body = await fetchJson(listPath({ gameTitleId, startDate, endDate, offset }));
    pages += 1;
    const s = body?.success;
    if (s?.code !== 200 || !Array.isArray(s.organizer_event_series) || !Number.isInteger(s.total)) {
      throw new CoverageError(`${where}@${offset}: unexpected body shape`);
    }
    if (total === null) total = s.total;
    else if (s.total !== total) throw new CoverageError(`${where}: total changed ${total} -> ${s.total} mid-pagination`);
    for (const g of s.organizer_event_series) {
      if (g.game_title_id !== gameTitleId) throw new CoverageError(`${where}: series ${g.event_series_id} has game ${g.game_title_id}`);
      if (!Array.isArray(g.events)) throw new CoverageError(`${where}@${offset}: series ${g.event_series_id} has no events array`);
      groups.set(groupKey(g), true);
      for (const row of flattenGroups([g])) {
        const day = tokyoDay(row.start_datetime);
        if (!day || day < startDate || day > endDate) {
          throw new CoverageError(`${where}: event ${row.id} starts ${row.start_datetime} outside the chunk`);
        }
        const prev = events.get(row.id);
        if (prev && JSON.stringify(prev) !== JSON.stringify(row)) throw new CoverageError(`${where}: event ${row.id} seen twice with different data`);
        events.set(row.id, row);
      }
    }
    if (s.organizer_event_series.length < PAGE_SIZE || offset + PAGE_SIZE >= total) break;
  }
  if (groups.size !== total) throw new CoverageError(`${where}: ${groups.size} distinct series groups != total ${total}`);
  return { coverage: COVERAGE_VERSION, chunk: { gameTitleId, startDate, endDate }, total, pages, rows: [...events.values()] };
}

const chunkKey = (c) => `${c.game} ${c.startDate}..${c.endDate}`;

/**
 * Chunks a saved raw.json must hold, exactly once each, to be replayed for `plan`; returns [] when it covers the plan,
 * otherwise one message per missing, duplicated or unrequested chunk. Saved chunks of games outside the plan are ignored.
 */
export function rawCoverageGaps(plan, savedChunks) {
  const games = new Set(plan.map((c) => c.game));
  const want = new Set(plan.map(chunkKey));
  const have = new Map();
  for (const k of savedChunks.filter((c) => games.has(c.game)).map(chunkKey)) have.set(k, (have.get(k) ?? 0) + 1);
  return [
    ...[...want].filter((k) => !have.has(k)).map((k) => `missing ${k}`),
    ...[...have].filter(([, n]) => n > 1).map(([k, n]) => `duplicate ${k} (${n}x)`),
    ...[...have.keys()].filter((k) => !want.has(k)).map((k) => `not requested ${k}`),
  ];
}
