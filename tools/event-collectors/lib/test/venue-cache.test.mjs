import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  cachePath, geoForEvent, geoFromPtcg, geoFromTcgPlus, getEntry, isExpired, loadCache, needsLookup,
  normalizeGeo, saveCache, setEntry, venueKey,
} from '../venue-cache.mjs';

const venue = { name: 'SAMPLE カードショップ 新宿店', source_id: null, region_code: 'JP-13', address: '東京都新宿区西新宿1-1-1' };

test('normalizeGeo rounds to 6 decimals and fixes key order', () => {
  assert.deepEqual(normalizeGeo({ source: 'tcgplus', lng: '139.69170649', lat: 35.689487449 }), {
    lat: 35.689487, lng: 139.691706, source: 'tcgplus', precision: null, place_id: null, geocoded_at: null,
  });
});

test('normalizeGeo rejects out-of-bounds, missing or malformed input', () => {
  assert.equal(normalizeGeo({ lat: 0, lng: 0, source: 'ptcg' }), null);
  assert.equal(normalizeGeo({ lat: 19.99, lng: 139, source: 'ptcg' }), null);
  assert.equal(normalizeGeo({ lat: 35, lng: 154.01, source: 'ptcg' }), null);
  assert.equal(normalizeGeo({ lat: 139.69, lng: 35.68, source: 'ptcg' }), null, 'swapped');
  assert.equal(normalizeGeo({ lat: '', lng: 139, source: 'ptcg' }), null);
  assert.equal(normalizeGeo({ lat: 35, lng: 139, source: 'osm' }), null);
  assert.equal(normalizeGeo({ lat: 35, lng: 139, source: 'ptcg', geocoded_at: '2026/11/19' }), null);
  assert.equal(normalizeGeo({ lat: 35, lng: 139, source: 'google' }), null, 'google needs geocoded_at');
  assert.equal(normalizeGeo(null), null);
  assert.deepEqual(normalizeGeo({ lat: 20, lng: 154, source: 'ptcg' })?.lat, 20);
});

test('geoFromTcgPlus: x is latitude, event_place_geo wins, place_geo fallback', () => {
  assert.deepEqual(geoFromTcgPlus({ x: 35.1, y: 139.2 }, { x: 34, y: 135 }), normalizeGeo({ lat: 35.1, lng: 139.2, source: 'tcgplus' }));
  assert.equal(geoFromTcgPlus(null, { x: '34.5', y: '135.5' }).lat, 34.5);
  assert.equal(geoFromTcgPlus({ x: 0, y: 0 }, { x: 34.5, y: 135.5 }).lng, 135.5);
  assert.equal(geoFromTcgPlus(null, null), null);
});

test('geoFromPtcg parses "lat,lng"', () => {
  assert.deepEqual(geoFromPtcg('33.5902, 130.4207'), normalizeGeo({ lat: 33.5902, lng: 130.4207, source: 'ptcg' }));
  assert.equal(geoFromPtcg(''), null);
  assert.equal(geoFromPtcg('33.5'), null);
  assert.equal(geoFromPtcg(null), null);
});

test('isExpired applies only to google, after 30 days', () => {
  const g = normalizeGeo({ lat: 35, lng: 139, source: 'google', place_id: 'ChIJx', geocoded_at: '2026-10-20' });
  assert.equal(isExpired(g, '2026-11-19'), false);
  assert.equal(isExpired(g, '2026-11-20'), true);
  assert.equal(isExpired(normalizeGeo({ lat: 35, lng: 139, source: 'tcgplus' }), '2030-01-01'), false);
  assert.equal(isExpired(null, '2026-11-19'), false);
});

test('venueKey: source_id first, else stable fingerprint', () => {
  assert.equal(venueKey({ ...venue, source_id: '1001' }), 'id:1001');
  const fp = venueKey(venue);
  assert.match(fp, /^fp:[0-9a-f]{16}$/);
  assert.equal(venueKey({ ...venue, name: ' SAMPLE  カードショップ　新宿店 ', address: '東京都新宿区西新宿１－１－１'.replace(/－/g, '-') }), fp);
  assert.notEqual(venueKey({ ...venue, address: '東京都新宿区西新宿1-1-2' }), fp);
  assert.notEqual(venueKey({ ...venue, region_code: 'JP-14' }), fp);
});

