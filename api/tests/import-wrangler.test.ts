import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_DIR } from '../scripts/lib/importer.mjs';
import { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';
import { synthetic, writeDataDir } from './helpers';

// The wrangler reader path of import-events.mjs (shared by --target remote) against a stand-in that writes warnings to
// stderr, with and without migration 0007 (landing_pages).
function runImport(landing: boolean) {
  const file = join(mkdtempSync(join(tmpdir(), 'fake-d1-')), 'd1.sqlite3');
  new SqliteD1(file).migrate(undefined, { before: landing ? null : '0007' }).close();
  const data = writeDataDir(synthetic(120));
  const r = spawnSync(process.execPath, ['scripts/import-events.mjs', '--target', 'wrangler', '--data', data, '--out', join(data, 'import.sql')], {
    cwd: API_DIR, encoding: 'utf8', env: { ...process.env, IMPORT_WRANGLER: join(API_DIR, 'tests/fixtures/fake-wrangler.mjs'), FAKE_D1: file },
  });
  const db = new SqliteD1(file);
  const count = (t: string) => (db.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { r, events: count('events'), landing: landing ? count('landing_pages') : null };
}

describe('import-events.mjs --target wrangler', () => {
  it('imports without the landing table, noting the skip despite stderr warnings', () => {
    const { r, events } = runImport(false);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('note: landing_pages: table missing');
    expect(events).toBe(120);
  });

  it('writes the landing rows when the table exists', () => {
    const { r, events, landing } = runImport(true);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/landing_pages 192/);
    expect(events).toBe(120);
    expect(landing).toBe(192);
  });
});
