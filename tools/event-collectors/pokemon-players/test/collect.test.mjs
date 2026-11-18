import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunks, collectChunk, CoverageError, NO_EVENTS, PAGE_SIZE, searchUrl } from '../lib/collect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'event-search-rows.json'), 'utf8'));

// 45 synthetic rows on one day, cloned from a recorded row with distinct ids.
const day = { startDate: '2026-11-21', endDate: '2026-11-21' };
const rows = Array.from({ length: 45 }, (_, i) => ({ ...fixture[0], event_holding_id: 9000000 + i, date_id: 8000000 + i, event_date_params: '20261121' }));

function fakeApi(list, { countAt = () => list.length, overridePage } = {}) {
  const calls = [];
  const fetchJson = async (path) => {
    calls.push(path);
    const offset = Number(new URLSearchParams(path.split('?')[1]).get('offset'));
    if (overridePage) {
      const o = overridePage(offset);
      if (o) return o;
    }
    if (list.length === 0) return { code: 404, message: NO_EVENTS };
    return { code: 200, event: list.slice(offset, offset + PAGE_SIZE), eventCount: countAt(offset) };
  };
  return { fetchJson, calls };
}

test('searchUrl uses the site parameter names and slashed dates', () => {
  assert.equal(searchUrl({ startDate: '2026-11-18', endDate: '2026-11-18', offset: 40 }),
    '/event_search?offset=40&order=1&start_date=2026%2F11%2F18&end_date=2026%2F11%2F18');
});

test('chunks split a half-open window into inclusive day ranges', () => {
  assert.deepEqual(chunks('2026-11-30', '2026-12-02', 1), [
    { startDate: '2026-11-30', endDate: '2026-11-30' },
    { startDate: '2026-12-01', endDate: '2026-12-01' },
  ]);
  assert.deepEqual(chunks('2026-11-18', '2027-02-18', 7).at(-1), { startDate: '2027-02-17', endDate: '2027-02-17' });
  assert.equal(chunks('2026-11-18', '2027-02-18', 1).length, 92);
});

test('pages until eventCount and proves distinct ids', async () => {
  const api = fakeApi(rows);
  const r = await collectChunk(api.fetchJson, day);
  assert.equal(r.total, 45);
  assert.equal(r.rows.length, 45);
  assert.equal(api.calls.length, 3);
});

test('empty day answers 404 + message and counts as zero', async () => {
  const r = await collectChunk(fakeApi([]).fetchJson, day);
  assert.equal(r.total, 0);
  assert.deepEqual(r.rows, []);
});

test('fails when eventCount moves mid-pagination', async () => {
  const api = fakeApi(rows, { countAt: (o) => (o === 0 ? 45 : 46) });
  await assert.rejects(collectChunk(api.fetchJson, day), CoverageError);
});

test('fails when a page repeats rows (unstable order)', async () => {
  const api = fakeApi(rows, { overridePage: (o) => (o === 20 ? { code: 200, event: rows.slice(0, 20), eventCount: 45 } : null) });
  await assert.rejects(collectChunk(api.fetchJson, day), /distinct ids != eventCount/);
});

test('fails on a row outside the requested day', async () => {
  const stray = [...rows.slice(0, 44), { ...rows[44], event_date_params: '20261122' }];
  await assert.rejects(collectChunk(fakeApi(stray).fetchJson, day), /outside/);
});

test('fails on unexpected body and on 404 after the first page', async () => {
  await assert.rejects(collectChunk(async () => ({ code: 500 }), day), CoverageError);
  const api = fakeApi(rows, { overridePage: (o) => (o === 40 ? { code: 404, message: NO_EVENTS } : null) });
  await assert.rejects(collectChunk(api.fetchJson, day), CoverageError);
});

test('page budget is enforced', async () => {
  await assert.rejects(collectChunk(fakeApi(rows).fetchJson, day, { maxPages: 2 }), /budget/);
});
