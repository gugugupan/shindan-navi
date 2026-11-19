import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyState, estimateCost, loadAll, planImport } from '../scripts/lib/importer.mjs';
import { PLACEHOLDER_ID, REMOTE_CONFIG, readBaseConfig, remoteConfig } from '../scripts/remote-config.mjs';
import { run as runOf, synthetic, writeDataDir } from './helpers';

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
  it('adds the feedback mail binding only with feedback on, never with a fixed destination', () => {
    expect(readBaseConfig().send_email).toBeUndefined();
    expect(remoteConfig(FAKE_ID).send_email).toBeUndefined();
    const [b] = remoteConfig(FAKE_ID, { feedback: true }).send_email;
    expect(b).toEqual({ name: 'FEEDBACK_EMAIL', allowed_sender_addresses: ['feedback-form@shindan-navi.app'] });
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
    expect(first.stats.day_counts).toBeGreaterThan(0);
    expect(c.rowsWritten).toBe(80 + 4 + first.stats.day_counts + 2);
    const again = planImport(results, first.state, { now: 2 });
    expect(estimateCost(again.stats, first.state)).toMatchObject({ rowsWritten: 0, reads: { 'state read': 40 + 4 + 2 + first.stats.day_counts } });
  });
});

describe('import --target remote', () => {
  let bin: string;
  let log: string;
  let data: string;
  let saved: string | null = null;

  beforeAll(() => {
    // A fake npx on PATH records the wrangler calls and answers queries with an empty database.
    bin = mkdtempSync(join(tmpdir(), 'fake-npx-'));
    log = join(bin, 'calls.log');
    // FAKE_STATE (a JSON file) answers the events state read; every other query gets an empty result.
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *"FROM events"*) if [ -n "$FAKE_STATE" ]; then cat "$FAKE_STATE"; else echo '[{"results":[],"success":true}]'; fi;; *"FROM imports"*) if [ -n "$FAKE_IMPORTS" ]; then cat "$FAKE_IMPORTS"; else echo '[{"results":[],"success":true}]'; fi;; *--command*) echo '[{"results":[],"success":true}]';; esac\n`);
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
    expect(r.stdout).toMatch(/D1 rows written ~\d+ \(events \(insert\) 60, imports 4, day_counts \d+, site_meta 2\)/);
    expect(r.stdout).toMatch(/remote import NOT applied/);
    expect(r.stdout + r.stderr).not.toContain(FAKE_ID);
    expect(r.calls).toEqual([]);
  });

  it('refuses incomplete runs unless allowed per game', () => {
    const evs = synthetic(12);
    const partial = writeDataDir(evs, { CONAN: runOf('CONAN', evs.filter((e) => e.game_code === 'CONAN').length, { complete: false }) });
    const r = run(['--yes'], { D1_DATABASE_ID: FAKE_ID }, partial);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/incomplete run\(s\) for CONAN/);
    expect(r.calls).toEqual([]);
    expect(run(['--allow-incomplete', 'CONAN'], { D1_DATABASE_ID: FAKE_ID }, partial).status).toBe(0);
  });

  it('prints a per-game review summary', () => {
    const r = run([], { D1_DATABASE_ID: FAKE_ID });
    expect(r.stdout).toMatch(/game\s+fetched_at\s+source_total\s+records\s+in D1 now\s+inserted\s+updated\s+unchanged\s+hidden/);
    expect(r.stdout).toMatch(/OPCG\s+2026-11-18T00:00:00Z\s+8\s+8\s+0\s+8\s+0\s+0\s+0/);
  });

  it('refuses a run that shrinks over 20% against D1 unless --allow-shrink', () => {
    // The fake D1 answers the state read with 10 visible OPCG events in the window.
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `tcgp:old${i}`, content_hash: 'x', game_mask: 1, starts_on: '2026-12-01', loc: 'JP-13', region_code: 'JP-13', attendance_mode: 'in_person', category: 'casual', event_type_code: null }));
    writeFileSync(join(bin, 'state.json'), JSON.stringify([{ results: rows, success: true }]));
    const small = writeDataDir(synthetic(4).filter((e) => e.game_code === 'OPCG'));
    const r = run(['--plan'], { D1_DATABASE_ID: FAKE_ID, FAKE_STATE: join(bin, 'state.json') }, small);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/OPCG 10 -> 1/);
    expect(run(['--plan', '--allow-shrink'], { D1_DATABASE_ID: FAKE_ID, FAKE_STATE: join(bin, 'state.json') }, small).status).toBe(0);
    // Incomplete runs hide nothing, so they are exempt.
    const partialSmall = writeDataDir(synthetic(4).filter((e) => e.game_code === 'OPCG'), { OPCG: runOf('OPCG', 1, { complete: false }) });
    expect(run(['--plan', '--allow-incomplete', 'OPCG'], { D1_DATABASE_ID: FAKE_ID, FAKE_STATE: join(bin, 'state.json') }, partialSmall).status).toBe(0);
  });

  it('refuses a complete run whose window ends before the previous import', () => {
    const prev = { id: 'OPCG:2026-11-17T00:00:00Z', game_code: 'OPCG', fetched_at: '2026-11-17T00:00:00Z', window_from: '2026-11-17', window_until: '2027-03-01', record_count: 8, complete: 1 };
    writeFileSync(join(bin, 'imports.json'), JSON.stringify([{ results: [prev], success: true }]));
    const r = run(['--plan'], { D1_DATABASE_ID: FAKE_ID, FAKE_IMPORTS: join(bin, 'imports.json') });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/OPCG window ends 2027-02-18, before the previous 2027-03-01/);
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
