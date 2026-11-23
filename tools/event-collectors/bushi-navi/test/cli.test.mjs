import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_VERSION, flattenGroups } from '../lib/collect.mjs';

// Every run is --from-raw --dry-run: no request is made and data/events is never written.
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
  const outDir = join(here, '..', 'out', `run-${fetchedAt.replace(/:/g, '-')}`);
  try {
    withRaw((file) => {
      const r = run('--games', 'WS', '--from', '2026-11-18', '--until', '2026-11-25', '--from-raw', file);
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
