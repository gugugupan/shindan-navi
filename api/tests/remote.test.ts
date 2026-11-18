import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyState, estimateCost, loadAll, planImport } from '../scripts/lib/importer.mjs';
import { PLACEHOLDER_ID, REMOTE_CONFIG, readBaseConfig, remoteConfig } from '../scripts/remote-config.mjs';
import { synthetic, writeDataDir } from './helpers';

const API_DIR = join(__dirname, '..');
const FAKE_ID = '12345678-90ab-4cde-8f01-23456789abcd';

describe('remote-config', () => {
  it('keeps the placeholder and no custom domain in the committed config', () => {
    const base = readBaseConfig();
    expect(base.d1_databases[0].database_id).toBe(PLACEHOLDER_ID);
    expect(base.routes).toBeUndefined();
  });
  it('injects the id, and the custom domain only on request', () => {
    const c = remoteConfig(FAKE_ID);
    expect(c.d1_databases[0].database_id).toBe(FAKE_ID);
    expect(c.routes).toBeUndefined();
    expect(remoteConfig(FAKE_ID, { domain: true }).routes).toEqual([{ pattern: 'shindan-navi.app', custom_domain: true }]);
  });
  it('refuses a missing, placeholder or malformed id', () => {
    for (const id of [undefined, '', '  ', PLACEHOLDER_ID, 'abc', `${FAKE_ID}x`]) expect(() => remoteConfig(id)).toThrow(/D1_DATABASE_ID/);
  });
});

describe('cost estimate', () => {
  it('counts row + index per written event and the state read', () => {
    const results = loadAll(writeDataDir(synthetic(40)));
    const first = planImport(results, emptyState(), { now: 1 });
    const c = estimateCost(first.stats, emptyState());
    expect(c.writes['events (insert)']).toBe(80);
    expect(c.rowsWritten).toBe(80 + 4 + 2);
    const again = planImport(results, first.state, { now: 2 });
    expect(estimateCost(again.stats, first.state)).toMatchObject({ rowsWritten: 0, reads: { 'state read': 44 } });
  });
});

describe('import --target remote', () => {
  let bin: string;
  let log: string;
  let data: string;
  let saved: string | null = null;
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });

  beforeAll(() => {
    // A fake npx on PATH records the wrangler calls and answers queries with an empty database.
    bin = mkdtempSync(join(tmpdir(), 'fake-npx-'));
    log = join(bin, 'calls.log');
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *--command*) echo '[{"results":[],"success":true}]';; esac\n`);
    chmodSync(join(bin, 'npx'), 0o755);
    // Data committed in a throwaway repo, as the real data/events must be.
    const repo = mkdtempSync(join(tmpdir(), 'events-repo-'));
    git(repo, 'init', '-q');
    data = writeDataDir(synthetic(30), {}, join(repo, 'events'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'data');
    if (existsSync(REMOTE_CONFIG)) {
      saved = `${REMOTE_CONFIG}.bak-test`;
      renameSync(REMOTE_CONFIG, saved);
    }
  });

  afterAll(() => {
    rmSync(REMOTE_CONFIG, { force: true });
    if (saved) renameSync(saved, REMOTE_CONFIG);
  });

  const run = (args: string[], env: Record<string, string> = {}, dir = data) => {
    rmSync(log, { force: true });
    const childEnv: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env };
    if (!env.D1_DATABASE_ID) delete childEnv.D1_DATABASE_ID;
    const r = spawnSync(process.execPath, ['scripts/import-events.mjs', '--target', 'remote', '--data', dir, '--out', join(bin, 'import.sql'), ...args], {
      cwd: API_DIR, encoding: 'utf8', env: childEnv,
    });
    return { ...r, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
  };

  it('refuses without D1_DATABASE_ID', () => {
    const r = run(['--yes']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/D1_DATABASE_ID is empty/);
    expect(r.calls).toEqual([]);
  });

  it('estimates a first import without any remote call by default', () => {
    const r = run([], { D1_DATABASE_ID: FAKE_ID });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/plan against empty database/);
    expect(r.stdout).toMatch(/D1 rows written ~66 /);
    expect(r.stdout).toMatch(/remote import NOT applied/);
    expect(r.stdout + r.stderr).not.toContain(FAKE_ID);
    expect(r.calls).toEqual([]);
  });

  it('refuses --plan / --yes for data that is not committed', () => {
    const loose = writeDataDir(synthetic(5));
    const r = run(['--plan'], { D1_DATABASE_ID: FAKE_ID }, loose);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not inside a git checkout|no committed files/);
    writeFileSync(join(data, 'OPCG', 'note.txt'), 'x');
    const dirty = run(['--yes'], { D1_DATABASE_ID: FAKE_ID });
    rmSync(join(data, 'OPCG', 'note.txt'));
    expect(dirty.stderr).toMatch(/uncommitted changes/);
    expect(dirty.calls).toEqual([]);
  });

  it('reads the remote rows with --plan and writes nothing', () => {
    const r = run(['--plan'], { D1_DATABASE_ID: FAKE_ID });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.every((c) => c.includes('--remote') && c.includes('--command'))).toBe(true);
    expect(r.calls.some((c) => c.includes('migrations'))).toBe(false);
  });

  it('migrates, reads, then executes the file with --yes', () => {
    const r = run(['--yes'], { D1_DATABASE_ID: FAKE_ID });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(FAKE_ID);
    expect(r.calls[0]).toBe(`wrangler d1 migrations apply shindan-navi-events --remote --config ${REMOTE_CONFIG}`);
    expect(r.calls.at(-1)).toBe(`wrangler d1 execute shindan-navi-events --remote --yes --config ${REMOTE_CONFIG} --file ${join(bin, 'import.sql')}`);
    expect(JSON.parse(readFileSync(REMOTE_CONFIG, 'utf8')).d1_databases[0].database_id).toBe(FAKE_ID);
  });

  it('stops before writing when the plan exceeds --max-writes', () => {
    const r = run(['--yes', '--max-writes', '10'], { D1_DATABASE_ID: FAKE_ID });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/more than --max-writes 10/);
    expect(r.calls.some((c) => c.includes('--file'))).toBe(false);
  });
});
