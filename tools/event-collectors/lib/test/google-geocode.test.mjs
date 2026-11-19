import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GeocodeAbort, geocodeVenue, geocodeVenues, loadApiKey, tokyoDate } from '../google-geocode.mjs';
import { getEntry, loadCache, saveCache, setEntry } from '../venue-cache.mjs';

const KEY = 'test-key';
const TODAY = '2026-11-19';
const venue = { name: 'カードショップA', address: '東京都新宿区西新宿1-1-1', region_code: 'JP-13', source_id: null };

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const geocodeResult = (type, extra = {}) => ({
  status: 'OK',
  results: [{ geometry: { location: { lat: 35.6909214, lng: 139.7002583 }, location_type: type }, place_id: 'gid', types: ['premise'], ...extra }],
});

/** Stub fetch: routes by host, records calls. */
function stub({ geocode = [], places = [] }) {
  const calls = [];
  const queues = { geocode: [...geocode], places: [...places] };
  const fn = async (url, init) => {
    const kind = String(url).startsWith('https://places.googleapis.com/') ? 'places' : 'geocode';
    calls.push({ kind, url: String(url), init });
    const next = queues[kind].shift();
    if (!next) throw new Error(`unexpected ${kind} call`);
    return next;
  };
  fn.calls = calls;
  return fn;
}

test('ROOFTOP geocoding result is used directly, with region/language params', async () => {
  const fetch = stub({ geocode: [json(geocodeResult('ROOFTOP'))] });
  const g = await geocodeVenue(venue, { key: KEY, today: TODAY, fetch });
  assert.deepEqual(g, { lat: 35.690921, lng: 139.700258, source: 'google', precision: 'ROOFTOP', place_id: 'gid', geocoded_at: TODAY });
  const u = new URL(fetch.calls[0].url);
  assert.equal(u.searchParams.get('region'), 'jp');
  assert.equal(u.searchParams.get('language'), 'ja');
  assert.equal(u.searchParams.get('address'), venue.address);
  assert.equal(fetch.calls.length, 1);
});

test('imprecise geocoding falls back to Places Text Search with name + address', async () => {
  const fetch = stub({
    geocode: [json(geocodeResult('APPROXIMATE'))],
    places: [json({ places: [{ id: 'pid', location: { latitude: 35.1, longitude: 139.2 }, formattedAddress: '日本、〒160-0023 東京都新宿区西新宿1丁目1-1' }] })],
  });
  const g = await geocodeVenue(venue, { key: KEY, today: TODAY, fetch });
  assert.deepEqual(g, { lat: 35.1, lng: 139.2, source: 'google', precision: 'PLACES_TEXT_SEARCH', place_id: 'pid', geocoded_at: TODAY });
  const p = fetch.calls[1];
  assert.equal(p.init.method, 'POST');
  assert.equal(p.init.headers['X-Goog-Api-Key'], KEY);
  assert.deepEqual(JSON.parse(p.init.body).textQuery, `${venue.name} ${venue.address}`);
  assert.equal(JSON.parse(p.init.body).regionCode, 'JP');
  assert.match(p.init.headers['X-Goog-FieldMask'], /places\.formattedAddress/);
});

const place = (lat, lng, formattedAddress) => json({ places: [{ id: 'pid', location: { latitude: lat, longitude: lng }, formattedAddress }] });

test('Places result in another prefecture, or without an address, is rejected', async () => {
  let fetch = stub({ geocode: [json(geocodeResult('APPROXIMATE'))], places: [place(34.7, 135.5, '日本、大阪府大阪市北区1-1')] });
  assert.equal(await geocodeVenue(venue, { key: KEY, today: TODAY, fetch }), null);
  fetch = stub({ geocode: [json(geocodeResult('APPROXIMATE'))], places: [place(35.69, 139.7, undefined)] });
  assert.equal(await geocodeVenue(venue, { key: KEY, today: TODAY, fetch }), null);
  // No region_code: nothing to compare the address with.
  fetch = stub({ geocode: [json(geocodeResult('APPROXIMATE'))], places: [place(34.7, 135.5, undefined)] });
  assert.equal((await geocodeVenue({ ...venue, region_code: null }, { key: KEY, today: TODAY, fetch })).place_id, 'pid');
});

