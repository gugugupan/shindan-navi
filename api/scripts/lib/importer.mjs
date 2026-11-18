// Reads data/events/<GAME>/ (month files + _run.json), validates them against contracts/, diffs the
// accepted runs against the database's current rows and turns the difference into SQL for D1 / SQLite.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const HERE = dirname(fileURLToPath(import.meta.url));
export const API_DIR = resolve(HERE, '../..');
export const REPO_DIR = resolve(API_DIR, '..');
export const CONTRACTS_DIR = join(REPO_DIR, 'contracts');
export const DEFAULT_DATA_DIR = join(REPO_DIR, 'data', 'events');

export const GAME_CODES = ['OPCG', 'UATCG', 'CONAN', 'PTCG'];
const ID_PREFIX = { bandai_tcg_plus: 'tcgp', pokemon_players: 'ptcg', conan_official: 'conan' };
// 9999-12-31T23:59:59Z: date-only events sort after timed ones on the same day.
export const NULL_SORT = 253402300799;
const MAX_ERRORS = 50;
// D1 rejects statements over 100 KB; stay well below.
const MAX_STATEMENT_BYTES = 80_000;
const MAX_ROWS_PER_STATEMENT = 200;

let validators;
function getValidators() {
  if (!validators) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    validators = {
      events: ajv.compile(JSON.parse(readFileSync(join(CONTRACTS_DIR, 'event.schema.json'), 'utf8'))),
      run: ajv.compile(JSON.parse(readFileSync(join(CONTRACTS_DIR, 'run.schema.json'), 'utf8'))),
    };
  }
  return validators;
}

function schemaErrors(validate, label) {
  return (validate.errors ?? []).slice(0, 10).map((e) => `${label}${e.instancePath || '/'} ${e.message}`);
}

function isRealDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Load and validate one game directory. Returns { game, run, events, errors, warnings }. */
export function loadGame(dataDir, game) {
  const dir = join(dataDir, game);
  const out = { game, run: null, events: [], errors: [], warnings: [] };
  const err = (m) => out.errors.length < MAX_ERRORS && out.errors.push(m);
  if (!GAME_CODES.includes(game)) {
    err(`unknown game directory ${game}`);
    return out;
  }
  const runPath = join(dir, '_run.json');
  if (!existsSync(runPath)) {
    err(`${game}/_run.json missing`);
    return out;
  }
  const v = getValidators();
  let run;
  try {
    run = JSON.parse(readFileSync(runPath, 'utf8'));
  } catch (e) {
    err(`${game}/_run.json: ${e.message}`);
    return out;
  }
  if (!v.run(run)) {
    out.errors.push(...schemaErrors(v.run, `${game}/_run.json`));
    return out;
  }
  if (run.game_code !== game) err(`${game}/_run.json: game_code ${run.game_code} does not match directory`);
  if (!isRealDate(run.window.from) || !isRealDate(run.window.until) || run.window.until <= run.window.from) {
    err(`${game}/_run.json: invalid window ${run.window.from}..${run.window.until}`);
  }
  out.run = run;

  const seen = new Set();
  const files = readdirSync(dir).filter((f) => f !== '_run.json').sort();
  for (const file of files) {
    if (!/^\d{4}-\d{2}\.json$/.test(file)) {
      if (statSync(join(dir, file)).isFile()) out.warnings.push(`${game}/${file}: ignored (not YYYY-MM.json)`);
      continue;
    }
    const label = `${game}/${file}`;
    const raw = readFileSync(join(dir, file), 'utf8');
    if (raw.includes('\\u0000')) {
      err(`${label}: contains NUL characters`);
      continue;
    }
    let events;
    try {
      events = JSON.parse(raw);
    } catch (e) {
      err(`${label}: ${e.message}`);
      continue;
    }
    if (!v.events(events)) {
      out.errors.push(...schemaErrors(v.events, label));
      continue;
    }
    const month = file.slice(0, 7);
    events.forEach((ev, i) => {
      const at = `${label}[${i}] ${ev.id}`;
      if (ev.game_code !== game) err(`${at}: game_code ${ev.game_code} in ${game}/`);
      if (ev.source_code !== run.source_code) err(`${at}: source_code ${ev.source_code} != run ${run.source_code}`);
      if (ev.id !== `${ID_PREFIX[ev.source_code]}:${ev.external_id}`) err(`${at}: id must be ${ID_PREFIX[ev.source_code]}:<external_id>`);
      if (seen.has(ev.id)) err(`${at}: duplicate id`);
      seen.add(ev.id);
      if (!isRealDate(ev.starts_on)) err(`${at}: invalid starts_on`);
      if (ev.starts_on.slice(0, 7) !== month) err(`${at}: starts_on ${ev.starts_on} in ${file}`);
      if (ev.starts_on < run.window.from || ev.starts_on >= run.window.until) err(`${at}: starts_on ${ev.starts_on} outside run window`);
      if (ev.ends_on !== null && (!isRealDate(ev.ends_on) || ev.ends_on < ev.starts_on)) err(`${at}: ends_on before starts_on`);
      if (ev.time_precision === 'datetime' && ev.starts_at === null) err(`${at}: time_precision datetime needs starts_at`);
      if (ev.starts_at !== null && Number.isNaN(Date.parse(ev.starts_at))) err(`${at}: unparseable starts_at`);
    });
    out.events.push(...events);
  }
  if (run.record_count !== out.events.length) {
    err(`${game}: run.record_count ${run.record_count} != ${out.events.length} events in files`);
  }
  return out;
}

