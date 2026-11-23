import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_VERSION, flattenGroups, listPath } from '../lib/collect.mjs';

// Every run is --dry-run, and either --from-raw or --max-requests 0: no request is made and data/events is never written.
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'collect.mjs');
const run = (...args) => spawnSync(process.execPath, [script, '--dry-run', ...args], { encoding: 'utf8', timeout: 10_000 });

const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'event-list.json'), 'utf8')).success;
const wsRows = flattenGroups(fixture.organizer_event_series.filter((g) => g.game_title_id === 2));

function withRaw(fn, { coverage = COVERAGE_VERSION, rows = [], fetchedAt = '2000-01-01T00:00:00Z' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bushi-raw-'));
  const file = join(dir, 'raw.json');
  const chunk = { game: 'WS', gameTitleId: 2, startDate: '2026-11-18', endDate: '2026-11-24' };
  const meta = { ...(coverage && { coverage }), chunk, total: 0, pages: 1 };
  writeFileSync(file, JSON.stringify({ ...(coverage && { coverage }), fetchedAt, requests: 1, plan: [chunk], chunks: [meta],
    rows: rows.map((r) => ({ _chunk: 'WS-2026-11-18.json', ...r })) }));
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('--chunk-days must be a positive integer', () => withRaw((file) => {
  for (const d of ['0', '-7', '1.5', 'x']) {
    const r = run('--games', 'WS', `--chunk-days=${d}`, '--from-raw', file);
    assert.equal(r.status, 1, d);
    assert.match(r.stderr, /--chunk-days must be a positive integer/);
  }
}));

test('--from-raw refuses a capture that does not cover the requested window', () => withRaw((file) => {
  const r = run('--games', 'WS', '--from-raw', file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not match the requested window/);
  assert.match(r.stderr, /missing WS 2026-11-25\.\.2026-12-01/);
}));

test('--from-raw refuses a capture without the current coverage version', () => withRaw((file) => {
  const r = run('--games', 'WS', '--from', '2026-11-18', '--until', '2026-11-25', '--from-raw', file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /coverage version none/);
}, { coverage: null }));

test('--from-raw replays a covering capture into the dry-run output', () => {
  const fetchedAt = '2000-01-02T03:04:05Z';
  const outDir = mkdtempSync(join(tmpdir(), 'bushi-out-'));
  try {
    withRaw((file) => {
      const r = run('--games', 'WS', '--from', '2026-11-18', '--until', '2026-11-25', '--from-raw', file, '--out', outDir);
      assert.equal(r.status, 0, r.stderr);
    }, { rows: wsRows, fetchedAt });
    const runFile = JSON.parse(readFileSync(join(outDir, 'WS', '_run.json'), 'utf8'));
    const events = JSON.parse(readFileSync(join(outDir, 'WS', '2026-11.json'), 'utf8'));
    assert.equal(wsRows.length, 4);
    assert.equal(runFile.record_count, 4);
    assert.deepEqual(runFile.window, { from: '2026-11-18', until: '2026-11-25' });
    assert.deepEqual(events.map((e) => e.id).sort(), wsRows.map((row) => `bnavi:${row.id}`).sort());
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

const WEEK = ['--games', 'WS', '--from', '2026-11-18', '--until', '2026-11-25', '--max-requests', '0'];
const weekChunk = { game: 'WS', gameTitleId: 2, startDate: '2026-11-18', endDate: '2026-11-24' };

// A run directory as an interrupted run leaves it: state.json plus the given saved chunk for WS 2026-11-18.
function withRunDir(fn, saved) {
  const dir = mkdtempSync(join(tmpdir(), 'bushi-run-'));
  mkdirSync(join(dir, 'chunks'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ fetchedAt: '2000-01-03T00:00:00Z', from: '2026-11-18', until: '2026-11-25', games: ['WS'], days: 7, requests: 1 }));
  writeFileSync(join(dir, 'chunks', 'WS-2026-11-18.json'), JSON.stringify(saved));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const savedChunk = (chunk = weekChunk, extra = {}) => ({
  coverage: COVERAGE_VERSION, chunk, query: listPath({ ...chunk, offset: 0 }), total: 0, pages: 1, rows: wsRows, ...extra,
});

test('--resume reuses a checkpoint whose chunk descriptor matches the plan', () => withRunDir((dir) => {
  const r = run(...WEEK, '--resume', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'WS', '_run.json'), 'utf8')).record_count, 4);
}, savedChunk()));

test('--resume refetches a checkpoint saved for a different chunk', () => {
  const shorter = { ...weekChunk, endDate: '2026-11-20' };
  for (const saved of [savedChunk(shorter, { query: listPath({ ...weekChunk, offset: 0 }) }), savedChunk(weekChunk, { query: undefined }),
    savedChunk(weekChunk, { query: listPath({ ...weekChunk, offset: 0, limit: 50 }) })]) {
    withRunDir((dir) => {
      const r = run(...WEEK, '--resume', dir);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /refetch WS-2026-11-18\.json/);
      assert.match(r.stderr, /request budget 0 exhausted/);
    }, saved);
  }
});

test('--resume refuses a run with legacy checkpoints instead of refetching under the old fetched_at', () => {
  for (const coverage of [undefined, COVERAGE_VERSION - 1]) {
    withRunDir((dir) => {
      const r = run(...WEEK, '--resume', dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /older collector/);
      assert.match(r.stderr, /Start a fresh run/);
      assert.doesNotMatch(r.stdout, /refetch/);
    }, savedChunk(weekChunk, { coverage }));
  }
});

test('fresh runs started in the same second get separate run directories', () => {
  const dirs = [run(...WEEK), run(...WEEK)].map((r) => {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /request budget 0 exhausted/);
    return r.stderr.match(/--resume (\S+)/)[1];
  });
  try {
    assert.notEqual(dirs[0], dirs[1]);
    for (const d of dirs) assert.ok(existsSync(join(d, 'state.json')));
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});
