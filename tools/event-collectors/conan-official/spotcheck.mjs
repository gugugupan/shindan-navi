// node spotcheck.mjs <staged-or-data CONAN dir> conan:<id> ... — re-fetches each event's source_url
// (eventsearch filtered by series, store and day) and compares the listed row with the stored event.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fingerprint, normalizeEvent } from './lib/normalize.mjs';
import { parseRows } from './lib/parse.mjs';

const [dir, ...ids] = process.argv.slice(2);
const events = readdirSync(resolve(dir))
  .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
  .flatMap((f) => JSON.parse(readFileSync(join(resolve(dir), f), 'utf8')));
const FIELDS = ['name', 'starts_at', 'capacity', 'fee_amount', 'fee_text', 'format_text', 'venue'];
let bad = 0;
for (const [i, id] of ids.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, 1500));
  const e = events.find((x) => x.id === id);
  if (!e) { console.log(`${id}: not in data`); bad++; continue; }
  const res = await fetch(e.source_url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; shindan-navi-event-collector/0.1)' }, signal: AbortSignal.timeout(30000) });
  const rows = parseRows(await res.text());
  const row = rows.find((r) => `conan:${fingerprint(r)}` === id);
  if (!row) { console.log(`${id}: NOT FOUND on live page (${rows.length} rows at source_url)`); bad++; continue; }
  const live = normalizeEvent(row, e.last_seen_at);
  const diff = FIELDS.filter((k) => JSON.stringify(live[k]) !== JSON.stringify(e[k]));
  console.log(`${id}: ${diff.length ? `DIFF ${diff.join(',')}` : 'OK'} | ${e.starts_at} ${e.venue.name} ${e.venue.region_name} 定員${e.capacity} ${e.fee_text ?? ''} (${rows.length} row(s) at source_url)`);
  if (diff.length) bad++;
}
process.exit(bad ? 1 : 0);
