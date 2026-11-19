import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEvent } from '../lib/normalize.mjs';
import { addressChanged, applyGeo, detailPath, geoPass, tokyoDate, venueLookups } from '../lib/geo.mjs';
import { loadCache, saveCache, setEntry } from '../../lib/venue-cache.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'event-search-rows.json'), 'utf8'));
const base = { ...fixture[0], venue: '', trainers_flg: 1, discontinuance_flg: 0 };
const row = (o) => ({ ...base, ...o });
const pair = (r) => ({ event: normalizeEvent(r, '2026-11-19T00:00:00Z'), row: r });
const TODAY = '2026-11-19';

// shop 1 has two events, shop 2 one, and one event at its own venue (no shop source_id).
const rows = [
  row({ event_holding_id: 1, shop_id: 1, date_id: 11, event_date_params: '20261121' }),
  row({ event_holding_id: 2, shop_id: 1, date_id: 12, event_date_params: '20261120', discontinuance_flg: 1 }),
  row({ event_holding_id: 3, shop_id: 2, date_id: 13 }),
  row({ event_holding_id: 4, shop_id: 1, date_id: 14, venue: '市民会館 大ホール', address: '東京都千代田区1-1' }),
];
const pairs = rows.map(pair);

function fakeDetail(answers) {
  const calls = [];
  const fetchJson = async (path) => {
    calls.push(path);
    const id = new URLSearchParams(path.split('?')[1]).get('event_holding_id');
    const a = answers[id];
    if (a instanceof Error) throw a;
    return a ?? { code: 404, message: 'イベント情報が存在しません。' };
  };
  return { fetchJson, calls };
}
const ok = (geocoding) => ({ code: 200, event: { geocoding } });

test('detailPath sends the five route values, 0 for missing ones', () => {
  assert.equal(detailPath(row({ event_holding_id: 9, trainers_flg: 0, shop_id: 7, event_date_params: '20261201', date_id: null })),
    '/event_detail_search?event_holding_id=9&trainers_flg=0&shop_id=7&event_date=20261201&date_id=0');
});

test('tokyoDate is the Asia/Tokyo calendar day', () => {
  assert.equal(tokyoDate(new Date('2026-11-18T15:30:00Z')), '2026-11-19');
});

test('one lookup per shop and per own venue; non-cancelled rows first', () => {
  const l = venueLookups(pairs);
  assert.deepEqual(l.map((x) => x.key).sort(), ['id:1', 'id:2', l.find((x) => x.key.startsWith('fp:')).key].sort());
  assert.deepEqual(l.find((x) => x.key === 'id:1').rows.map((r) => r.event_holding_id), [1, 2]);
});

test('geoPass caches found and negative results, then applyGeo sets venue.geo on every venue', async () => {
  const cache = { version: 1, source: 'ptcg', entries: {} };
  const fp = venueLookups(pairs).find((x) => x.key.startsWith('fp:')).key;
  const api = fakeDetail({ 1: ok('35.6866876,139.9868041'), 3: ok(''), 4: ok('34.1,135.2') });
  let saves = 0;
  const stats = await geoPass({ fetchJson: api.fetchJson, cache, lookups: venueLookups(pairs), today: TODAY, save: () => { saves += 1; } });
  assert.equal(api.calls.length, 3);
  assert.deepEqual([stats.found, stats.negative, stats.errors], [2, 1, 0]);
  assert.ok(saves >= 1);
  assert.deepEqual(cache.entries['id:1'].geo, { lat: 35.686688, lng: 139.986804, source: 'ptcg', precision: null, place_id: null, geocoded_at: null });
  assert.equal(cache.entries['id:2'].geo, null);
  assert.equal(cache.entries[fp].geo.lat, 34.1);

  const events = pairs.map((p) => structuredClone(p.event));
  assert.deepEqual(applyGeo(events, cache, TODAY), { events_with_venue: 4, events_with_geo: 3 });
  assert.equal(events[2].venue.geo, null);
  assert.ok(Object.hasOwn(events[2].venue, 'geo'));

  // Second run: everything cached (negative entries wait 30 days), so no requests.
  const again = fakeDetail({});
  const s2 = await geoPass({ fetchJson: again.fetchJson, cache, lookups: venueLookups(pairs), today: TODAY, save: () => {} });
  assert.equal(again.calls.length, 0);
  assert.equal(s2.todo, 0);
});

