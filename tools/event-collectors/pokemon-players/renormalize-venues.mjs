// Rewrites venue.name in written PTCG files from the raw rows of the run that produced them, no network.
//   node renormalize-venues.mjs --data <data/events dir> --raw <out/run-<ts>/raw.json> [--write]
// Without --write it only reports. With --write it rewrites PTCG/<YYYY-MM>.json, adds a note to PTCG/_run.json
// and copies venue cache entries to the renamed venues' keys (data/events/.venues/ptcg.json).
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCache, saveCache } from '../lib/venue-cache.mjs';
import { containsContact, shopHomes } from './lib/normalize.mjs';
import { makeValidators } from './lib/output.mjs';
import { renameVenues } from './lib/renormalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: opt } = parseArgs({
  options: { data: { type: 'string' }, raw: { type: 'string' }, write: { type: 'boolean', default: false } },
});
if (!opt.data || !opt.raw) {
  console.error('usage: node renormalize-venues.mjs --data <data/events dir> --raw <raw.json> [--write]');
  process.exit(2);
}

const dataDir = resolve(opt.data);
const gameDir = join(dataDir, 'PTCG');
const raw = JSON.parse(readFileSync(resolve(opt.raw), 'utf8'));
const rowsById = new Map(raw.rows.map((r) => [String(r.event_holding_id), r]));
const homes = shopHomes(raw.rows);
const run = JSON.parse(readFileSync(join(gameDir, '_run.json'), 'utf8'));
if (raw.fetchedAt !== run.fetched_at) {
  console.error(`raw fetchedAt ${raw.fetchedAt} != PTCG/_run.json fetched_at ${run.fetched_at}: use the raw.json of the run that wrote these files`);
  process.exit(1);
}

const cache = loadCache(dataDir, 'ptcg');
const cacheBefore = Object.keys(cache.entries).length;
const validators = makeValidators(resolve(here, '..', '..', '..'));
const files = readdirSync(gameDir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
const out = [];
const all = [];
let missing = 0;
for (const f of files) {
  const events = JSON.parse(readFileSync(join(gameDir, f), 'utf8'));
  const r = renameVenues(events, rowsById, cache, homes);
  missing += r.missing;
  all.push(...r.changes);
  if (!validators.events(events)) throw new Error(`${f} fails event.schema.json: ${JSON.stringify(validators.events.errors.slice(0, 5))}`);
  const leaked = events.find((e) => e.venue && containsContact(e.venue.name));
  if (leaked) throw new Error(`${leaked.id}: contact-like venue name`);
  out.push({ f, events, changed: r.changes.length });
}

const venues = (list) => new Set(list.map((c) => `${c.from}\u0000${c.to}`)).size;
console.log(`events renamed: ${all.length} (${venues(all)} distinct from→to), events without a raw row: ${missing}`);
console.log(`venue cache: ${Object.keys(cache.entries).length - cacheBefore} entries copied to renamed keys`);
const seen = new Set();
for (const c of all) {
  const k = `${c.from}\u0000${c.to}`;
  if (seen.has(k) || seen.size >= 30) continue;
  seen.add(k);
  console.log(`  ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
}

if (!opt.write) {
  console.log('report only; pass --write to rewrite the files');
  process.exit(0);
}
if (all.length === 0) {
  console.log('nothing to change; no file written');
  process.exit(0);
}
const atomic = (path, body) => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
};
for (const { f, events, changed } of out) {
  if (changed) atomic(join(gameDir, f), `${JSON.stringify(events, null, 2)}\n`);
}
run.notes = [...run.notes, `Venue names re-normalised offline from this run's raw rows (renormalize-venues.mjs, ${new Date().toISOString().slice(0, 10)}): ${all.length} events renamed.`];
if (!validators.run(run)) throw new Error(`_run.json fails run.schema.json: ${JSON.stringify(validators.run.errors)}`);
atomic(join(gameDir, '_run.json'), `${JSON.stringify(run, null, 2)}\n`);
saveCache(dataDir, cache);
console.log(`written: ${out.filter((o) => o.changed).map((o) => o.f).join(', ')}, _run.json, .venues/ptcg.json`);
