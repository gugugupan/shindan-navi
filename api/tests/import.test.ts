import { describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, importDir, newDb, run, sampleEvents, synthetic, writeDataDir, type Ev } from './helpers';
import { buildStatements, loadAll, toSqlFile } from '../scripts/lib/importer.mjs';
import type { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';

const snapshot = (db: SqliteD1) => ({
  events: db.db.prepare('SELECT * FROM events ORDER BY id').all(),
  groups: db.db.prepare('SELECT * FROM event_groups ORDER BY id').all(),
  venues: db.db.prepare('SELECT * FROM venues ORDER BY id').all(),
});

describe('importer', () => {
  it('is idempotent: re-importing the same files changes nothing but imported_at', () => {
    const db = newDb();
    const dir = writeDataDir([...sampleEvents(), ...synthetic(300)]);
    importDir(db, dir, 1_000);
    const before = snapshot(db);
    importDir(db, dir, 2_000);
    expect(snapshot(db)).toEqual(before);
    expect(db.db.prepare('SELECT COUNT(*) n FROM imports').get()!.n).toBe(4);
    expect(db.db.prepare('SELECT DISTINCT imported_at t FROM imports').all().map((r: Ev) => r.t)).toEqual([2_000]);
  });

  it('bumps updated_at only for changed events and ignores last_seen_at', () => {
    const db = newDb();
    const evs = synthetic(20);
    const dir = writeDataDir(evs);
    importDir(db, dir, 1_000);
    const changed = evs.map((e, i) => ({ ...e, last_seen_at: '2026-11-19T00:00:00Z', name: i === 0 ? `${e.name} (renamed)` : e.name }));
    const runs = Object.fromEntries(['OPCG', 'UATCG', 'CONAN', 'PTCG'].map((g) => [g, run(g, 5, { fetched_at: '2026-11-19T00:00:00Z' })]));
    importDir(db, writeDataDir(changed, runs), 2_000);
    const rows = db.db.prepare('SELECT id, updated_at, created_at, last_seen_at FROM events ORDER BY id').all();
    expect(rows.filter((r: Ev) => r.updated_at === 2_000).map((r: Ev) => r.id)).toEqual([evs[0].id]);
    expect(rows.every((r: Ev) => r.created_at === 1_000 && r.last_seen_at === '2026-11-19T00:00:00Z')).toBe(true);
  });

  it('hides events missing from a complete run, keeps them in the table, and restores them when they return', async () => {
    const db = newDb();
    const evs = synthetic(40).filter((e) => e.game_code === 'OPCG');
    importDir(db, writeDataDir(evs), 1_000);
    const gone = evs[3];
    const rest = evs.filter((e) => e !== gone);
    importDir(db, writeDataDir(rest, { OPCG: run('OPCG', rest.length, { fetched_at: '2026-11-20T00:00:00Z' }) }), 2_000);
    const q = '/api/v1/events?from=2026-11-18&until=2027-02-18&limit=200';
    expect((await api(db, q)).body.events.map((e: Ev) => e.id)).not.toContain(gone.id);
    expect(db.db.prepare('SELECT missing_since FROM events WHERE id = ?').get(gone.id)!.missing_since).toBe('2026-11-20T00:00:00Z');
    expect((await api(db, '/api/v1/events/meta')).body.games[0].record_count).toBe(rest.length);

    importDir(db, writeDataDir(evs, { OPCG: run('OPCG', evs.length, { fetched_at: '2026-11-21T00:00:00Z' }) }), 3_000);
    expect((await api(db, q)).body.events.map((e: Ev) => e.id)).toContain(gone.id);
  });

  it('does not hide anything for incomplete runs or outside the run window', async () => {
    const db = newDb();
    const evs = synthetic(40).filter((e) => e.game_code === 'OPCG');
    importDir(db, writeDataDir(evs), 1_000);
    importDir(db, writeDataDir(evs.slice(0, 2), { OPCG: run('OPCG', 2, { fetched_at: '2026-11-20T00:00:00Z', complete: false }) }), 2_000);
    expect(db.db.prepare('SELECT COUNT(*) n FROM events WHERE missing_since IS NULL').get()!.n).toBe(evs.length);
    // A later window: old events before it are left alone.
    const later = evs.filter((e) => e.starts_on >= '2026-12-18');
    importDir(db, writeDataDir(later, { OPCG: run('OPCG', later.length, { fetched_at: '2026-12-18T00:00:00Z', window: { from: '2026-12-18', until: '2027-03-18' } }) }), 3_000);
    expect(db.db.prepare('SELECT COUNT(*) n FROM events WHERE missing_since IS NULL').get()!.n).toBe(evs.length);
  });

  it('rejects a game whose files break the contract and still imports the others', () => {
    const db = newDb();
    const evs = synthetic(40);
    const dir = writeDataDir(evs);
    const bad = evs.filter((e) => e.game_code === 'UATCG');
    writeFileSync(join(dir, 'UATCG', `${bad[0].starts_on.slice(0, 7)}.json`), JSON.stringify([{ ...bad[0], fee_amount: -1 }]));
    rmSync(join(dir, 'CONAN', '_run.json'));
    const results = importDir(db, dir);
    const errs = Object.fromEntries(results.map((r) => [r.game, r.errors]));
    expect(errs.OPCG).toEqual([]);
    expect(errs.UATCG.join('\n')).toMatch(/fee_amount/);
    expect(errs.CONAN.join('\n')).toMatch(/_run.json missing/);
    const games = db.db.prepare('SELECT DISTINCT game_code g FROM events ORDER BY g').all().map((r: Ev) => r.g);
    expect(games).toEqual(['OPCG', 'PTCG']);
  });

  it('checks ids, months, window and record_count', () => {
    const [ev] = synthetic(1);
    const cases: Array<[Ev[], Ev | undefined, RegExp]> = [
      [[{ ...ev, id: 'tcgp:other' }], undefined, /id must be tcgp:<external_id>/],
      [[ev, ev], undefined, /duplicate id/],
      [[{ ...ev, starts_on: '2027-03-01' }], undefined, /outside run window/],
      [[ev], run('OPCG', 2), /record_count 2 != 1/],
      [[{ ...ev, time_precision: 'datetime', starts_at: null }], undefined, /needs starts_at/],
    ];
    for (const [evs, r, msg] of cases) {
      const dir = writeDataDir(evs, r ? { OPCG: r } : {});
      expect(loadAll(dir).flatMap((x) => x.errors).join('\n')).toMatch(msg);
    }
    // File month must match starts_on.
    const dir = writeDataDir([ev]);
    writeFileSync(join(dir, 'OPCG', '2027-01.json'), JSON.stringify([{ ...ev, id: 'tcgp:x2', external_id: 'x2' }]));
    writeFileSync(join(dir, 'OPCG', '_run.json'), JSON.stringify(run('OPCG', 2)));
    expect(loadAll(dir)[0].errors.join('\n')).toMatch(/in 2027-01.json/);
  });

  it('escapes quotes and keeps statements under the D1 size limit', () => {
    const evs = synthetic(2000).map((e, i) => (i === 0 ? { ...e, name: "O'Brien's 'quoted' ; DROP TABLE events; --" } : e));
    const dir = writeDataDir(evs);
    const stmts = buildStatements(loadAll(dir).filter((r) => !r.errors.length));
    expect(Math.max(...stmts.map((s: string) => Buffer.byteLength(s)))).toBeLessThan(100_000);
    const db = newDb();
    db.execAll(stmts);
    expect(db.db.prepare('SELECT name FROM events WHERE id = ?').get(evs[0].id)!.name).toBe(evs[0].name);
    expect(toSqlFile(stmts).endsWith(';\n')).toBe(true);
  });
});
