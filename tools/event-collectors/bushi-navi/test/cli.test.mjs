import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only refusal paths run here: each exits before any request or write. --dry-run is a second guard.
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'collect.mjs');
const run = (...args) => spawnSync(process.execPath, [script, '--dry-run', ...args], { encoding: 'utf8', timeout: 10_000 });

function oneWeekRaw() {
  const dir = mkdtempSync(join(tmpdir(), 'bushi-raw-'));
  const file = join(dir, 'raw.json');
  const chunk = { game: 'WS', gameTitleId: 2, startDate: '2026-11-18', endDate: '2026-11-24' };
  writeFileSync(file, JSON.stringify({ fetchedAt: '2026-11-18T00:00:00Z', requests: 1, plan: [chunk], chunks: [{ chunk, total: 0, pages: 1 }], rows: [] }));
  return { dir, file };
}

test('--chunk-days must be a positive integer', () => {
  const { dir, file } = oneWeekRaw();
  try {
    for (const d of ['0', '-7', '1.5', 'x']) {
      const r = run('--games', 'WS', `--chunk-days=${d}`, '--from-raw', file);
      assert.equal(r.status, 1, d);
      assert.match(r.stderr, /--chunk-days must be a positive integer/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--from-raw refuses a capture that does not cover the requested window', () => {
  const { dir, file } = oneWeekRaw();
  try {
    const r = run('--games', 'WS', '--from-raw', file);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match the requested window/);
    assert.match(r.stderr, /missing WS 2026-11-25\.\.2026-12-01/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