/** Load every game directory present (or the requested ones). */
export function loadAll(dataDir, games) {
  const present = existsSync(dataDir)
    ? readdirSync(dataDir).filter((d) => !d.startsWith('.') && statSync(join(dataDir, d)).isDirectory()).sort()
    : [];
  const wanted = games?.length ? games : present;
  const results = wanted.map((g) => loadGame(dataDir, g));
  // Shared events must be identical apart from game_code / last_seen_at; otherwise the last game read wins.
  const seen = new Map();
  for (const r of results) {
    if (r.errors.length) continue;
    for (const ev of r.events) {
      const key = JSON.stringify(eventContent(ev));
      const prev = seen.get(ev.id);
      if (prev && prev.key !== key) r.warnings.push(`${ev.id}: differs from the copy in ${prev.game}; using ${r.game}`);
      seen.set(ev.id, { key, game: r.game });
    }
  }
  return results;
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number ${v}`);
    return String(v);
  }
  return `'${String(v).replaceAll("'", "''")}'`;
}

export const importId = (run) => `${run.game_code}:${run.fetched_at}`;
export const GAME_BITS = { OPCG: 1, UATCG: 2, CONAN: 4, PTCG: 8 };
export const CATEGORIES = ['tournament', 'casual', 'teaching', 'festival', 'other', 'unknown'];
const VENUE_KEYS = ['name', 'source_id', 'country_code', 'region_code', 'region_name', 'city', 'address', 'postal_code'];

/** Event content minus the fields that legitimately differ between copies (game file, run time). */
export function eventContent(ev) {
  const { last_seen_at, game_code, ...content } = ev;
  return content;
}

/** Location key used by the API's pref filter: the venue's prefecture, or 'online' without one. */
export function locOf(ev) {
  if (ev.venue?.region_code) return ev.venue.region_code;
  return ev.attendance_mode === 'online' || ev.attendance_mode === 'hybrid' || !ev.venue ? 'online' : null;
}

const EVENT_COLS = [
  'id', 'game_mask', 'loc', 'source_code', 'external_id', 'source_url', 'group_source_id', 'group_name', 'category',
  'event_type_code', 'name', 'attendance_mode', 'venue_json', 'region_code', 'starts_on', 'ends_on', 'starts_at', 'ends_at',
  'starts_sort', 'timezone', 'time_precision', 'format_text', 'eligibility_text', 'capacity', 'fee_amount', 'fee_currency',
  'fee_text', 'registration_method', 'registration_platform', 'registration_url', 'registration_opens_at',
  'registration_closes_at', 'registration_status', 'event_status', 'source_status_text', 'content_hash', 'created_at', 'updated_at',
];
const IMPORT_COLS = ['id', 'game_code', 'source_code', 'fetched_at', 'window_from', 'window_until', 'source_total', 'record_count', 'complete', 'collector_version', 'query_json', 'notes_json', 'run_hash', 'imported_at'];
/** Columns the importer needs from every existing event to diff and to recompute meta. */
export const STATE_EVENT_COLS = ['id', 'content_hash', 'game_mask', 'starts_on', 'loc', 'region_code', 'attendance_mode', 'category', 'event_type_code'];
export const STATE_IMPORT_COLS = ['id', 'game_code', 'fetched_at', 'window_from', 'window_until', 'record_count', 'complete'];

