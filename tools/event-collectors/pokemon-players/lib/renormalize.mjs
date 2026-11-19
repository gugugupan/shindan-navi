// Offline venue-name fix for already written PTCG events, from the raw list rows of the same run.
import { venueKey } from '../../lib/venue-cache.mjs';
import { venueName } from './normalize.mjs';

/**
 * Sets venue.name from the raw row (by external_id) on every event with a venue; everything else, geo included, is
 * kept. The cache key of an own-venue event hashes its name, so a renamed venue's cache entry is copied to the new
 * key (when that key is free) and the next collect needs no detail request for it.
 * Mutates `events` and `cache`; returns the changes.
 */
export function renameVenues(events, rowsById, cache) {
  const changes = [];
  let missing = 0;
  for (const e of events) {
    if (!e.venue) continue;
    const row = rowsById.get(e.external_id);
    if (!row) { missing += 1; continue; }
    const name = venueName(row);
    if (name === e.venue.name) continue;
    const oldKey = venueKey(e.venue);
    changes.push({ id: e.id, from: e.venue.name, to: name });
    e.venue.name = name;
    const newKey = venueKey(e.venue);
    if (oldKey !== newKey && cache.entries[oldKey] && !cache.entries[newKey]) {
      cache.entries[newKey] = { ...cache.entries[oldKey], name };
    }
  }
  return { changes, missing };
}
