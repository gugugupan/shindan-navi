// Opt-in: PERF=1 npx vitest run tests/perf.test.ts — 20k SYNTHETIC events through the importer and API.
import { describe, expect, it } from 'vitest';
import { api, newDb, synthetic, writeDataDir } from './helpers';
import { buildStatements, loadAll } from '../scripts/lib/importer.mjs';

describe.runIf(process.env.PERF)('20k events', () => {
  it('imports and queries within budget', async () => {
    const t0 = performance.now();
    const dir = writeDataDir(synthetic(20_000));
    const t1 = performance.now();
    const loaded = loadAll(dir);
    expect(loaded.flatMap((r) => r.errors)).toEqual([]);
    const stmts = buildStatements(loaded);
    const t2 = performance.now();
    const db = newDb();
    db.execAll(stmts);
    const t3 = performance.now();
    db.execAll(stmts);
    const t4 = performance.now();
    const timings: Record<string, number> = {};
    for (const q of [
      'from=2026-11-18&until=2027-02-18',
      'from=2026-11-18&until=2027-02-18&game=OPCG&pref=JP-13',
      'from=2026-12-01&until=2027-01-01&days=weekend&fee=free&category=tournament',
      'from=2026-11-18&until=2027-02-18&type=meetup&limit=200',
    ]) {
      const s = performance.now();
      const r = await api(db, `/api/v1/events?${q}`);
      expect(r.status).toBe(200);
      timings[q] = Math.round(performance.now() - s);
    }
    const s = performance.now();
    await api(db, '/api/v1/events/meta');
    timings.meta = Math.round(performance.now() - s);
    const plan = db.db.prepare(`EXPLAIN QUERY PLAN SELECT e.id FROM events e JOIN event_groups g ON g.id = e.event_group_id
      WHERE e.missing_since IS NULL AND e.starts_on >= ? AND e.starts_on < ? AND e.game_code IN (?) AND e.region_code IN (?)
      ORDER BY e.starts_on, e.starts_sort, e.id LIMIT 101`).all('2026-11-18', '2027-02-18', 'OPCG', 'JP-13').map((r: any) => r.detail);
    console.log({
      writeFiles: Math.round(t1 - t0), validateAndBuildSql: Math.round(t2 - t1), statements: stmts.length,
      sqlBytes: stmts.reduce((n: number, x: string) => n + x.length, 0), firstImport: Math.round(t3 - t2), reimport: Math.round(t4 - t3),
      timings, plan,
    });
  });
});