test('Places result far from the GEOMETRIC_CENTER geocode loses to it; a near one wins', async () => {
  // geocodeResult is at 35.690921,139.700258; 35.75 is ~6.6 km north, 35.70 ~1 km.
  let fetch = stub({ geocode: [json(geocodeResult('GEOMETRIC_CENTER'))], places: [place(35.75, 139.700258, '東京都豊島区')] });
  assert.equal((await geocodeVenue(venue, { key: KEY, today: TODAY, fetch })).precision, 'GEOMETRIC_CENTER');
  fetch = stub({ geocode: [json(geocodeResult('GEOMETRIC_CENTER'))], places: [place(35.70, 139.700258, '東京都新宿区')] });
  assert.equal((await geocodeVenue(venue, { key: KEY, today: TODAY, fetch })).precision, 'PLACES_TEXT_SEARCH');
});

test('Places miss: GEOMETRIC_CENTER is kept as fallback, APPROXIMATE and area results are not', async () => {
  let fetch = stub({ geocode: [json(geocodeResult('GEOMETRIC_CENTER'))], places: [json({})] });
  assert.equal((await geocodeVenue(venue, { key: KEY, today: TODAY, fetch })).precision, 'GEOMETRIC_CENTER');
  fetch = stub({ geocode: [json(geocodeResult('GEOMETRIC_CENTER', { partial_match: true }))], places: [json({})] });
  assert.equal(await geocodeVenue(venue, { key: KEY, today: TODAY, fetch }), null);
  fetch = stub({ geocode: [json(geocodeResult('APPROXIMATE'))], places: [json({ places: [] })] });
  assert.equal(await geocodeVenue(venue, { key: KEY, today: TODAY, fetch }), null);
  fetch = stub({ geocode: [json(geocodeResult('ROOFTOP', { types: ['locality', 'political'] }))], places: [json({})] });
  assert.equal(await geocodeVenue(venue, { key: KEY, today: TODAY, fetch }), null);
  fetch = stub({ geocode: [json({ status: 'ZERO_RESULTS', results: [] })], places: [json({})] });
  assert.equal(await geocodeVenue(venue, { key: KEY, today: TODAY, fetch }), null);
});

test('out-of-Japan coordinates are rejected', async () => {
  const fetch = stub({ geocode: [json({ status: 'OK', results: [{ geometry: { location: { lat: 1, lng: 1 }, location_type: 'ROOFTOP' }, types: [] }] })], places: [json({})] });
  assert.equal(await geocodeVenue(venue, { key: KEY, today: TODAY, fetch }), null);
});

test('key/quota errors abort', async () => {
  await assert.rejects(geocodeVenue(venue, { key: KEY, today: TODAY, fetch: stub({ geocode: [json({ status: 'REQUEST_DENIED' })] }) }), GeocodeAbort);
  await assert.rejects(
    geocodeVenue(venue, { key: KEY, today: TODAY, fetch: stub({ geocode: [json(geocodeResult('APPROXIMATE'))], places: [json({}, 403)] }) }),
    GeocodeAbort,
  );
});

for (const status of ['INVALID_REQUEST', 'NOT_FOUND']) {
  test(`place_id refresh answering ${status} falls back to the address`, async () => {
    const fetch = stub({ geocode: [json({ status }), json(geocodeResult('ROOFTOP', { place_id: 'new' }))] });
    const g = await geocodeVenue(venue, { key: KEY, today: TODAY, placeId: 'gone', fetch });
    assert.equal(g.place_id, 'new');
    assert.equal(new URL(fetch.calls[1].url).searchParams.get('address'), venue.address);
  });
}

test('INVALID_REQUEST on an address lookup still aborts', async () => {
  await assert.rejects(geocodeVenue(venue, { key: KEY, today: TODAY, fetch: stub({ geocode: [json({ status: 'INVALID_REQUEST' })] }) }), GeocodeAbort);
});

test('geocodeVenues: a stale place_id does not stop the pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'));
  const cache = loadCache(dir, 'google');
  const other = { ...venue, name: 'B', address: '東京都新宿区西新宿2-2-2' };
  setEntry(cache, venue, { lat: 35.0, lng: 139.0, source: 'google', place_id: 'gone', geocoded_at: '2026-10-01' }, '2026-10-01');
  const fetch = stub({ geocode: [json({ status: 'NOT_FOUND' }), json(geocodeResult('ROOFTOP')), json(geocodeResult('ROOFTOP'))] });
  const stats = await geocodeVenues([venue, other], cache, { key: KEY, today: TODAY, dataDir: dir, fetch, delayMs: 0 });
  assert.deepEqual(stats, { looked_up: 2, found: 2, negative: 0, skipped_fresh: 0, aborted: null });
});

