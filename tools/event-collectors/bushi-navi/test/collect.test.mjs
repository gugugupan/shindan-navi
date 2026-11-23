import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunks, collectChunk, CoverageError, flattenGroups, listPath, PAGE_SIZE, rawCoverageGaps, tokyoDay } from '../lib/collect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Recorded list response (2026-11-19); phone numbers, notes and excerpts are replaced by fake values.
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'event-list.json'), 'utf8')).success;
const wsGroup = fixture.organizer_event_series.find((g) => g.game_title_id === 2);

// `n` WS groups with one event each on 2026-11-21 (JST), cloned from a recorded group.
const groupsOf = (n, day = '2026-11-21T03:00:00+00:00') => Array.from({ length: n }, (_, i) => ({
  ...wsGroup, organizer_id: 50000 + i,
  events: [{ ...wsGroup.events[0], id: 9000000 + i, organizer_id: 50000 + i, start_datetime: day }],
}));

function fakeApi(groups, { totalAt = () => groups.length } = {}) {
  const calls = [];
  const fetchJson = async (path) => {
    calls.push(path);
    const q = new URLSearchParams(path.split('?')[1]);
    const offset = Number(q.get('offset'));
    return { success: { code: 200, organizer_event_series: groups.slice(offset, offset + PAGE_SIZE), total: totalAt(offset) } };
  };
  return { fetchJson, calls };
}

const chunk = { gameTitleId: 2, startDate: '2026-11-19', endDate: '2026-11-25' };

test('listPath uses the site parameter names', () => {
  assert.equal(listPath({ gameTitleId: 2, startDate: '2026-11-19', endDate: '2026-11-25', offset: 100 }),
    '/api/user/event/list?game_title_id%5B%5D=2&start_date=2026-11-19&end_date=2026-11-25&limit=100&offset=100');
});

test('chunks split a half-open window into inclusive week ranges', () => {
  const c = chunks('2026-11-18', '2027-02-18', 7);
  assert.equal(c.length, 14);
  assert.deepEqual(c[0], { startDate: '2026-11-18', endDate: '2026-11-24' });
  assert.deepEqual(c.at(-1), { startDate: '2027-02-17', endDate: '2027-02-17' });
});

test('chunks rejects a chunk size that is not a positive integer', () => {
  for (const d of [0, -7, 1.5, Number.NaN]) assert.throws(() => chunks('2026-11-18', '2027-02-18', d), RangeError, String(d));
});

test('rawCoverageGaps accepts the saved plan and lists missing or unrequested chunks', () => {
  const plan = (from, until, games = ['WS']) => games.flatMap((game) => chunks(from, until, 7).map((c) => ({ game, ...c })));
  const saved = plan('2026-11-18', '2026-11-25', ['WS', 'VG']);
  assert.deepEqual(rawCoverageGaps(plan('2026-11-18', '2026-11-25'), saved), []);
  assert.deepEqual(rawCoverageGaps(plan('2026-11-18', '2026-12-02'), saved), ['missing WS 2026-11-25..2026-12-01']);
  assert.deepEqual(rawCoverageGaps(plan('2026-11-18', '2026-11-25', ['WS', 'DM']), saved), ['missing DM 2026-11-18..2026-11-24']);
  assert.deepEqual(rawCoverageGaps(plan('2026-11-19', '2026-11-25'), saved),
    ['missing WS 2026-11-19..2026-11-24', 'not requested WS 2026-11-18..2026-11-24']);
});

test('tokyoDay converts UTC instants to the Japanese date', () => {
  assert.equal(tokyoDay('2026-11-21T15:00:00+00:00'), '2026-11-22');
  assert.equal(tokyoDay('2026-11-21T14:59:00+00:00'), '2026-11-21');
});

test('flattenGroups keeps whitelisted fields only: no phone numbers, notes or excerpts', () => {
  const rows = flattenGroups(fixture.organizer_event_series);
  assert.equal(rows.length, 6);
  const dump = JSON.stringify(rows);
  for (const leak of ['0300000000', 'organizer_phone_number', 'organizer_game_title_notes', 'TEL', 'excerpt', 'example.com']) {
    assert.ok(!dump.includes(leak), leak);
  }
  assert.equal(rows[0].group.organizer_name, fixture.organizer_event_series[0].organizer_name);
});

test('collectChunk pages until total and proves distinct groups == total', async () => {
  const api = fakeApi(groupsOf(230));
  const r = await collectChunk(api.fetchJson, chunk);
  assert.equal(r.total, 230);
  assert.equal(r.pages, 3);
  assert.equal(r.rows.length, 230);
  assert.deepEqual(api.calls.map((p) => new URLSearchParams(p.split('?')[1]).get('offset')), ['0', '100', '200']);
});

test('collectChunk handles an empty chunk with one request', async () => {
  const api = fakeApi([]);
  const r = await collectChunk(api.fetchJson, chunk);
  assert.deepEqual([r.total, r.pages, r.rows.length], [0, 1, 0]);
});

test('collectChunk fails when the total moves mid-pagination', async () => {
  const api = fakeApi(groupsOf(150), { totalAt: (o) => (o === 0 ? 150 : 151) });
  await assert.rejects(collectChunk(api.fetchJson, chunk), (e) => e instanceof CoverageError && /total changed/.test(e.message));
});

test('collectChunk fails when pages repeat groups (distinct groups < total)', async () => {
  const groups = groupsOf(150);
  const api = fakeApi([...groups.slice(0, 100), ...groups.slice(0, 50)], { totalAt: () => 150 });
  await assert.rejects(collectChunk(api.fetchJson, chunk), /distinct series groups/);
});

test('collectChunk fails on an event dated outside the chunk (Asia/Tokyo)', async () => {
  // 2026-11-25T15:30Z is 2026-11-26 00:30 in Japan.
  const api = fakeApi(groupsOf(1, '2026-11-25T15:30:00+00:00'));
  await assert.rejects(collectChunk(api.fetchJson, chunk), /outside the chunk/);
});

test('collectChunk rejects a group without an events array', async () => {
  for (const events of [undefined, null, {}]) {
    const groups = groupsOf(2);
    groups[1] = { ...groups[1], events };
    if (events === undefined) delete groups[1].events;
    await assert.rejects(collectChunk(fakeApi(groups).fetchJson, chunk), (e) => e instanceof CoverageError && /no events array/.test(e.message));
  }
});

test('collectChunk rejects another game and unexpected bodies', async () => {
  const other = groupsOf(1).map((g) => ({ ...g, game_title_id: 6 }));
  await assert.rejects(collectChunk(fakeApi(other).fetchJson, chunk), /has game 6/);
  await assert.rejects(collectChunk(async () => ({ error: { code: 400 } }), chunk), /unexpected body shape/);
});