function eventRow(ev, now) {
  return {
    id: ev.id,
    game_mask: 0,
    loc: locOf(ev),
    source_code: ev.source_code,
    external_id: ev.external_id,
    source_url: ev.source_url,
    group_source_id: ev.group.source_id,
    group_name: ev.group.name,
    category: ev.group.category,
    event_type_code: ev.group.event_type_code,
    name: ev.name,
    attendance_mode: ev.attendance_mode,
    venue_json: ev.venue ? JSON.stringify(Object.fromEntries(VENUE_KEYS.map((k) => [k, ev.venue[k] ?? null]))) : null,
    region_code: ev.venue?.region_code ?? null,
    starts_on: ev.starts_on,
    ends_on: ev.ends_on,
    starts_at: ev.starts_at,
    ends_at: ev.ends_at,
    starts_sort: ev.starts_at === null ? NULL_SORT : Math.floor(Date.parse(ev.starts_at) / 1000),
    timezone: ev.timezone,
    time_precision: ev.time_precision,
    format_text: ev.format_text,
    eligibility_text: ev.eligibility_text,
    capacity: ev.capacity,
    fee_amount: ev.fee_amount,
    fee_currency: ev.fee_currency,
    fee_text: ev.fee_text,
    registration_method: ev.registration_method,
    registration_platform: ev.registration_platform,
    registration_url: ev.registration_url,
    registration_opens_at: ev.registration_opens_at,
    registration_closes_at: ev.registration_closes_at,
    registration_status: ev.registration_status,
    event_status: ev.event_status,
    source_status_text: ev.source_status_text,
    // last_seen_at changes every run and is served from the import instead, so it is left out.
    content_hash: sha1(JSON.stringify(eventContent(ev))),
    created_at: now,
    updated_at: now,
  };
}

/** State of an empty (freshly migrated) database. */
export const emptyState = () => ({ events: new Map(), imports: [] });

/** Builds the importer's view of a database from rows of STATE_EVENT_COLS / STATE_IMPORT_COLS. */
export function stateFromRows(eventRows, importRows) {
  return {
    events: new Map(eventRows.map((r) => [r.id, { ...r, game_mask: Number(r.game_mask) }])),
    imports: importRows.map((r) => ({ ...r, record_count: Number(r.record_count), complete: Number(r.complete) })),
  };
}

/** SQL that pages through the state (keyset by id, `pageSize` rows per call). */
export const stateEventsSql = (afterId, pageSize) =>
  `SELECT ${STATE_EVENT_COLS.join(', ')} FROM events${afterId === null ? '' : ` WHERE id > ${sqlLiteral(afterId)}`} ORDER BY id LIMIT ${pageSize}`;
export const stateImportsSql = () => `SELECT ${STATE_IMPORT_COLS.join(', ')} FROM imports`;

function chunked(head, items, tail = '') {
  const out = [];
  let batch = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length) out.push(head + batch.join(',\n') + tail);
    batch = [];
    bytes = 0;
  };
  for (const item of items) {
    if (batch.length && (bytes + item.length > MAX_STATEMENT_BYTES || batch.length >= MAX_ROWS_PER_STATEMENT)) flush();
    batch.push(item);
    bytes += item.length + 2;
  }
  flush();
  return out;
}

