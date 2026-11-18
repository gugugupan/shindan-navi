// Every event read back through the API must equal its file content (minus last_seen_at, and
// game_code for events listed under several games).
//   ROUNDTRIP_DATA=<data/events dir> [ROUNDTRIP_DB=<sqlite file>] npx vitest run tests/roundtrip.test.ts
// Without ROUNDTRIP_DATA it runs on the sample fixture plus SYNTHETIC conflicting groups/venues and a shared event.
import { describe, expect, it } from 'vitest';
import { api, conflicting, importDir, sampleEvents, synthetic, writeDataDir, type Ev } from './helpers';
import { locOf } from '../scripts/lib/importer.mjs';
import { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function defaultDir(): string {
  const shared = synthetic(1, 9000)[0];
  const opcg = { ...shared, game_code: 'OPCG', source_code: 'bandai_tcg_plus', id: 'tcgp:rt-shared', external_id: 'rt-shared' };
  return writeDataDir([...sampleEvents(), ...synthetic(200), ...conflicting(60), opcg, { ...opcg, game_code: 'UATCG' }]);
}

describe('round trip', () => {
  it('API output equals file content for every event', async () => {
    const dir = process.env.ROUNDTRIP_DATA ?? defaultDir();
    const db = new SqliteD1(process.env.ROUNDTRIP_DB ?? ':memory:').migrate();
    const results = importDir(db, dir);
    expect(results.flatMap((r) => r.errors)).toEqual([]);

    const files = new Map<string, { ev: Ev; games: Set<string> }>();
    for (const r of results) {
      for (const ev of r.events) {
        const prev = files.get(ev.id);
        files.set(ev.id, { ev, games: new Set([...(prev?.games ?? []), ev.game_code]) });
      }
    }
    const dates = [...files.values()].map((f) => f.ev.starts_on).sort();
    const locs = [...new Set([...files.values()].map((f) => locOf(f.ev)))].sort();
    expect(locs).not.toContain(null);
    const seen = new Map<string, Ev>();
    let total = 0;
    for (let i = 0; i < locs.length; i += 5) {
      const pref = locs.slice(i, i + 5).join(',');
      for (let from = dates[0]; from <= dates[dates.length - 1]; from = addDays(from, 31)) {
        const range = `from=${from}&until=${addDays(from, 31)}&pref=${pref}`;
        const days = await api(db, `/api/v1/events/days?${range}`);
        total += days.body.days.reduce((n: number, d: Ev) => n + d.count, 0);
        let cursor: string | null = null;
        do {
          const r = await api(db, `/api/v1/events?${range}${cursor ? `&cursor=${cursor}` : ''}`);
          expect(r.status).toBe(200);
          for (const e of r.body.events) seen.set(e.id, e);
          cursor = r.body.next_cursor;
        } while (cursor);
      }
    }
    expect(seen.size).toBe(files.size);
    expect(total).toBe(files.size);

    const strip = (e: Ev, shared: boolean) => {
      const { last_seen_at, game_codes, game_code, ...rest } = e;
      return shared ? rest : { game_code, ...rest };
    };
    const mismatches: string[] = [];
    for (const [id, { ev, games }] of files) {
      const got = seen.get(id)!;
      const shared = games.size > 1;
      if (JSON.stringify(got.game_codes) !== JSON.stringify([...games].sort())) mismatches.push(`${id}: game_codes ${got.game_codes}`);
      if (JSON.stringify(strip(got, shared)) !== JSON.stringify(strip(ev, shared))) mismatches.push(id);
    }
    console.log(`round trip: ${files.size} events, ${[...files.values()].filter((f) => f.games.size > 1).length} shared, ${mismatches.length} mismatches`);
    expect(mismatches.slice(0, 20)).toEqual([]);
    db.close();
  });
});