test('404 tries the next candidate row; a transport error leaves no entry', async () => {
  const cache = { version: 1, source: 'ptcg', entries: {} };
  const api = fakeDetail({ 2: ok('35,139'), 3: new Error('HTTP 403'), 4: ok('34,135') });
  const stats = await geoPass({ fetchJson: api.fetchJson, cache, lookups: venueLookups(pairs), today: TODAY, save: () => {} });
  assert.equal(cache.entries['id:1'].geo.lat, 35);
  assert.equal(cache.entries['id:2'], undefined);
  assert.deepEqual([stats.found, stats.errors, stats.stopped], [2, 1, null]);
});

test('consecutive transport errors stop the pass', async () => {
  const cache = { version: 1, source: 'ptcg', entries: {} };
  const err = new Error('HTTP 403');
  const api = fakeDetail({ 1: err, 3: err, 4: err });
  const stats = await geoPass({ fetchJson: api.fetchJson, cache, lookups: venueLookups(pairs), today: TODAY, save: () => {}, maxConsecutiveErrors: 2 });
  assert.equal(api.calls.length, 2);
  assert.match(stats.stopped, /consecutive/);
  assert.deepEqual(cache.entries, {});
});

test('budget stops the pass and the cache file resumes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptcg-geo-'));
  const cache = loadCache(dir, 'ptcg');
  const api = fakeDetail({ 1: ok('35,139'), 3: ok('36,140'), 4: ok('34,135') });
  const save = () => saveCache(dir, cache);
  const s1 = await geoPass({ fetchJson: api.fetchJson, cache, lookups: venueLookups(pairs), today: TODAY, save, maxRequests: 1 });
  assert.match(s1.stopped, /budget/);
  const resumed = loadCache(dir, 'ptcg');
  assert.equal(Object.keys(resumed.entries).length, 1);
  const s2 = await geoPass({ fetchJson: api.fetchJson, cache: resumed, lookups: venueLookups(pairs), today: TODAY, save: () => saveCache(dir, resumed) });
  assert.equal(s2.todo, 2);
  assert.equal(Object.keys(loadCache(dir, 'ptcg').entries).length, 3);
});

test('a stale negative entry is looked up again', async () => {
  const cache = { version: 1, source: 'ptcg', entries: {} };
  setEntry(cache, pairs[2].event.venue, null, '2026-09-01');
  const api = fakeDetail({ 3: ok('35,139') });
  const lookups = venueLookups([pairs[2]]);
  await geoPass({ fetchJson: api.fetchJson, cache, lookups, today: TODAY, save: () => {} });
  assert.equal(cache.entries['id:2'].geo.lng, 139);
});

test('an entry cached for another address is looked up again and not applied meanwhile', async () => {
  const venue = pairs[2].event.venue;
  const cache = { version: 1, source: 'ptcg', entries: {} };
  setEntry(cache, { ...venue, address: '大阪府大阪市北区1-1' }, { lat: 34.7, lng: 135.5, source: 'ptcg' }, TODAY);
  assert.equal(addressChanged(cache.entries['id:2'], venue), true);
  const events = [structuredClone(pairs[2].event)];
  applyGeo(events, cache, TODAY);
  assert.equal(events[0].venue.geo, null);
  const api = fakeDetail({ 3: ok('35,139') });
  const stats = await geoPass({ fetchJson: api.fetchJson, cache, lookups: venueLookups([pairs[2]]), today: TODAY, save: () => {} });
  assert.equal(stats.todo, 1);
  assert.equal(cache.entries['id:2'].geo.lng, 139);
  assert.equal(cache.entries['id:2'].address, venue.address);
});

test('address comparison ignores width and whitespace differences', () => {
  assert.equal(addressChanged({ address: '東京都千代田区１－１　ビル' }, { address: '東京都千代田区1-1 ビル' }), false);
  assert.equal(addressChanged({ address: null }, { address: null }), false);
  assert.equal(addressChanged(undefined, { address: 'x' }), false);
});