/** The /events/meta body without labels, over each game's latest import window. */
export function computeMeta(events, imports) {
  const latest = {};
  for (const imp of imports) {
    const cur = latest[imp.game_code];
    if (!cur || imp.fetched_at > cur.fetched_at) latest[imp.game_code] = imp;
  }
  const games = {};
  for (const [g, imp] of Object.entries(latest)) {
    games[g] = { record_count: imp.record_count, fetched_at: imp.fetched_at, complete: imp.complete === 1, window: { from: imp.window_from, until: imp.window_until } };
  }
  const prefectures = {};
  const categories = {};
  const types = new Map();
  let online = 0;
  for (const e of events.values()) {
    let inWindow = 0;
    for (const [g, bit] of Object.entries(GAME_BITS)) {
      const imp = latest[g];
      if (imp && e.game_mask & bit && e.starts_on >= imp.window_from && e.starts_on < imp.window_until) inWindow |= bit;
    }
    if (!inWindow) continue;
    if (e.loc === 'online') online++;
    else if (e.region_code && e.attendance_mode !== 'online') prefectures[e.region_code] = (prefectures[e.region_code] ?? 0) + 1;
    categories[e.category] = (categories[e.category] ?? 0) + 1;
    if (e.event_type_code === null) continue;
    for (const [g, bit] of Object.entries(GAME_BITS)) {
      if (!(inWindow & bit)) continue;
      const key = `${g}\t${e.event_type_code}`;
      types.set(key, (types.get(key) ?? 0) + 1);
    }
  }
  const typeList = [...types].map(([k, n]) => [...k.split('\t'), n]).sort((a, b) => (a[0] + '\t' + a[1] < b[0] + '\t' + b[1] ? -1 : 1));
  return {
    games,
    prefectures: Object.fromEntries(Object.entries(prefectures).sort()),
    online,
    categories: Object.fromEntries(CATEGORIES.filter((c) => categories[c]).map((c) => [c, categories[c]])),
    types: typeList,
    fetched_at: Object.fromEntries(Object.entries(latest).map(([g, imp]) => [g, imp.fetched_at])),
  };
}

/**
 * Diffs the accepted runs against `state` (the database's current rows) and returns the SQL that brings
 * the database up to date, writing only what changed:
 * - new events are inserted; events whose content hash changed are rewritten;
 * - game_mask gains the bits of the games listing an event and, for complete runs, loses the run's
 *   bit on events inside its window that it no longer lists (rows are kept, mask 0 hides them);
 * - new runs get an imports row; site_meta ('meta', 'state') is rewritten when anything changed.
 * Nothing is deleted. Statements stay under D1's 100 KB limit.
 */
