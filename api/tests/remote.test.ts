import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateRowsWritten, importCounts, loadAll } from '../scripts/lib/importer.mjs';
import { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';
import { PLACEHOLDER_ID, REMOTE_CONFIG, readBaseConfig, remoteConfig } from '../scripts/remote-config.mjs';
import { conflicting, synthetic, writeDataDir } from './helpers';

const API_DIR = join(__dirname, '..');
const FAKE_ID = '12345678-90ab-4cde-8f01-23456789abcd';

describe('remote-config', () => {
  it('keeps the placeholder in the committed config', () => {
    expect(readBaseConfig().d1_databases[0].database_id).toBe(PLACEHOLDER_ID);
  });
  it('injects the id and can drop routes', () => {
    const c = remoteConfig(FAKE_ID);
    expect(c.d1_databases[0].database_id).toBe(FAKE_ID);
    expect(c.routes).toEqual([{ pattern: 'shindan-navi.app', custom_domain: true }]);
    expect(remoteConfig(FAKE_ID, { noRoutes: true }).routes).toBeUndefined();
  });
  it('refuses a missing, placeholder or malformed id', () => {
    for (const id of [undefined, '', '  ', PLACEHOLDER_ID, 'abc', `${FAKE_ID}x`]) expect(() => remoteConfig(id)).toThrow(/D1_DATABASE_ID/);
  });
});

describe('write estimate', () => {
  it('counts each row once plus once per index, shared events once', () => {
    const evs = synthetic(40);
    // synthetic(…)[1] is UATCG (TCG+), so the same record may also be listed under OPCG.
    const shared = { ...evs[1], game_code: 'OPCG' };
    const results = loadAll(writeDataDir([...evs, ...conflicting(9), shared]));
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    const counts = importCounts(results);
    expect(counts.events).toBe(49);
    expect(counts.event_games).toBe(50);
    const db = new SqliteD1().migrate();
    const idx = db.indexCounts();
    db.close();
    expect(idx.events).toBe(6);
    const est = estimateRowsWritten(counts, idx);
    expect(est.tables.events).toBe(49 * 7);
    expect(est.tables['events.game_codes']).toBe(49);
    expect(est.total).toBe(Object.values(est.tables).reduce((a, b) => a + b, 0));
  });
});

describe('import --target remote', () => {
  let bin: string;
  let log: string;
  let data: string;
  let saved: string | null = null;

  beforeAll(() => {
    // A fake npx on PATH records the wrangler calls; nothing reaches Cloudflare.
    bin = mkdtempSync(join(tmpdir(), 'fake-npx-'));
    log = join(bin, 'calls.log');
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(join(bin, 'npx'), 0o755);
    data = writeDataDir(synthetic(30));
    if (existsSync(REMOTE_CONFIG)) {
      saved = `${REMOTE_CONFIG}.bak-test`;
      renameSync(REMOTE_CONFIG, saved);
    }
  });

  afterAll(() => {
    rmSync(REMOTE_CONFIG, { force: true });
    if (saved) renameSync(saved, REMOTE_CONFIG);
  });

  const run = (args: string[], env: Record<string, string | undefined>) => {
    rmSync(log, { force: true });
    const out = join(bin, 'import.sql');
    const childEnv: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env };
    if (!env.D1_DATABASE_ID) delete childEnv.D1_DATABASE_ID;
    const r = spawnSync(process.execPath, ['scripts/import-events.mjs', '--target', 'remote', '--data', data, '--out', out, ...args], {
      cwd: API_DIR,
      encoding: 'utf8',
      env: childEnv,
    });
    return { ...r, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
  };

  it('refuses without D1_DATABASE_ID', () => {
    const r = run(['--yes'], {});
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/D1_DATABASE_ID is empty/);
    expect(r.calls).toEqual([]);
  });

  it('only prints a summary without --yes', () => {
    const r = run([], { D1_DATABASE_ID: FAKE_ID });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/D1 rows written \(upper bound/);
    expect(r.stdout).toMatch(/remote import NOT run/);
    expect(r.stdout + r.stderr).not.toContain(FAKE_ID);
    expect(r.calls).toEqual([]);
    expect(existsSync(REMOTE_CONFIG)).toBe(false);
  });

  it('migrates then executes the file against the remote config with --yes', () => {
    const r = run(['--yes'], { D1_DATABASE_ID: FAKE_ID });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(FAKE_ID);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toBe(`wrangler d1 migrations apply shindan-navi-events --remote --config ${REMOTE_CONFIG}`);
    expect(r.calls[1]).toBe(`wrangler d1 execute shindan-navi-events --remote --yes --config ${REMOTE_CONFIG} --file ${join(bin, 'import.sql')}`);
    expect(JSON.parse(readFileSync(REMOTE_CONFIG, 'utf8')).d1_databases[0].database_id).toBe(FAKE_ID);
  });
});
