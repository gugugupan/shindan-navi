// Venue geo cache shared by the event collectors (contracts/README.md "Venue geo").
// No dependencies: collectors import it relatively, e.g. `../lib/venue-cache.mjs`.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const GEO_SOURCES = ['tcgplus', 'ptcg', 'google', 'bushinavi'];
export const CACHE_VERSION = 1;
export const GOOGLE_MAX_AGE_DAYS = 30;
export const NEGATIVE_RETRY_DAYS = 30;
export const BOUNDS = { latMin: 20, latMax: 46, lngMin: 122, lngMax: 154 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** data/events/.venues/<source>.json */
export function cachePath(dataDir, source) {
  if (!GEO_SOURCES.includes(source)) throw new Error(`unknown geo source: ${source}`);
  return join(dataDir, '.venues', `${source}.json`);
}

const toNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.trim());
  return NaN;
};
const round6 = (n) => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Validates and canonicalizes a geo value: 6-decimal rounding, Japan bounds, key order fixed.
 * Returns null for anything unusable (missing/NaN/out-of-bounds coordinates, unknown source,
 * bad geocoded_at, or a google result without geocoded_at).
 */
export function normalizeGeo(input) {
  if (!input || typeof input !== 'object') return null;
  const lat = toNumber(input.lat);
  const lng = toNumber(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < BOUNDS.latMin || lat > BOUNDS.latMax || lng < BOUNDS.lngMin || lng > BOUNDS.lngMax) return null;
  if (!GEO_SOURCES.includes(input.source)) return null;
  const geocodedAt = input.geocoded_at ?? null;
  if (geocodedAt !== null && !(typeof geocodedAt === 'string' && DATE_RE.test(geocodedAt))) return null;
  if (input.source === 'google' && geocodedAt === null) return null;
  const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  return {
    lat: round6(lat),
    lng: round6(lng),
    source: input.source,
    precision: text(input.precision),
    place_id: text(input.place_id),
    geocoded_at: geocodedAt,
  };
}

/** TCG+: x = latitude, y = longitude; event_place_geo wins over place_geo. Values are {x, y} objects. */
export function geoFromTcgPlus(eventPlaceGeo, placeGeo, extra = {}) {
  for (const g of [eventPlaceGeo, placeGeo]) {
    if (!g || typeof g !== 'object') continue;
    const geo = normalizeGeo({ ...extra, lat: g.x, lng: g.y, source: 'tcgplus' });
    if (geo) return geo;
  }
  return null;
}

/** PTCG event detail `geocoding`: "lat,lng". */
export function geoFromPtcg(geocoding, extra = {}) {
  if (typeof geocoding !== 'string') return null;
  const parts = geocoding.split(',');
  if (parts.length !== 2) return null;
  return normalizeGeo({ ...extra, lat: parts[0], lng: parts[1], source: 'ptcg' });
}

const daysBetween = (from, to) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** True when a google geo's lat/lng must not be used any more (geocoded more than 30 days before `today`). */
export function isExpired(geo, today) {
  if (!geo || geo.source !== 'google') return false;
  if (!geo.geocoded_at) return true;
  return daysBetween(geo.geocoded_at, today) > GOOGLE_MAX_AGE_DAYS;
}

const fold = (v) => (typeof v === 'string' ? v.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() : '');

/** `id:<venue.source_id>` when the source has one, else `fp:<sha1 of name|address|region_code>` (16 hex). */
export function venueKey(venue) {
  if (!venue || typeof venue !== 'object') throw new Error('venueKey needs a venue');
  const sid = typeof venue.source_id === 'string' ? venue.source_id.trim() : venue.source_id;
  if (sid !== null && sid !== undefined && sid !== '') return `id:${sid}`;
  const fp = [fold(venue.name), fold(venue.address), venue.region_code ?? ''].join('\n');
  return `fp:${createHash('sha1').update(fp).digest('hex').slice(0, 16)}`;
}

/** Loads the cache for one source; a missing file is an empty cache. */
export function loadCache(dataDir, source) {
  const path = cachePath(dataDir, source);
  if (!existsSync(path)) return { version: CACHE_VERSION, source, entries: {} };
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data?.version !== CACHE_VERSION || data.source !== source || typeof data.entries !== 'object' || !data.entries) {
    throw new Error(`${path}: not a version ${CACHE_VERSION} ${source} venue cache`);
  }
  return data;
}

/** Today in Asia/Tokyo as YYYY-MM-DD. */
const tokyoToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

/**
 * Google lat/lng may be stored for 30 days only, place_id indefinitely: an expired google entry is written as a
 * negative entry that keeps its place_id (geocodeVenues refreshes by it). The in-memory cache is left as is.
 */
function storedEntry(entry, today) {
  if (!isExpired(entry?.geo, today)) return entry;
  const { geo, ...rest } = entry;
  return { ...rest, geo: null, place_id: geo.place_id ?? null };
}

/** Writes pretty JSON (keys sorted) via a temp file + rename. */
export function saveCache(dataDir, cache, { today = tokyoToday() } = {}) {
  const path = cachePath(dataDir, cache.source);
  mkdirSync(dirname(path), { recursive: true });
  const entries = Object.fromEntries(Object.keys(cache.entries).sort().map((k) => [k, storedEntry(cache.entries[k], today)]));
  const body = `${JSON.stringify({ version: CACHE_VERSION, source: cache.source, entries }, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
  return path;
}

/** Stores a lookup result; geo null is a negative entry (lookup failed / no usable coordinates). */
export function setEntry(cache, venue, geo, checkedAt) {
  if (!DATE_RE.test(checkedAt ?? '')) throw new Error(`checked_at must be YYYY-MM-DD: ${checkedAt}`);
  const entry = { name: venue.name ?? null, address: venue.address ?? null, geo: normalizeGeo(geo), checked_at: checkedAt };
  cache.entries[venueKey(venue)] = entry;
  return entry;
}

/** The cached entry, or undefined. */
export function getEntry(cache, venue) {
  return cache.entries[venueKey(venue)];
}

/**
 * True when the venue should be looked up again: no entry, an expired google geo, or a negative
 * entry older than `retryDays`.
 */
export function needsLookup(entry, today, { retryDays = NEGATIVE_RETRY_DAYS } = {}) {
  if (!entry) return true;
  if (entry.geo) return isExpired(entry.geo, today);
  return !entry.checked_at || daysBetween(entry.checked_at, today) > retryDays;
}

/** The geo to write into venue.geo: the cached geo unless missing or expired, else null. */
export function geoForEvent(entry, today) {
  if (!entry?.geo || isExpired(entry.geo, today)) return null;
  return entry.geo;
}
