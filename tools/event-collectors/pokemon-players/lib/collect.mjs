// Exhaustive offset pagination of /event_search per date chunk, with coverage proof.
import { eventKey } from './normalize.mjs';

export const NO_EVENTS = 'イベント情報が存在しません。';
export const PAGE_SIZE = 20; // fixed by the site (pagination.perPage); no limit param is sent

const slash = (iso) => iso.replaceAll('-', '/');

export function searchUrl({ startDate, endDate, offset }) {
  const q = new URLSearchParams({ offset: String(offset), order: '1', start_date: slash(startDate), end_date: slash(endDate) });
  return `/event_search?${q}`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Half-open [from, until) split into inclusive [start, end] chunks of at most `days` days.
export function chunks(from, until, days) {
  const out = [];
  for (let s = from; s < until;) {
    let e = addDays(s, days - 1);
    if (e >= until) e = addDays(until, -1);
    out.push({ startDate: s, endDate: e });
    s = addDays(e, 1);
  }
  return out;
}

export class CoverageError extends Error {}

// fetchJson(path) -> parsed body. Throws CoverageError when the chunk cannot be proven complete.
export async function collectChunk(fetchJson, chunk, { maxPages = 1000, countOnly = false } = {}) {
  const rows = new Map();
  let total = null;
  let pages = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    if (pages >= maxPages) throw new CoverageError(`${chunk.startDate}..${chunk.endDate}: page budget ${maxPages} exhausted`);
    const body = await fetchJson(searchUrl({ ...chunk, offset }));
    pages += 1;
    if (offset === 0 && body?.code === 404 && body.message === NO_EVENTS) return { chunk, total: 0, pages, rows: [] };
    if (body?.code !== 200 || !Array.isArray(body.event) || !Number.isInteger(body.eventCount)) {
      throw new CoverageError(`${chunk.startDate}..${chunk.endDate}@${offset}: unexpected body shape`);
    }
    if (total === null) total = body.eventCount;
    if (countOnly) return { chunk, total, pages, rows: [] };
    else if (body.eventCount !== total) {
      throw new CoverageError(`${chunk.startDate}..${chunk.endDate}: eventCount changed ${total} -> ${body.eventCount} mid-pagination`);
    }
    for (const row of body.event) {
      const day = String(row.event_date_params ?? '');
      const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
      if (iso < chunk.startDate || iso > chunk.endDate) {
        throw new CoverageError(`event ${row.event_holding_id} dated ${day} outside ${chunk.startDate}..${chunk.endDate}`);
      }
      const key = eventKey(row);
      const prev = rows.get(key);
      if (prev && prev.date_id !== row.date_id) {
        throw new CoverageError(`event_holding_id ${key} seen with date_id ${prev.date_id} and ${row.date_id}`);
      }
      rows.set(key, row);
    }
    if (body.event.length < PAGE_SIZE || offset + PAGE_SIZE >= total) break;
  }
  if (rows.size !== total) {
    throw new CoverageError(`${chunk.startDate}..${chunk.endDate}: ${rows.size} distinct ids != eventCount ${total}`);
  }
  return { chunk, total, pages, rows: [...rows.values()] };
}
