// Optional Google geocoding for venues without source coordinates (contracts/README.md "Venue geo").
// Geocoding API first; Places API (New) Text Search when the address is not matched precisely.
// No dependencies; `fetch` is injectable so tests never hit the network.
import { existsSync, readFileSync } from 'node:fs';
import { getEntry, needsLookup, normalizeGeo, saveCache, setEntry, venueKey } from './venue-cache.mjs';

export const KEY_NAME = 'GOOGLE_GEOCODING_API_KEY';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const PRECISE = new Set(['ROOFTOP', 'RANGE_INTERPOLATED']);
// A Places result farther than this from the address's GEOMETRIC_CENTER geocode is another place of that name.
export const PLACES_MAX_KM = 3;
// Index + 1 = the number in region_code JP-NN.
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];
// Area-level results (prefecture, city, ward, postcode) are centroids, which the contract forbids.
const AREA_TYPES = new Set([
  'country', 'administrative_area_level_1', 'administrative_area_level_2', 'locality', 'sublocality',
  'sublocality_level_1', 'colloquial_area', 'postal_code',
]);

/** Errors that make every further request pointless (bad key, quota, billing); the pass stops on them. */
export class GeocodeAbort extends Error {}

/** The key from the environment, else from a KEY=value line in `envFile`; null when absent or empty. */
export function loadApiKey(envFile, env = process.env) {
  if (env[KEY_NAME]?.trim()) return env[KEY_NAME].trim();
  if (!envFile || !existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?GOOGLE_GEOCODING_API_KEY\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2') || null;
  }
  return null;
}