test('geocodeVenues refreshes a purged entry by its kept place_id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'));
  const cache = loadCache(dir, 'google');
  setEntry(cache, venue, { lat: 35.0, lng: 139.0, source: 'google', place_id: 'kept', geocoded_at: '2026-10-01' }, '2026-10-01');
  saveCache(dir, cache, { today: TODAY });
  const purged = loadCache(dir, 'google');
  const fetch = stub({ geocode: [json(geocodeResult('ROOFTOP', { place_id: 'kept' }))] });
  await geocodeVenues([venue], purged, { key: KEY, today: TODAY, dataDir: dir, fetch, delayMs: 0 });
  assert.equal(new URL(fetch.calls[0].url).searchParams.get('place_id'), 'kept');
  assert.equal(getEntry(purged, venue).geo.geocoded_at, TODAY);
});

test('refresh uses the cached place_id first', async () => {
  const fetch = stub({ geocode: [json(geocodeResult('ROOFTOP', { place_id: 'old' }))] });
  const g = await geocodeVenue(venue, { key: KEY, today: TODAY, placeId: 'old', fetch });
  assert.equal(new URL(fetch.calls[0].url).searchParams.get('place_id'), 'old');
  assert.equal(g.place_id, 'old');
});

test('geocodeVenues: dedupes, skips fresh, re-geocodes expired, writes negatives, saves cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'));
  const cache = loadCache(dir, 'google');
  const fresh = { ...venue, name: 'Fresh', address: '大阪府大阪市北区1-1' };
  const old = { ...venue, name: 'Old', address: '京都府京都市1-1' };
  setEntry(cache, fresh, { lat: 34.7, lng: 135.5, source: 'google', geocoded_at: '2026-11-10' }, '2026-11-10');
  setEntry(cache, old, { lat: 35.0, lng: 135.7, source: 'google', place_id: 'oldpid', geocoded_at: '2026-10-01' }, '2026-10-01');
  const missing = { ...venue, name: 'Nowhere', address: '東京都どこか' };
  const fetch = stub({
    geocode: [
      json(geocodeResult('ROOFTOP')), // venue
      json(geocodeResult('ROOFTOP', { place_id: 'oldpid' })), // old, by place_id
      json({ status: 'ZERO_RESULTS', results: [] }), // missing
    ],
    places: [json({})],
  });
  const stats = await geocodeVenues([venue, venue, fresh, old, missing, null], cache, { key: KEY, today: TODAY, dataDir: dir, fetch, delayMs: 0 });
  assert.deepEqual(stats, { looked_up: 3, found: 2, negative: 1, skipped_fresh: 1, aborted: null });
  assert.equal(getEntry(cache, old).geo.geocoded_at, TODAY);
  assert.equal(getEntry(cache, missing).geo, null);
  const saved = JSON.parse(readFileSync(join(dir, '.venues', 'google.json'), 'utf8'));
  assert.equal(Object.keys(saved.entries).length, 4);
});

test('geocodeVenues stops on abort without writing a negative entry, and honours max', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'));
  const cache = loadCache(dir, 'google');
  const stats = await geocodeVenues([venue], cache, { key: KEY, today: TODAY, dataDir: dir, delayMs: 0, fetch: stub({ geocode: [json({ status: 'OVER_QUERY_LIMIT' })] }) });
  assert.match(stats.aborted, /OVER_QUERY_LIMIT/);
  assert.equal(getEntry(cache, venue), undefined);
  const capped = await geocodeVenues([venue, { ...venue, name: 'B' }], cache, { key: KEY, today: TODAY, delayMs: 0, max: 1, fetch: stub({ geocode: [json(geocodeResult('ROOFTOP'))] }) });
  assert.equal(capped.looked_up, 1);
});

test('loadApiKey: env wins, then .env line, empty means none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'OTHER=1\nGOOGLE_GEOCODING_API_KEY="abc"\n');
  assert.equal(loadApiKey(file, {}), 'abc');
  assert.equal(loadApiKey(file, { GOOGLE_GEOCODING_API_KEY: 'env' }), 'env');
  writeFileSync(file, 'GOOGLE_GEOCODING_API_KEY=\n');
  assert.equal(loadApiKey(file, {}), null);
  assert.equal(loadApiKey(join(dir, 'missing'), {}), null);
});

test('tokyoDate', () => {
  assert.equal(tokyoDate(new Date('2026-11-18T15:00:00Z')), '2026-11-19');
  assert.equal(tokyoDate(new Date('2026-11-18T14:59:59Z')), '2026-11-18');
});
