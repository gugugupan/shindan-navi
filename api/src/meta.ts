import { CATEGORIES, GAMES, PREFECTURES, TYPE_LABELS } from './constants';

interface StoredMeta {
  games: Record<string, { record_count: number; fetched_at: string; complete: boolean; window: { from: string; until: string } }>;
  prefectures: Record<string, number>;
  online: number;
  categories: Record<string, number>;
  types: Array<[string, string, number]>;
}

export interface DataState {
  version: string;
  fetched_at: Record<string, string>;
}

async function siteMeta(db: D1Database, key: string): Promise<string | null> {
  return db.prepare('SELECT value FROM site_meta WHERE key = ?').bind(key).first<string>('value');
}

/** Version and per-game fetched_at written by the last import; null before the first import. */
export async function readState(db: D1Database): Promise<DataState | null> {
  const v = await siteMeta(db, 'state');
  return v === null ? null : (JSON.parse(v) as DataState);
}

// Precomputed by the importer (counts over each game's latest window); this only adds labels and order.
export async function getMeta(db: D1Database) {
  const raw = await siteMeta(db, 'meta');
  const m: StoredMeta = raw === null ? { games: {}, prefectures: {}, online: 0, categories: {}, types: [] } : JSON.parse(raw);
  return {
    games: GAMES.map((g) => {
      const s = m.games[g.code];
      return {
        code: g.code,
        name: g.name,
        slug: g.slug,
        record_count: s ? s.record_count : 0,
        fetched_at: s ? s.fetched_at : null,
        complete: s ? s.complete : false,
        window: s ? s.window : null,
      };
    }),
    prefectures: PREFECTURES.map(([code, name]) => ({ code, name, count: m.prefectures[code] ?? 0 })),
    online: { count: m.online },
    categories: CATEGORIES.map((code) => ({ code, count: m.categories[code] ?? 0 })),
    types: m.types.map(([game_code, code, count]) => ({ game_code, code, name: TYPE_LABELS[code] ?? code, count })),
  };
}
