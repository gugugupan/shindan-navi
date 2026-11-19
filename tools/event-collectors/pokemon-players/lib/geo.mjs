// Venue coordinates from the players-site event detail API (`geocoding: "lat,lng"`), cached per venue.
import { geoForEvent, geoFromPtcg, getEntry, needsLookup, setEntry, venueKey } from '../../lib/venue-cache.mjs';

export const DETAIL_PATH = '/event_detail_search';

export function detailPath(row) {
  const seg = (v) => (v === null || v === undefined || v === '' ? 0 : v);
  const q = new URLSearchParams({
    event_holding_id: String(row.event_holding_id),
    trainers_flg: String(seg(row.trainers_flg)),
    shop_id: String(seg(row.shop_id)),
    event_date: String(seg(row.event_date_params)),
    date_id: String(seg(row.date_id)),
  });
  return `${DETAIL_PATH}?${q}`;
}

/** Today in Asia/Tokyo as YYYY-MM-DD. */
export function tokyoDate(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(at);
}

// trainers_flg=1 rows with a date_id are the shape the detail route was observed with; cancelled rows last.
const rank = (row) => (row.trainers_flg === 1 && row.date_id ? 0 : 2) + (row.discontinuance_flg === 1 ? 1 : 0);

/**
 * One lookup per venue key: {key, venue, rows} with candidate source rows, best first.
 * `pairs` is [{event, row}] (normalized event + its raw list row).
 */
export function venueLookups(pairs) {
  const byKey = new Map();
  for (const { event, row } of pairs) {
    if (!event.venue) continue;
    const key = venueKey(event.venue);
    const item = byKey.get(key) ?? byKey.set(key, { key, venue: event.venue, rows: [] }).get(key);
    item.rows.push(row);
  }
  for (const item of byKey.values()) {
    item.rows.sort((a, b) => rank(a) - rank(b) || String(a.event_date_params).localeCompare(String(b.event_date_params)));
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Looks up venues that need it and stores results in `cache` (saved via `save` every `saveEvery`
 * lookups and at the end, so an interrupted pass resumes from the cache).
 * Per venue: a detail answer with no usable `geocoding` is a negative entry; a 404 (event gone)
 * tries the next candidate row, and leaves no entry if none answers. Transport errors leave no entry;
 * `maxConsecutiveErrors` in a row stop the pass (likely blocked).
 */
export async function geoPass({ fetchJson, cache, lookups, today, save, maxRequests = 3000, maxCandidates = 2, saveEvery = 10, maxConsecutiveErrors = 3, log = () => {} }) {
  const todo = lookups.filter((l) => needsLookup(getEntry(cache, l.venue), today));
  const stats = { venues: lookups.length, todo: todo.length, requests: 0, found: 0, negative: 0, skipped: 0, errors: 0, stopped: null };
  let consecutive = 0;
  let unsaved = 0;
  try {
    for (const [i, item] of todo.entries()) {
      if (stats.requests >= maxRequests) { stats.stopped = `detail request budget ${maxRequests} exhausted`; break; }
      let outcome = 'skipped';
      for (const row of item.rows.slice(0, maxCandidates)) {
        if (stats.requests >= maxRequests) break;
        stats.requests += 1;
        let body;
        try {
          body = await fetchJson(detailPath(row));
        } catch (err) {
          stats.errors += 1;
          consecutive += 1;
          log(`detail ${row.event_holding_id} (${item.key}) failed: ${err.message}`);
          outcome = 'error';
          break;
        }
        consecutive = 0;
        if (body?.code !== 200 || !body.event) continue;
        const geo = geoFromPtcg(body.event.geocoding);
        setEntry(cache, item.venue, geo, today);
        outcome = geo ? 'found' : 'negative';
        unsaved += 1;
        break;
      }
      if (outcome === 'found') stats.found += 1;
      else if (outcome === 'negative') stats.negative += 1;
      else if (outcome === 'skipped') stats.skipped += 1;
      if (consecutive >= maxConsecutiveErrors) { stats.stopped = `${consecutive} consecutive detail errors`; break; }
      if (unsaved >= saveEvery) { save(); unsaved = 0; }
      if ((i + 1) % 100 === 0) log(`geo ${i + 1}/${todo.length} found=${stats.found} negative=${stats.negative} errors=${stats.errors}`);
    }
  } finally {
    save();
  }
  return stats;
}

/** Sets venue.geo on every event with a venue (null when the cache has nothing usable). */
export function applyGeo(events, cache, today) {
  let withGeo = 0;
  let venues = 0;
  for (const e of events) {
    if (!e.venue) continue;
    venues += 1;
    e.venue.geo = geoForEvent(getEntry(cache, e.venue), today);
    if (e.venue.geo) withGeo += 1;
  }
  return { events_with_venue: venues, events_with_geo: withGeo };
}
