import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_VERSION, flattenGroups, listPath } from '../lib/collect.mjs';

// Every run is --dry-run, and either --from-raw or --max-requests 0: no request is made and data/events is never written.
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'collect.mjs');
const outRoot = join(here, '..', 'out');
const spawn = (nodeArgs, args) => spawnSync(process.execPath, [...nodeArgs, script, '--dry-run', ...args], { encoding: 'utf8', timeout: 10_000 });
const run = (...args) => spawn([], args);
// A random second, so concurrent test runs never share a run directory.
const randomStamp = () => new Date(Date.UTC(2000, 0, 1) + Math.floor(Math.random() * 3e9) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const runDirOf = (fetchedAt) => join(outRoot, `run-${fetchedAt.replace(/:/g, '-')}`);
// Deletes only a run-* directory directly under the collector's out/.
function removeRunDir(dir) {
  assert.equal(dirname(dir), outRoot, dir);
  assert.match(basename(dir), /^run-/);
  rmSync(dir, { recursive: true, force: true });
}
const dryRunDir = (r) => r.stdout.match(/dry run: data\/events not touched; see (.+)$/m)?.[1];

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
  const fetchedAt = randomStamp();
  let outDir;
  try {
    withRaw((file) => {
      const r = run('--games', 'WS', '--from', '2026-11-18', '--until', '2026-11-25', '--from-raw', file);
      assert.equal(r.status, 0, r.stderr);
      outDir = dryRunDir(r);
    }, { rows: wsRows, fetchedAt });
    assert.equal(outDir, runDirOf(fetchedAt));
    const runFile = JSON.parse(readFileSync(join(outDir, 'WS', '_run.json'), 'utf8'));
    const events = JSON.parse(readFileSync(join(outDir, 'WS', '2026-11.json'), 'utf8'));
    assert.equal(wsRows.length, 4);
    assert.equal(runFile.record_count, 4);
    assert.deepEqual(runFile.window, { from: '2026-11-18', until: '2026-11-25' });
    assert.deepEqual(events.map((e) => e.id).sort(), wsRows.map((row) => `bnavi:${row.id}`).sort());
  } finally {
    if (outDir) removeRunDir(outDir);
  }
});

const WEEK = ['--games', 'WS', '--from', '2026-11-18', '--until', '2026-11-25', '--max-requests', '0'];
const weekChunk = { game: 'WS', gameTitleId: 2, startDate: '2026-11-18', endDate: '2026-11-24' };

// A run directory as an interrupted run leaves it: state.json plus the given saved chunk for WS 2026-11-18.
function withRunDir(fn, saved) {
  const dir = mkdtempSync(join(tmpdir(), 'bushi-run-'));
  const fetchedAt = randomStamp();
  mkdirSync(join(dir, 'chunks'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ fetchedAt, from: '2026-11-18', until: '2026-11-25', games: ['WS'], days: 7, requests: 1 }));
  writeFileSync(join(dir, 'chunks', 'WS-2026-11-18.json'), JSON.stringify(saved));
  try {
    fn(dir, fetchedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const savedChunk = (chunk = weekChunk, extra = {}) => ({
  coverage: COVERAGE_VERSION, chunk, query: listPath({ ...chunk, offset: 0 }), total: 0, pages: 1, rows: wsRows, ...extra,
});

test('--resume reuses a checkpoint whose chunk descriptor matches the plan', () => withRunDir((dir, fetchedAt) => {
  const r = run(...WEEK, '--resume', dir);
  const outDir = dryRunDir(r);
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(outDir, runDirOf(fetchedAt));
    assert.equal(JSON.parse(readFileSync(join(outDir, 'WS', '_run.json'), 'utf8')).record_count, 4);
  } finally {
    if (outDir) removeRunDir(outDir);
  }
}, savedChunk()));

test('--resume refetches a checkpoint saved for a different chunk', () => {
  const shorter = { ...weekChunk, endDate: '2026-11-20' };
  for (const saved of [savedChunk(shorter, { query: listPath({ ...weekChunk, offset: 0 }) }),
    savedChunk(weekChunk, { query: listPath({ ...weekChunk, offset: 0, limit: 50 }) })]) {
    withRunDir((dir) => {
      const r = run(...WEEK, '--resume', dir);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /refetch WS-2026-11-18\.json/);
      assert.match(r.stderr, /request budget 0 exhausted/);
    }, saved);
  }
});

test('--resume refuses a run with legacy or pre-query checkpoints instead of refetching under the old fetched_at', () => {
  for (const extra of [{ coverage: undefined }, { coverage: COVERAGE_VERSION - 1 }, { query: undefined }]) {
    withRunDir((dir) => {
      const r = run(...WEEK, '--resume', dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /older collector/);
      assert.match(r.stderr, /Start a fresh run/);
      assert.doesNotMatch(r.stdout, /refetch/);
      assert.doesNotMatch(r.stderr, /request budget/);
    }, savedChunk(weekChunk, extra));
  }
});

test('a second fresh run in the same second fails before any fetch', () => {
  const fetchedAt = randomStamp();
  const dir = runDirOf(fetchedAt);
  assert.ok(!existsSync(dir), dir);
  // pins the clock of the collector process to `fetchedAt`
  const pin = `data:text/javascript,${encodeURIComponent(`const D = Date; const t = D.parse(${JSON.stringify(fetchedAt)});
globalThis.Date = class extends D { constructor(...a) { if (a.length) super(...a); else super(t); } static now() { return t; } };`)}`;
  try {
    const first = spawn(['--import', pin], WEEK);
    assert.equal(first.status, 1);
    assert.match(first.stderr, /request budget 0 exhausted/);
    assert.equal(first.stderr.match(/--resume (.+)$/m)?.[1], dir);
    assert.ok(existsSync(join(dir, 'state.json')));
    const second = spawn(['--import', pin], WEEK);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /another run started this second; retry/);
    assert.doesNotMatch(second.stderr, /request budget/);
  } finally {
    if (existsSync(dir)) removeRunDir(dir);
  }
});
