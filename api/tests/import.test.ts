import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PREFS, api, apiAll, importDir, newDb, run, sampleEvents, synthetic, writeDataDir, type Ev } from './helpers';
import { emptyState, estimateCost, loadAll, MAX_STATEMENT_BYTES, planImport, toSqlFile } from '../scripts/lib/importer.mjs';
import type { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';

const snapshot = (db: SqliteD1) => ({
  events: db.db.prepare('SELECT * FROM events ORDER BY id').all(),
  imports: db.db.prepare('SELECT * FROM imports ORDER BY id').all(),
  meta: db.db.prepare('SELECT * FROM site_meta ORDER BY key').all(),
});
const mask = (db: SqliteD1, id: string) => db.db.prepare('SELECT game_mask m FROM events WHERE id = ?').get(id)!.m;
const visible = (db: SqliteD1) => db.db.prepare('SELECT COUNT(*) n FROM events WHERE game_mask <> 0').get()!.n;
const Q = `/api/v1/events?from=2026-11-18&until=2027-02-18&${ALL_PREFS}`;

describe('importer', () => {
  it('writes nothing when the same files are imported again', () => {
    const db = newDb();
    const dir = writeDataDir([...sampleEvents(), ...synthetic(300)]);
    const first = importDir(db, dir, 1_000).plan;
    expect(first.stats).toMatchObject({ inserted: 303, rewritten: 0, mask_updates: 0, imports: 4, site_meta: 2 });
    const before = snapshot(db);
    const again = importDir(db, dir, 2_000).plan;
    expect(again.statements).toEqual([]);
    expect(again.version).toBeNull();
    expect(snapshot(db)).toEqual(before);
  });

  it('repairs missing or stale site_meta even when no event changed', () => {
    const db = newDb();
    const dir = writeDataDir(synthetic(20));
    importDir(db, dir, 1_000);
    db.db.exec("DELETE FROM site_meta WHERE key = 'state'");
    const repair = importDir(db, dir, 2_000).plan;
    expect(repair.stats).toMatchObject({ inserted: 0, rewritten: 0, mask_updates: 0, imports: 0, site_meta: 2 });
    expect(JSON.parse(String(db.db.prepare("SELECT value FROM site_meta WHERE key = 'state'").get()!.value))).toMatchObject({ version: '2000', window: { from: '2026-11-18', until: '2027-02-18' } });
    db.db.exec("UPDATE site_meta SET value = '{}' WHERE key = 'meta'");
    expect(importDir(db, dir, 3_000).plan.stats.site_meta).toBe(2);
    expect(importDir(db, dir, 4_000).plan.statements).toEqual([]);
  });

  it('keeps day_counts equal to the visible events and repairs it', () => {
    const db = newDb();
    const evs = synthetic(60).filter((e) => e.game_code === 'OPCG');
    const dir = writeDataDir(evs);
    importDir(db, dir, 1_000);
    const sum = () => Number(db.db.prepare('SELECT COALESCE(SUM(n), 0) s FROM day_counts').get()!.s);
    expect(sum()).toBe(evs.length);
    const rest = evs.slice(1);
    importDir(db, writeDataDir(rest, { OPCG: run('OPCG', rest.length, { fetched_at: '2026-11-19T00:00:00Z' }) }), 2_000);
    expect(sum()).toBe(rest.length);
    db.db.exec('DELETE FROM day_counts');
    const repair = importDir(db, writeDataDir(rest, { OPCG: run('OPCG', rest.length, { fetched_at: '2026-11-19T00:00:00Z' }) }), 3_000).plan;
    expect(repair.stats.day_counts).toBeGreaterThan(0);
    expect(sum()).toBe(rest.length);
  });

  it('warns about in-person events that no location can reach', () => {
    const ev = synthetic(2)[1];
    const dir = writeDataDir([{ ...ev, attendance_mode: 'in_person', venue: { ...ev.venue, region_code: null, region_name: null } }]);
    expect(loadAll(dir).flatMap((r) => r.warnings).join('\n')).toMatch(/1 in-person event\(s\) with a venue but no region_code are unreachable/);
  });

  it('rewrites only changed events, serves last_seen_at from the import and bumps the data version', async () => {
    const db = newDb();
    const evs = synthetic(20);
    importDir(db, writeDataDir(evs), 1_000);
    const changed = evs.map((e, i) => ({ ...e, last_seen_at: '2026-11-19T00:00:00Z', name: i === 0 ? `${e.name} (renamed)` : e.name }));
    const runs = Object.fromEntries(['OPCG', 'UATCG', 'CONAN', 'PTCG'].map((g) => [g, run(g, 5, { fetched_at: '2026-11-19T00:00:00Z' })]));
    const plan = importDir(db, writeDataDir(changed, runs), 2_000).plan;
    expect(plan.stats).toMatchObject({ inserted: 0, rewritten: 1, mask_updates: 0, imports: 4 });
    expect(estimateCost(plan.stats, emptyState()).rowsWritten).toBe(2 + 4 + 2);
    const rows = db.db.prepare('SELECT id, updated_at, created_at FROM events ORDER BY id').all();
    expect(rows.filter((r: Ev) => r.updated_at === 2_000).map((r: Ev) => r.id)).toEqual([evs[0].id]);
    expect(rows.every((r: Ev) => r.created_at === 1_000)).toBe(true);
    const got = (await apiAll(db, Q)).body.events;
    expect(got.every((e: Ev) => e.last_seen_at === '2026-11-19T00:00:00Z')).toBe(true);
    expect(JSON.parse(String(db.db.prepare("SELECT value FROM site_meta WHERE key = 'state'").get()!.value)).version).toBe('2000');
  });

  it('hides events missing from a complete run, keeps them in the table, and restores them when they return', async () => {
    const db = newDb();
    const evs = synthetic(40).filter((e) => e.game_code === 'OPCG');
    importDir(db, writeDataDir(evs), 1_000);
    const gone = evs[3];
    const rest = evs.filter((e) => e !== gone);
    importDir(db, writeDataDir(rest, { OPCG: run('OPCG', rest.length, { fetched_at: '2026-11-20T00:00:00Z' }) }), 2_000);
    expect((await apiAll(db, Q)).body.events.map((e: Ev) => e.id)).not.toContain(gone.id);
    expect(mask(db, gone.id)).toBe(0);
    expect((await api(db, '/api/v1/events/meta')).body.games[0].record_count).toBe(rest.length);

    const back = importDir(db, writeDataDir(evs, { OPCG: run('OPCG', evs.length, { fetched_at: '2026-11-21T00:00:00Z' }) }), 3_000).plan;
    expect(back.stats).toMatchObject({ inserted: 0, rewritten: 0, mask_updates: 1 });
    expect((await apiAll(db, Q)).body.events.map((e: Ev) => e.id)).toContain(gone.id);
  });

  it('does not hide anything for incomplete runs or outside the run window', async () => {
    const db = newDb();
    const evs = synthetic(40).filter((e) => e.game_code === 'OPCG');
    importDir(db, writeDataDir(evs), 1_000);
    importDir(db, writeDataDir(evs.slice(0, 2), { OPCG: run('OPCG', 2, { fetched_at: '2026-11-20T00:00:00Z', complete: false }) }), 2_000);
    expect(visible(db)).toBe(evs.length);
    // A later window: old events before it are left alone.
    const later = evs.filter((e) => e.starts_on >= '2026-12-18');
    importDir(db, writeDataDir(later, { OPCG: run('OPCG', later.length, { fetched_at: '2026-12-18T00:00:00Z', window: { from: '2026-12-18', until: '2027-03-18' } }) }), 3_000);
    expect(visible(db)).toBe(evs.length);
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
    const masks = db.db.prepare('SELECT DISTINCT game_mask m FROM events ORDER BY m').all().map((r: Ev) => r.m);
    expect(masks).toEqual([1, 8]);
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
    const r = await apiAll(db, `/api/v1/events?from=2026-11-18&until=2027-02-18&game=CONAN&${ALL_PREFS}`);
    expect(r.body.events.map((e: Ev) => e.source_code)).toEqual(evs.map(() => 'conan_official'));
  });

  it('escapes quotes and keeps statements under the byte budget with multibyte text', () => {
    // Japanese text is 3 bytes per character in UTF-8 but 1 UTF-16 unit: the budget must count bytes.
    const long = '【SYNTHETIC】東京都千代田区丸の内一丁目のカードショップで開催されるスタンダードバトル'.repeat(8);
    const evs = synthetic(2000).map((e, i) => ({ ...e, name: i === 0 ? "O'Brien's 'quoted' ; DROP TABLE events; --" : e.name, eligibility_text: long, format_text: long }) as Ev);
    const dir = writeDataDir(evs);
    const stmts = planImport(loadAll(dir).filter((r) => !r.errors.length)).statements;
    expect(stmts.length).toBeGreaterThan(20);
    expect(Math.max(...stmts.map((s: string) => Buffer.byteLength(s)))).toBeLessThanOrEqual(MAX_STATEMENT_BYTES);
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
  const q = Q;
  const total = async (db: SqliteD1, extra = '') =>
    (await apiAll(db, `/api/v1/events/days?from=2026-11-18&until=2027-02-18&${ALL_PREFS}${extra}`)).body.days.reduce((n: number, d: Ev) => n + d.count, 0);

  function load() {
    const db = newDb();
    const results = importDir(db, writeDataDir([...opcg, ...uatcg]), 1_000);
    expect(results.flatMap((r) => [...r.errors, ...r.warnings])).toEqual([]);
    return db;
  }

  it('stores one event with both games and returns game_codes', async () => {
    const db = load();
    expect(db.db.prepare('SELECT COUNT(*) n FROM events WHERE id = ?').get(shared.id)!.n).toBe(1);
    const all = (await apiAll(db, q)).body;
    expect(await total(db)).toBe(opcg.length + uatcg.length - 1);
    const ev = all.events.find((e: Ev) => e.id === shared.id);
    expect(ev.game_code).toBe('OPCG');
    expect(ev.game_codes).toEqual(['OPCG', 'UATCG']);
    for (const g of ['OPCG', 'UATCG']) {
      const r = (await apiAll(db, `${q}&game=${g}`)).body;
      expect(r.events.map((e: Ev) => e.id)).toContain(shared.id);
      expect(await total(db, `&game=${g}`)).toBe((g === 'OPCG' ? opcg : uatcg).length);
    }
    expect(await total(db, '&game=OPCG,UATCG')).toBe(await total(db));
  });

  it('counts the event once per day and once per member game in by_game', async () => {
    const db = load();
    const oneDay = `from=${shared.starts_on}&until=${new Date(Date.parse(`${shared.starts_on}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}`;
    const day = (await apiAll(db, `/api/v1/events/days?${ALL_PREFS}&${oneDay}`)).body.days[0];
    const others = base.filter((e) => e.starts_on === shared.starts_on);
    expect(day.count).toBe(others.length + 1);
    expect(day.by_game.OPCG).toBe(others.filter((e) => e.game_code === 'OPCG').length + 1);
    expect(day.by_game.UATCG).toBe(others.filter((e) => e.game_code === 'UATCG').length + 1);
    const opcgOnly = (await apiAll(db, `/api/v1/events/days?${ALL_PREFS}&game=OPCG&${oneDay}`)).body.days[0];
    expect(Object.keys(opcgOnly.by_game)).toEqual(['OPCG']);
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
    let ev = (await apiAll(db, q)).body.events.find((e: Ev) => e.id === shared.id);
    expect(ev.game_codes).toEqual(['OPCG']);
    expect((await apiAll(db, `${q}&game=UATCG`)).body.events.map((e: Ev) => e.id)).not.toContain(shared.id);
    meta = (await api(db, '/api/v1/events/meta')).body;
    expect(meta.categories.reduce((n: number, c: Ev) => n + c.count, 0)).toBe(total);

    // OPCG drops it too: hidden everywhere, row kept.
    const opcg2 = opcg.filter((e) => e.id !== shared.id);
    importDir(db, writeDataDir(opcg2, { OPCG: run('OPCG', opcg2.length, { fetched_at: '2026-11-19T00:00:00Z' }) }), 3_000);
    expect((await apiAll(db, q)).body.events.map((e: Ev) => e.id)).not.toContain(shared.id);
    expect(db.db.prepare('SELECT COUNT(*) n FROM events WHERE id = ?').get(shared.id)!.n).toBe(1);

    // Back in UATCG only.
    importDir(db, writeDataDir(uatcg, { UATCG: run('UATCG', uatcg.length, { fetched_at: '2026-11-20T00:00:00Z' }) }), 4_000);
    ev = (await apiAll(db, q)).body.events.find((e: Ev) => e.id === shared.id);
    expect(ev).toMatchObject({ game_code: 'UATCG', game_codes: ['UATCG'] });
  });

  it('warns when shared copies differ', () => {
    const dir = writeDataDir([...opcg, ...uatcg.map((e) => (e.id === shared.id ? { ...e, name: 'different' } : e))]);
    expect(loadAll(dir).flatMap((r) => r.warnings).join('\n')).toMatch(/tcgp:shared1: differs from the copy in OPCG/);
  });
});

describe('venue geo', () => {
  const tokyo = (ev: Ev) => ev.venue?.region_code === 'JP-13';
  const geo = { lat: 35.690921, lng: 139.700258, source: 'tcgplus', precision: null, place_id: null, geocoded_at: null };
  const evs = () => synthetic(40).filter((e) => e.venue).map((e) => ({ ...e, venue: { ...e.venue, geo: undefined } }));
  const strip = (list: Ev[]): Ev[] => list.map((e) => { const { geo: _, ...venue } = e.venue; return { ...e, venue }; });
  const geoOf = async (db: SqliteD1, id: string) => (await apiAll(db, Q)).body.events.find((e: Ev) => e.id === id).venue.geo;

  it('ignores dot directories such as .venues', () => {
    const dir = writeDataDir(sampleEvents());
    mkdirSync(join(dir, '.venues'));
    writeFileSync(join(dir, '.venues', 'tcgplus.json'), '{"version":1,"source":"tcgplus","entries":{}}\n');
    const results = loadAll(dir);
    expect(results.map((r) => r.game).sort()).toEqual(['OPCG', 'PTCG', 'UATCG']);
    expect(results.flatMap((r) => [...r.errors, ...r.warnings])).toEqual([]);
  });

  it('rewrites only events that gain a geo; geo null and absent hash alike', async () => {
    const db = newDb();
    const base = strip(evs());
    importDir(db, writeDataDir(base), 1_000);
    const withNull = base.map((e) => ({ ...e, venue: { ...e.venue, geo: null } }));
    expect(importDir(db, writeDataDir(withNull), 2_000).plan.statements).toEqual([]);
    const target = base.find(tokyo)!;
    expect(await geoOf(db, target.id)).toBeNull();
    const gained = withNull.map((e) => (tokyo(e) ? { ...e, venue: { ...e.venue, geo } } : e));
    const plan = importDir(db, writeDataDir(gained), 3_000).plan;
    expect(plan.stats).toMatchObject({ inserted: 0, rewritten: base.filter(tokyo).length, mask_updates: 0 });
    expect(await geoOf(db, target.id)).toEqual(geo);
  });

  const day = (n: number, now = Date.now()) => new Date(now + 9 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);
  const google = (n: number, now?: number) => ({ ...geo, source: 'google', precision: 'ROOFTOP', place_id: 'ChIJ-SAMPLE', geocoded_at: day(n, now) });
  const storedGeo = (db: SqliteD1, id: string) =>
    JSON.parse((db.db.prepare('SELECT venue_json v FROM events WHERE id = ?').get(id) as { v: string }).v).geo;

  it('serves a google geo only while geocoded_at is at most 28 days old; stores none older than 30', async () => {
    const db = newDb();
    const list = strip(evs()).filter(tokyo).slice(0, 4);
    const files = list.map((e, i) => ({ ...e, venue: { ...e.venue, geo: google([0, 28, 29, 31][i]) } }));
    const results = importDir(db, writeDataDir(files));
    expect(results.flatMap((r) => r.warnings).join('\n')).toMatch(/1 event\(s\) with a google geo older than 30 days/);
    expect(await geoOf(db, list[0].id)).toEqual(google(0));
    expect(await geoOf(db, list[1].id)).toEqual(google(28));
    expect(await geoOf(db, list[2].id)).toBeNull();
    expect(storedGeo(db, list[2].id)).toEqual(google(29));
    expect(await geoOf(db, list[3].id)).toBeNull();
    expect(storedGeo(db, list[3].id)).toBeNull();
  });

  it('rewrites a row once its stored google geo expires, then leaves it alone', () => {
    const db = newDb();
    const t0 = Date.now() - 40 * 86_400_000;
    const list = strip(evs()).filter(tokyo).slice(0, 2);
    const files = list.map((e, i) => ({ ...e, venue: { ...e.venue, geo: i === 0 ? google(0, t0) : null } }));
    const dir = writeDataDir(files);
    importDir(db, dir, Math.floor(t0 / 1000));
    expect(storedGeo(db, list[0].id)).toEqual(google(0, t0));
    const later = importDir(db, dir).plan;
    expect(later.stats).toMatchObject({ inserted: 0, rewritten: 1 });
    expect(storedGeo(db, list[0].id)).toBeNull();
    expect(importDir(db, dir).plan.stats).toMatchObject({ inserted: 0, rewritten: 0 });
  });
});
