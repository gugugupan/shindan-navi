import { CATEGORIES, PREFECTURES, TYPE_LABELS } from './constants';

// Counts are global (independent of any event filter) over each game's current data:
// visible events inside the window of its latest import.
const CURRENT = `WITH latest AS (
  SELECT i.game_code, i.window_from, i.window_until FROM imports i
  WHERE i.id = (SELECT j.id FROM imports j WHERE j.game_code = i.game_code ORDER BY j.imported_at DESC, j.fetched_at DESC LIMIT 1)
), cur AS (
  SELECT e.region_code, e.attendance_mode, e.event_group_id FROM events e
  JOIN latest l ON l.game_code = e.game_code AND e.starts_on >= l.window_from AND e.starts_on < l.window_until
  WHERE e.missing_since IS NULL
)`;

type Row = Record<string, unknown>;

export async function getMeta(db: D1Database) {
  const [games, prefs, cats, types] = await db.batch<Row>([
    db.prepare(`SELECT g.code, g.name, g.slug, i.record_count, i.fetched_at, i.complete, i.window_from, i.window_until
FROM games g
LEFT JOIN imports i ON i.id = (SELECT j.id FROM imports j WHERE j.game_code = g.code ORDER BY j.imported_at DESC, j.fetched_at DESC LIMIT 1)
ORDER BY g.sort_order, g.code`),
    db.prepare(`${CURRENT} SELECT region_code, COUNT(*) AS n FROM cur WHERE region_code IS NOT NULL AND attendance_mode <> 'online' GROUP BY region_code`),
    db.prepare(`${CURRENT} SELECT g.category, COUNT(*) AS n FROM cur JOIN event_groups g ON g.id = cur.event_group_id GROUP BY g.category`),
    db.prepare(`${CURRENT} SELECT g.game_code, g.event_type_code, COUNT(*) AS n FROM cur JOIN event_groups g ON g.id = cur.event_group_id
WHERE g.event_type_code IS NOT NULL GROUP BY g.game_code, g.event_type_code ORDER BY g.game_code, g.event_type_code`),
  ]);
  const prefCount = new Map(prefs.results.map((r) => [r.region_code as string, Number(r.n)]));
  const catCount = new Map(cats.results.map((r) => [r.category as string, Number(r.n)]));
  return {
    games: games.results.map((r) => ({
      code: r.code,
      name: r.name,
      slug: r.slug,
      record_count: r.record_count === null ? 0 : Number(r.record_count),
      fetched_at: r.fetched_at,
      complete: r.complete === 1,
      window: r.window_from === null ? null : { from: r.window_from, until: r.window_until },
    })),
    prefectures: PREFECTURES.map(([code, name]) => ({ code, name, count: prefCount.get(code) ?? 0 })),
    categories: CATEGORIES.map((code) => ({ code, count: catCount.get(code) ?? 0 })),
    types: types.results.map((r) => ({
      game_code: r.game_code,
      code: r.event_type_code,
      name: TYPE_LABELS[r.event_type_code as string] ?? r.event_type_code,
      count: Number(r.n),
    })),
  };
}