export function planImport(accepted, state = emptyState(), { now = Math.floor(Date.now() / 1000) } = {}) {
  const rows = new Map();
  const listed = new Map();
  for (const { run, events: evs } of accepted) {
    const bit = GAME_BITS[run.game_code];
    for (const ev of evs) {
      rows.set(ev.id, eventRow(ev, now));
      listed.set(ev.id, (listed.get(ev.id) ?? 0) | bit);
    }
  }
  const complete = accepted.map((r) => r.run).filter((r) => r.complete);
  const upserts = [];
  const masks = new Map();
  const next = new Map(state.events);
  let inserted = 0;
  for (const id of new Set([...state.events.keys(), ...rows.keys()])) {
    const old = state.events.get(id);
    const row = rows.get(id);
    const startsOn = row ? row.starts_on : old.starts_on;
    const seen = listed.get(id) ?? 0;
    let mask = (old?.game_mask ?? 0) | seen;
    for (const r of complete) {
      const bit = GAME_BITS[r.game_code];
      if (!(seen & bit) && startsOn >= r.window.from && startsOn < r.window.until) mask &= ~bit;
    }
    if (row) {
      row.game_mask = mask;
      if (!old || old.content_hash !== row.content_hash) {
        upserts.push(row);
        if (!old) inserted++;
      } else if (old.game_mask !== mask) masks.set(mask, [...(masks.get(mask) ?? []), id]);
      next.set(id, Object.fromEntries(STATE_EVENT_COLS.map((c) => [c, row[c]])));
    } else if (old.game_mask !== mask) {
      masks.set(mask, [...(masks.get(mask) ?? []), id]);
      next.set(id, { ...old, game_mask: mask });
    }
  }

  const known = new Set(state.imports.map((i) => i.id));
  const newImports = [];
  for (const { run, events: evs } of accepted) {
    if (known.has(importId(run))) continue;
    known.add(importId(run));
    newImports.push({
      id: importId(run),
      game_code: run.game_code,
      source_code: run.source_code,
      fetched_at: run.fetched_at,
      window_from: run.window.from,
      window_until: run.window.until,
      source_total: run.source_total,
      record_count: run.record_count,
      complete: run.complete ? 1 : 0,
      collector_version: run.collector_version,
      query_json: JSON.stringify(run.query),
      notes_json: JSON.stringify(run.notes),
      run_hash: sha1(JSON.stringify([run, evs.map((e) => e.id)])),
      imported_at: now,
    });
  }

  const statements = newImports.map((imp) =>
    `INSERT INTO imports (${IMPORT_COLS.join(', ')}) VALUES (${IMPORT_COLS.map((c) => sqlLiteral(imp[c])).join(', ')})\nON CONFLICT(id) DO NOTHING`);
  const setCols = EVENT_COLS.filter((c) => !['id', 'created_at', 'updated_at'].includes(c));
  // The WHERE keeps a stale diff from rewriting rows that already match.
  statements.push(...chunked(
    `INSERT INTO events (${EVENT_COLS.join(', ')}) VALUES\n`,
    upserts.map((row) => `(${EVENT_COLS.map((c) => sqlLiteral(row[c])).join(', ')})`),
    `\nON CONFLICT(id) DO UPDATE SET\n  ${[...setCols.map((c) => `${c} = excluded.${c}`),
      'updated_at = CASE WHEN events.content_hash = excluded.content_hash THEN events.updated_at ELSE excluded.updated_at END'].join(',\n  ')}\n` +
      'WHERE events.content_hash <> excluded.content_hash OR events.game_mask <> excluded.game_mask',
  ));
  let maskUpdates = 0;
  for (const [mask, ids] of masks) {
    maskUpdates += ids.length;
    statements.push(...chunked(`UPDATE events SET game_mask = ${mask} WHERE id IN (`, ids.map(sqlLiteral), ')'));
  }

  const meta = computeMeta(next, [...state.imports, ...newImports]);
  const changed = statements.length > 0;
  const version = String(now);
  if (changed) {
    const { fetched_at, ...body } = meta;
    statements.push(
      `INSERT INTO site_meta (key, value) VALUES ('meta', ${sqlLiteral(JSON.stringify(body))}), ('state', ${sqlLiteral(JSON.stringify({ version, fetched_at }))})\n` +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
  }
  const stats = {
    inserted,
    rewritten: upserts.length - inserted,
    mask_updates: maskUpdates,
    imports: newImports.length,
    site_meta: changed ? 2 : 0,
    unchanged: rows.size - upserts.length - [...masks.values()].flat().filter((id) => rows.has(id)).length,
  };
  return { statements, stats, meta, version: changed ? version : null, state: { events: next, imports: [...state.imports, ...newImports] } };
}

// D1 counts a written row per table row and per index entry; events has one secondary index.
const EVENT_INDEXES = 1;

/**
 * D1 rows written / read by applying a plan. Writes: an inserted or rewritten event costs the row plus
 * its index entry (upper bound: a rewrite that keeps loc/starts_on may not touch the index), a mask-only
 * update costs the row, imports and site_meta one each. Reads: the state read (one row per existing event
 * and import) plus one primary-key lookup per written row.
 */
export function estimateCost(stats, state) {
  const writes = {
    'events (insert)': stats.inserted * (1 + EVENT_INDEXES),
    'events (rewrite)': stats.rewritten * (1 + EVENT_INDEXES),
    'events (game_mask)': stats.mask_updates,
    imports: stats.imports,
    site_meta: stats.site_meta,
  };
  const stateRead = state.events.size + state.imports.length;
  const lookups = stats.inserted + stats.rewritten + stats.mask_updates + stats.imports + stats.site_meta;
  return {
    writes,
    rowsWritten: Object.values(writes).reduce((a, b) => a + b, 0),
    reads: { 'state read': stateRead, 'primary-key lookups': lookups },
    rowsRead: stateRead + lookups,
  };
}

export const toSqlFile = (statements) => statements.map((s) => `${s};\n`).join('\n');
