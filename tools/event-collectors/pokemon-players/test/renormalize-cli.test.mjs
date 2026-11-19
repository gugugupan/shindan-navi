import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEvent, sortEvents } from '../lib/normalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'renormalize-venues.mjs');
const rows = JSON.parse(readFileSync(join(here, 'fixtures', 'event-search-rows.json'), 'utf8'));
const FETCHED = '2026-11-18T00:00:00Z';

// A data dir as the previous collector wrote it: free-text 会場 as the name of a shop event (1186915).
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ptcg-renorm-'));
  const data = join(root, 'events');
  mkdirSync(join(data, 'PTCG'), { recursive: true });
  const events = sortEvents(rows.map((r) => normalizeEvent(r, FETCHED)));
  for (const e of events) e.venue.geo = null;
  const seats = events.find((e) => e.id === 'ptcg:1186915');
  seats.venue.name = '対戦スペース 32席';
  writeFileSync(join(data, 'PTCG', '2026-11.json'), `${JSON.stringify(events, null, 2)}\n`);
  const run = {
    game_code: 'PTCG', source_code: 'pokemon_players', fetched_at: FETCHED,
    window: { from: '2026-11-18', until: '2027-02-18' }, query: {}, source_total: events.length,
    record_count: events.length, complete: true, collector_version: 'test', notes: [],
  };
  writeFileSync(join(data, 'PTCG', '_run.json'), `${JSON.stringify(run, null, 2)}\n`);
  const raw = join(root, 'raw.json');
  writeFileSync(raw, JSON.stringify({ fetchedAt: FETCHED, rows }));
  return { root, data, raw };
}
const run = (args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const read = (data, f) => readFileSync(join(data, 'PTCG', f), 'utf8');

test('cli refuses a raw file from another run', () => {
  const { root, data, raw } = setup();
  writeFileSync(raw, JSON.stringify({ fetchedAt: '2026-11-17T00:00:00Z', rows }));
  assert.throws(() => run(['--data', data, '--raw', raw, '--write']), /use the raw\.json of the run/);
  rmSync(root, { recursive: true });
});

test('cli reports without --write, writes with it, and a second run is a no-op', () => {
  const { root, data, raw } = setup();
  const before = read(data, '2026-11.json');
  assert.match(run(['--data', data, '--raw', raw]), /events renamed: 1 /);
  assert.equal(read(data, '2026-11.json'), before);
  run(['--data', data, '--raw', raw, '--write']);
  const seats = JSON.parse(read(data, '2026-11.json')).find((e) => e.id === 'ptcg:1186915');
  assert.equal(seats.venue.name, rows.find((r) => r.event_holding_id === 1186915).shop_name);
  assert.equal(JSON.parse(read(data, '_run.json')).notes.length, 1);
  const stamp = (f) => statSync(f).mtimeMs;
  const files = [join(data, 'PTCG', '2026-11.json'), join(data, 'PTCG', '_run.json'), join(data, '.venues', 'ptcg.json')];
  const t = files.map(stamp);
  assert.match(run(['--data', data, '--raw', raw, '--write']), /nothing to change/);
  assert.deepEqual(files.map(stamp), t);
  rmSync(root, { recursive: true });
});
