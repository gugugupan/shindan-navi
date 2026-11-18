// Opt-in: PERF=1 npx vitest run tests/perf.test.ts — 20k SYNTHETIC events through the importer and API.
import { describe, expect, it } from 'vitest';
import { api, newDb, synthetic, writeDataDir } from './helpers';
import { emptyState, loadAll, planImport } from '../scripts/lib/importer.mjs';

describe.runIf(process.env.PERF)('20k events', () => {
  it('imports and queries within budget', async () => {
    const t0 = performance.now();
    const dir = writeDataDir(synthetic(20_000));
    const t1 = performance.now();
    const loaded = loadAll(dir);
    expect(loaded.flatMap((r) => r.errors)).toEqual([]);
    const stmts = planImport(loaded, emptyState()).statements;
    const t2 = performance.now();
    const db = newDb();
    db.execAll(stmts);
    const t3 = performance.now();
    db.execAll(planImport(loaded, db.readState()).statements);
    const t4 = performance.now();
    const timings: Record<string, number> = {};
    for (const q of [
      'from=2026-11-18&until=2026-12-01&pref=JP-13',
      'from=2026-11-18&until=2026-12-01&game=OPCG&pref=JP-13',
      'from=2026-12-01&until=2027-01-01&days=weekend&pref=JP-13,JP-14',
      'from=2026-11-18&until=2026-12-01&type=meetup&pref=JP-27',
      'from=2026-11-18&until=2026-12-01&game=PTCG&pref=JP-13,JP-14,JP-27,JP-40,online',
    ]) {
      const s = performance.now();
      const r = await api(db, `/api/v1/events?${q}`);
      expect(r.status).toBe(200);
      timings[q] = Math.round(performance.now() - s);
    }
    let s = performance.now();
    await api(db, '/api/v1/events/days?from=2026-12-01&until=2027-01-01&pref=JP-13');
    timings.days = Math.round(performance.now() - s);
    s = performance.now();
    await api(db, '/api/v1/events/meta');
    timings.meta = Math.round(performance.now() - s);
    console.log({
      writeFiles: Math.round(t1 - t0), validateAndBuildSql: Math.round(t2 - t1), statements: stmts.length,
      sqlBytes: stmts.reduce((n: number, x: string) => n + x.length, 0), firstImport: Math.round(t3 - t2), reimport: Math.round(t4 - t3),
      timings,
    });
  });
});
