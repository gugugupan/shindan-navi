// 話題カレンダー snapshots from D1 (docs/design/voices-db.md), written only by api/scripts/import-voices.mjs.
// Each body is a snapshot JSON the importer validated, so answers are assembled from the stored text without
// re-parsing it.

export interface VoicesState {
  version: string;
}

/** A response body that is already JSON text. */
export class RawJson {
  constructor(readonly text: string) {}
}

const missingTable = (e: unknown) => e instanceof Error && /no such table/.test(e.message);

/** The voices data version; null before the first import or without migration 0008. */
export async function readVoicesState(db: D1Database): Promise<VoicesState | null> {
  try {
    const v = await db.prepare("SELECT value FROM voice_meta WHERE key = 'version'").first<string>('value');
    return v === null ? null : { version: v };
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

/** GET /api/v1/voices: every snapshot, oldest first. */
export async function listVoices(db: D1Database, state: VoicesState | null): Promise<RawJson> {
  if (!state) return new RawJson('{"version":null,"snapshots":[]}');
  const { results } = await db.prepare('SELECT body FROM voice_snapshots ORDER BY date').all<{ body: string }>();
  return new RawJson(`{"version":${JSON.stringify(state.version)},"snapshots":[${results.map((r) => r.body).join(',')}]}`);
}

/** GET /api/v1/voices/latest: the newest snapshot (date, window, topics) or null. */
export async function latestVoices(db: D1Database, state: VoicesState | null): Promise<RawJson> {
  const body = state ? await db.prepare('SELECT body FROM voice_snapshots ORDER BY date DESC LIMIT 1').first<string>('body') : null;
  return new RawJson(`{"version":${JSON.stringify(state?.version ?? null)},"snapshot":${body ?? 'null'}}`);
}
