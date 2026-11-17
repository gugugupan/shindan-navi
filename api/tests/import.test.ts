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
    expect(db.db.prepare('SELECT missing_since FROM event_games WHERE event_id = ?').get(gone.id)!.missing_since).toBe('2026-11-20T00:00:00Z');
    expect(db.db.prepare('SELECT game_codes FROM events WHERE id = ?').get(gone.id)!.game_codes).toBeNull();
    expect((await api(db, '/api/v1/events/meta')).body.games[0].record_count).toBe(rest.length);

    importDir(db, writeDataDir(evs, { OPCG: run('OPCG', evs.length, { fetched_at: '2026-11-21T00:00:00Z' }) }), 3_000);
    expect((await api(db, q)).body.events.map((e: Ev) => e.id)).toContain(gone.id);
  });

  it('does not hide anything for incomplete runs or outside the run window', async () => {
    const db = newDb();
    const evs = synthetic(40).filter((e) => e.game_code === 'OPCG');
    importDir(db, writeDataDir(evs), 1_000);
    importDir(db, writeDataDir(evs.slice(0, 2), { OPCG: run('OPCG', 2, { fetched_at: '2026-11-20T00:00:00Z', complete: false }) }), 2_000);
    expect(db.db.prepare('SELECT COUNT(*) n FROM events WHERE game_codes IS NOT NULL').get()!.n).toBe(evs.length);
    // A later window: old events before it are left alone.
    const later = evs.filter((e) => e.starts_on >= '2026-12-18');
    importDir(db, writeDataDir(later, { OPCG: run('OPCG', later.length, { fetched_at: '2026-12-18T00:00:00Z', window: { from: '2026-12-18', until: '2027-03-18' } }) }), 3_000);
    expect(db.db.prepare('SELECT COUNT(*) n FROM events WHERE game_codes IS NOT NULL').get()!.n).toBe(evs.length);
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
    const games = db.db.prepare('SELECT DISTINCT game_code g FROM event_games ORDER BY g').all().map((r: Ev) => r.g);
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

  it('accepts the conan source', async () => {
    const db = newDb();
    const evs = synthetic(8).filter((e) => e.game_code === 'CONAN');
    expect(evs[0].id).toMatch(/^conan:/);
    expect(importDir(db, writeDataDir(evs)).flatMap((r) => r.errors)).toEqual([]);
    const r = await api(db, '/api/v1/events?from=2026-11-18&until=2027-02-18&game=CONAN');
    expect(r.body.events.map((e: Ev) => e.source_code)).toEqual(evs.map(() => 'conan_official'));
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

describe('shared events', () => {
  // SYNTHETIC: one event listed under both OPCG and UATCG, identical apart from game_code.
  const base = synthetic(16);
  const shared: Ev = { ...base.find((e) => e.game_code === 'OPCG')!, id: 'tcgp:shared1', external_id: 'shared1', name: '【SYNTHETIC】shared series' };
  const opcg = [...base.filter((e) => e.game_code === 'OPCG'), shared];
  const uatcg = [...base.filter((e) => e.game_code === 'UATCG'), { ...shared, game_code: 'UATCG', last_seen_at: '2026-11-18T01:00:00Z' }];
  const q = '/api/v1/events?from=2026-11-18&until=2027-02-18&limit=200';

  function load() {
    const db = newDb();
    const results = importDir(db, writeDataDir([...opcg, ...uatcg]), 1_000);
    expect(results.flatMap((r) => [...r.errors, ...r.warnings])).toEqual([]);
    return db;
  }

  it('stores one event with both games and returns game_codes', async () => {
    const db = load();
    expect(db.db.prepare('SELECT COUNT(*) n FROM events WHERE id = ?').get(shared.id)!.n).toBe(1);
    const all = (await api(db, q)).body;
    expect(all.count).toBe(opcg.length + uatcg.length - 1);
    const ev = all.events.find((e: Ev) => e.id === shared.id);
    expect(ev.game_code).toBe('OPCG');
    expect(ev.game_codes).toEqual(['OPCG', 'UATCG']);
    for (const g of ['OPCG', 'UATCG']) {
      const r = (await api(db, `${q}&game=${g}`)).body;
      expect(r.events.map((e: Ev) => e.id)).toContain(shared.id);
      expect(r.count).toBe((g === 'OPCG' ? opcg : uatcg).length);
    }
    expect((await api(db, `${q}&game=OPCG,UATCG`)).body.count).toBe(all.count);
  });

  it('counts the event once per day and once per member game in by_game', async () => {
    const db = load();
    const day = (await api(db, `/api/v1/events/days?from=${shared.starts_on}&until=${new Date(Date.parse(`${shared.starts_on}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}`)).body.days[0];
    const others = base.filter((e) => e.starts_on === shared.starts_on);
    expect(day.count).toBe(others.length + 1);
    expect(day.by_game.OPCG).toBe(others.filter((e) => e.game_code === 'OPCG').length + 1);
    expect(day.by_game.UATCG).toBe(others.filter((e) => e.game_code === 'UATCG').length + 1);
  });

  it('keeps per-game meta and missing handling separate', async () => {
    const db = load();
    let meta = (await api(db, '/api/v1/events/meta')).body;
    expect(meta.games.find((g: Ev) => g.code === 'UATCG').record_count).toBe(uatcg.length);
    const total = meta.categories.reduce((n: number, c: Ev) => n + c.count, 0);
    expect(total).toBe(opcg.length + uatcg.length - 1);

    // UATCG's complete run drops the shared event: it stays visible through OPCG only.
    const uatcg2 = uatcg.filter((e) => e.id !== shared.id);
    importDir(db, writeDataDir(uatcg2, { UATCG: run('UATCG', uatcg2.length, { fetched_at: '2026-11-19T00:00:00Z' }) }), 2_000);
    let ev = (await api(db, q)).body.events.find((e: Ev) => e.id === shared.id);
    expect(ev.game_codes).toEqual(['OPCG']);
    expect((await api(db, `${q}&game=UATCG`)).body.events.map((e: Ev) => e.id)).not.toContain(shared.id);
    meta = (await api(db, '/api/v1/events/meta')).body;
    expect(meta.categories.reduce((n: number, c: Ev) => n + c.count, 0)).toBe(total);

    // OPCG drops it too: hidden everywhere, row kept.
    const opcg2 = opcg.filter((e) => e.id !== shared.id);
    importDir(db, writeDataDir(opcg2, { OPCG: run('OPCG', opcg2.length, { fetched_at: '2026-11-19T00:00:00Z' }) }), 3_000);
    expect((await api(db, q)).body.events.map((e: Ev) => e.id)).not.toContain(shared.id);
    expect(db.db.prepare('SELECT COUNT(*) n FROM events WHERE id = ?').get(shared.id)!.n).toBe(1);

    // Back in UATCG only.
    importDir(db, writeDataDir(uatcg, { UATCG: run('UATCG', uatcg.length, { fetched_at: '2026-11-20T00:00:00Z' }) }), 4_000);
    ev = (await api(db, q)).body.events.find((e: Ev) => e.id === shared.id);
    expect(ev).toMatchObject({ game_code: 'UATCG', game_codes: ['UATCG'] });
  });

  it('warns when shared copies differ', () => {
    const dir = writeDataDir([...opcg, ...uatcg.map((e) => (e.id === shared.id ? { ...e, name: 'different' } : e))]);
    expect(loadAll(dir).flatMap((r) => r.warnings).join('\n')).toMatch(/tcgp:shared1: differs from the copy in OPCG/);
  });
});