/** YYYY-MM-DD in Asia/Tokyo. */
export function tokyoDate(date = new Date()) {
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

const geo = (lat, lng, precision, placeId, today) =>
  normalizeGeo({ lat, lng, source: 'google', precision, place_id: placeId, geocoded_at: today });

// Statuses that mean "nothing for this place_id" (stale or malformed id), not a key/quota problem.
const PLACE_ID_MISSES = new Set(['INVALID_REQUEST', 'NOT_FOUND']);

async function geocodeRequest(params, key, fetchImpl) {
  const url = `${GEOCODE_URL}?${new URLSearchParams({ ...params, region: 'jp', language: 'ja', key })}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new GeocodeAbort(`Geocoding API HTTP ${res.status}`);
  const body = await res.json();
  if (body.status === 'OK' || body.status === 'ZERO_RESULTS') return body.results ?? [];
  if (params.place_id && PLACE_ID_MISSES.has(body.status)) return [];
  // Never echo error_message wholesale elsewhere: it is short and key-free, but keep it on one line.
  throw new GeocodeAbort(`Geocoding API ${body.status}${body.error_message ? `: ${String(body.error_message).slice(0, 200)}` : ''}`);
}

async function placesRequest(textQuery, key, fetchImpl) {
  const res = await fetchImpl(PLACES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      // places.location and places.formattedAddress bill as Text Search Pro.
      'X-Goog-FieldMask': 'places.id,places.location,places.formattedAddress',
    },
    body: JSON.stringify({ textQuery, languageCode: 'ja', regionCode: 'JP', pageSize: 1 }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
    throw new GeocodeAbort(`Places API HTTP ${res.status}`);
  }
  if (!res.ok) return [];
  return (await res.json()).places ?? [];
}

const isArea = (r) => (r.types ?? []).some((t) => AREA_TYPES.has(t));

function km(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** The prefecture name for JP-NN, else null. */
export function prefectureName(regionCode) {
  const m = /^JP-(\d{2})$/.exec(regionCode ?? '');
  return m ? PREFECTURES[Number(m[1]) - 1] ?? null : null;
}

/**
 * Text Search matches names loosely and can return a same-named shop elsewhere: with a known prefecture the result's
 * address must name it, and with a GEOMETRIC_CENTER geocode of the address it must lie within PLACES_MAX_KM of it.
 */
export function placeMatches(place, venue, geometricCenter) {
  const pref = prefectureName(venue.region_code);
  if (pref && !String(place.formattedAddress ?? '').includes(pref)) return false;
  if (geometricCenter && km(place, geometricCenter) > PLACES_MAX_KM) return false;
  return true;
}

/**
 * Looks up one venue. Returns a google geo or null (nothing usable). Throws GeocodeAbort on key/quota errors.
 * Order: refresh by cached place_id (Geocoding by place_id) → Geocoding by address (ROOFTOP/RANGE_INTERPOLATED)
 * → Places Text Search "name address" (if it passes placeMatches) → a GEOMETRIC_CENTER, non-partial, non-area
 * Geocoding result → null. APPROXIMATE results are never used. A place_id the Geocoding API no longer knows
 * (INVALID_REQUEST / NOT_FOUND) falls through to the address lookup.
 */
export async function geocodeVenue(venue, { key, today, placeId = null, fetch: fetchImpl = fetch }) {
  if (placeId) {
    const [r] = await geocodeRequest({ place_id: placeId }, key, fetchImpl);
    if (r && r.geometry?.location_type !== 'APPROXIMATE' && !isArea(r)) {
      const g = geo(r.geometry.location.lat, r.geometry.location.lng, r.geometry.location_type, r.place_id ?? placeId, today);
      if (g) return g;
    }
  }
  const address = venue.address?.trim();
  let fallback = null;
  if (address) {
    const [r] = await geocodeRequest({ address, components: 'country:JP' }, key, fetchImpl);
    if (r && !isArea(r)) {
      const type = r.geometry?.location_type;
      const g = geo(r.geometry?.location?.lat, r.geometry?.location?.lng, type, r.place_id, today);
      if (g && PRECISE.has(type)) return g;
      if (g && type === 'GEOMETRIC_CENTER' && !r.partial_match) fallback = g;
    }
  }
  const text = [venue.name, address].filter((v) => v?.trim()).join(' ');
  if (text) {
    const [p] = await placesRequest(text, key, fetchImpl);
    const g = p && geo(p.location?.latitude, p.location?.longitude, 'PLACES_TEXT_SEARCH', p.id, today);
    if (g && placeMatches({ ...g, formattedAddress: p.formattedAddress }, venue, fallback)) return g;
  }
  return fallback;
}

/**
 * Geocodes every distinct venue that needs a lookup and updates `cache` (source "google") in place.
 * Saves the cache every `saveEvery` lookups and at the end. Stops early on GeocodeAbort or `max` lookups.
 * Returns { looked_up, found, negative, skipped_fresh, aborted }.
 */
export async function geocodeVenues(venues, cache, { key, today, dataDir, fetch: fetchImpl = fetch, delayMs = 100, max = Infinity, saveEvery = 50, log = () => {} }) {
  const stats = { looked_up: 0, found: 0, negative: 0, skipped_fresh: 0, aborted: null };
  const seen = new Set();
  try {
    for (const venue of venues) {
      if (!venue) continue;
      const k = venueKey(venue);
      if (seen.has(k)) continue;
      seen.add(k);
      const entry = getEntry(cache, venue);
      if (!needsLookup(entry, today)) {
        stats.skipped_fresh++;
        continue;
      }
      if (stats.looked_up >= max) break;
      if (stats.looked_up > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      stats.looked_up++;
      let g;
      try {
        g = await geocodeVenue(venue, { key, today, placeId: entry?.geo?.place_id ?? entry?.place_id ?? null, fetch: fetchImpl });
      } catch (err) {
        if (err instanceof GeocodeAbort) {
          stats.aborted = err.message;
          break;
        }
        throw err;
      }
      setEntry(cache, venue, g, today);
      stats[g ? 'found' : 'negative']++;
      if (dataDir && stats.looked_up % saveEvery === 0) saveCache(dataDir, cache);
      if (stats.looked_up % 100 === 0) log(`geocoded ${stats.looked_up} (found ${stats.found})`);
    }
  } finally {
    if (dataDir && stats.looked_up > 0) saveCache(dataDir, cache);
  }
  return stats;
}