test('needsLookup / geoForEvent', () => {
  assert.equal(needsLookup(undefined, '2026-11-19'), true);
  assert.equal(needsLookup({ geo: null, checked_at: '2026-11-01' }, '2026-11-19'), false);
  assert.equal(needsLookup({ geo: null, checked_at: '2026-10-01' }, '2026-11-19'), true);
  assert.equal(needsLookup({ geo: null, checked_at: '2026-11-18' }, '2026-11-19', { retryDays: 0 }), true);
  const old = { geo: normalizeGeo({ lat: 35, lng: 139, source: 'google', geocoded_at: '2026-09-01' }), checked_at: '2026-09-01' };
  assert.equal(needsLookup(old, '2026-11-19'), true);
  assert.equal(geoForEvent(old, '2026-11-19'), null);
  const fresh = { geo: normalizeGeo({ lat: 35, lng: 139, source: 'ptcg' }), checked_at: '2025-01-01' };
  assert.equal(needsLookup(fresh, '2026-11-19'), false);
  assert.deepEqual(geoForEvent(fresh, '2026-11-19'), fresh.geo);
  assert.equal(geoForEvent(undefined, '2026-11-19'), null);
});

test('load/save round trip, sorted pretty JSON, atomic write, negative entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venue-cache-'));
  const cache = loadCache(dir, 'tcgplus');
  assert.deepEqual(cache, { version: 1, source: 'tcgplus', entries: {} });
  setEntry(cache, { ...venue, source_id: '2002' }, { lat: 34.70248, lng: 135.4959, source: 'tcgplus' }, '2026-11-19');
  setEntry(cache, { ...venue, source_id: '1001' }, null, '2026-11-19');
  const path = saveCache(dir, cache);
  assert.equal(path, cachePath(dir, 'tcgplus'));
  assert.equal(path, join(dir, '.venues', 'tcgplus.json'));
  const text = readFileSync(path, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.indexOf('"id:1001"') < text.indexOf('"id:2002"'));
  assert.deepEqual(readdirSync(join(dir, '.venues')), ['tcgplus.json']);
  const back = loadCache(dir, 'tcgplus');
  assert.deepEqual(getEntry(back, { source_id: '1001' }), { name: venue.name, address: venue.address, geo: null, checked_at: '2026-11-19' });
  assert.equal(getEntry(back, { source_id: '2002' }).geo.lat, 34.70248);
  assert.throws(() => loadCache(dir, 'ptcg') && saveCache(dir, { ...back, source: 'nope' }), /unknown geo source/);
  assert.throws(() => setEntry(back, venue, null, 'today'), /checked_at/);
});

test('saveCache keeps only the place_id of an expired google entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venue-cache-'));
  const cache = loadCache(dir, 'google');
  const fresh = { ...venue, name: 'Fresh' };
  const old = { ...venue, name: 'Old' };
  setEntry(cache, fresh, { lat: 35, lng: 139, source: 'google', place_id: 'pf', geocoded_at: '2026-10-20' }, '2026-10-20');
  setEntry(cache, old, { lat: 35, lng: 139, source: 'google', place_id: 'po', geocoded_at: '2026-10-19' }, '2026-10-19');
  saveCache(dir, cache, { today: '2026-11-19' });
  assert.equal(getEntry(cache, old).geo.lat, 35, 'in-memory cache untouched');
  const text = readFileSync(cachePath(dir, 'google'), 'utf8');
  const back = loadCache(dir, 'google');
  assert.equal(getEntry(back, fresh).geo.place_id, 'pf');
  assert.deepEqual(getEntry(back, old), { name: 'Old', address: venue.address, geo: null, checked_at: '2026-10-19', place_id: 'po' });
  assert.equal((text.match(/"lat"/g) ?? []).length, 1);
  assert.equal(needsLookup(getEntry(back, old), '2026-11-19'), true);
  assert.equal(geoForEvent(getEntry(back, old), '2026-11-19'), null);
});

test('loadCache rejects a file for another source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venue-cache-'));
  mkdirSync(join(dir, '.venues'));
  writeFileSync(join(dir, '.venues', 'ptcg.json'), JSON.stringify({ version: 1, source: 'tcgplus', entries: {} }));
  assert.throws(() => loadCache(dir, 'ptcg'), /not a version 1 ptcg venue cache/);
});
