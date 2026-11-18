// Reads data/events/<GAME>/ (month files + _run.json), validates them against contracts/,
// and turns accepted runs into idempotent SQL for D1 / SQLite.
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

// Groups and venues are keyed by their full content, not by source_id: one source group can carry
// different categories/types per event (PTCG), and a TCG+ venue source_id is an organizer id that
// spans several addresses. Every event therefore gets back exactly the group and venue it was imported with.
export function groupId(ev) {
  const g = ev.group;
  return `${ev.source_code}:${sha1(JSON.stringify([g.source_id, g.name, g.category, g.event_type_code])).slice(0, 20)}`;
}

export function venueId(ev) {
  const v = ev.venue;
  return `${ev.source_code}:${sha1(JSON.stringify([v.name, v.source_id, v.country_code, v.region_code, v.region_name, v.city, v.address, v.postal_code])).slice(0, 20)}`;
}

export const importId = (run) => `${run.game_code}:${run.fetched_at}`;

const EVENT_COLS = [
  'id', 'event_group_id', 'venue_id', 'region_code', 'source_code', 'external_id', 'source_url',
  'name', 'attendance_mode', 'starts_on', 'ends_on', 'starts_at', 'ends_at', 'starts_sort', 'timezone',
  'time_precision', 'format_text', 'eligibility_text', 'capacity', 'fee_amount', 'fee_currency', 'fee_text',
  'registration_method', 'registration_platform', 'registration_url', 'registration_opens_at',
  'registration_closes_at', 'registration_status', 'event_status', 'source_status_text', 'last_seen_at',
  'content_hash', 'created_at', 'updated_at',
];
const MEMBER_COLS = ['event_id', 'game_code', 'last_import_id', 'missing_since', 'created_at'];
const GROUP_COLS = ['id', 'source_code', 'source_id', 'name', 'category', 'event_type_code', 'content_hash', 'created_at', 'updated_at'];
const VENUE_COLS = ['id', 'source_code', 'source_id', 'name', 'country_code', 'region_code', 'region_name', 'city', 'address', 'postal_code', 'content_hash', 'created_at', 'updated_at'];
const IMPORT_COLS = ['id', 'game_code', 'source_code', 'fetched_at', 'window_from', 'window_until', 'source_total', 'record_count', 'complete', 'collector_version', 'query_json', 'notes_json', 'run_hash', 'imported_at'];

/** Event content minus the fields that legitimately differ between copies (game file, run time). */
export function eventContent(ev) {
  const { last_seen_at, game_code, ...content } = ev;
  return content;
}

function eventRow(ev, now) {
  return {
    id: ev.id,
    event_group_id: groupId(ev),
    venue_id: ev.venue ? venueId(ev) : null,
    region_code: ev.venue?.region_code ?? null,
    source_code: ev.source_code,
    external_id: ev.external_id,
    source_url: ev.source_url,
    name: ev.name,
    attendance_mode: ev.attendance_mode,
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
    last_seen_at: ev.last_seen_at,
    // last_seen_at changes every run, so it is left out: updated_at only moves on real changes.
    content_hash: sha1(JSON.stringify(eventContent(ev))),
    created_at: now,
    updated_at: now,
  };
}

function upsertStatements(table, cols, rows, updateCols, conflict = 'id', tracksContent = true) {
  const head = `INSERT INTO ${table} (${cols.join(', ')}) VALUES\n`;
  const tail = `\nON CONFLICT(${conflict}) DO UPDATE SET\n  ${[
    ...updateCols.map((c) => `${c} = excluded.${c}`),
    ...(tracksContent ? [`updated_at = CASE WHEN ${table}.content_hash = excluded.content_hash THEN ${table}.updated_at ELSE excluded.updated_at END`] : []),
  ].join(',\n  ')}`;
  const out = [];
  let batch = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length) out.push(head + batch.join(',\n') + tail);
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    const values = `(${cols.map((c) => sqlLiteral(row[c])).join(', ')})`;
    if (batch.length && (bytes + values.length > MAX_STATEMENT_BYTES || batch.length >= MAX_ROWS_PER_STATEMENT)) flush();
    batch.push(values);
    bytes += values.length;
  }
  flush();
  return out;
}

/**
 * SQL statements (without trailing semicolons) that load the accepted games.
 * Upserts by id. An event listed under several games is stored once with one event_games row per
 * game. A complete run marks only its own game's memberships inside its window as missing when the
 * run no longer lists them; events with no remaining membership drop out of the API. Nothing is deleted.
 */
export function buildStatements(accepted, { now = Math.floor(Date.now() / 1000) } = {}) {
  const imports = [];
  const groups = new Map();
  const venues = new Map();
  const events = new Map();
  const members = [];
  for (const { run, events: evs } of accepted) {
    imports.push({
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
    for (const ev of evs) {
      const g = ev.group;
      groups.set(groupId(ev), {
        id: groupId(ev),
        source_code: ev.source_code,
        source_id: g.source_id,
        name: g.name,
        category: g.category,
        event_type_code: g.event_type_code,
        content_hash: sha1(JSON.stringify(g)),
        created_at: now,
        updated_at: now,
      });
      if (ev.venue) {
        const v = ev.venue;
        venues.set(venueId(ev), { id: venueId(ev), source_code: ev.source_code, ...v, content_hash: sha1(JSON.stringify(v)), created_at: now, updated_at: now });
      }
      events.set(ev.id, eventRow(ev, now));
      members.push({ event_id: ev.id, game_code: ev.game_code, last_import_id: importId(run), missing_since: null, created_at: now });
    }
  }
  const nonKey = (cols) => cols.filter((c) => !['id', 'created_at', 'updated_at'].includes(c));
  const statements = [];
  for (const imp of imports) {
    statements.push(
      `INSERT INTO imports (${IMPORT_COLS.join(', ')}) VALUES (${IMPORT_COLS.map((c) => sqlLiteral(imp[c])).join(', ')})\n` +
        `ON CONFLICT(id) DO UPDATE SET ${nonKey(IMPORT_COLS).map((c) => `${c} = excluded.${c}`).join(', ')}`,
    );
  }
  statements.push(...upsertStatements('venues', VENUE_COLS, [...venues.values()], nonKey(VENUE_COLS)));
  statements.push(...upsertStatements('event_groups', GROUP_COLS, [...groups.values()], nonKey(GROUP_COLS)));
  statements.push(...upsertStatements('events', EVENT_COLS, [...events.values()], nonKey(EVENT_COLS)));
  statements.push(...upsertStatements('event_games', MEMBER_COLS, members, ['last_import_id', 'missing_since'], 'event_id, game_code', false));
  for (const { run } of accepted) {
    if (!run.complete) continue;
    statements.push(
      `UPDATE event_games SET missing_since = ${sqlLiteral(run.fetched_at)}\n` +
        `WHERE game_code = ${sqlLiteral(run.game_code)} AND last_import_id <> ${sqlLiteral(importId(run))} AND missing_since IS NULL\n` +
        `  AND event_id IN (SELECT id FROM events WHERE starts_on >= ${sqlLiteral(run.window.from)} AND starts_on < ${sqlLiteral(run.window.until)})`,
    );
  }
  // Only rows whose value changes are written: D1 bills rows written, and most events keep their games.
  const visibleGames = `(SELECT group_concat(game_code, ',') FROM\n` +
    `  (SELECT game_code FROM event_games WHERE event_id = events.id AND missing_since IS NULL ORDER BY game_code))`;
  statements.push(`UPDATE events SET game_codes = ${visibleGames}\nWHERE game_codes IS NOT ${visibleGames}`);
  return statements;
}

/** Distinct rows the import upserts per table (shared events count once in events). */
export function importCounts(accepted) {
  const ids = { events: new Set(), venues: new Set(), event_groups: new Set() };
  let members = 0;
  for (const { events: evs } of accepted) {
    for (const ev of evs) {
      ids.events.add(ev.id);
      ids.event_groups.add(groupId(ev));
      if (ev.venue) ids.venues.add(venueId(ev));
      members++;
    }
  }
  return { imports: accepted.length, venues: ids.venues.size, event_groups: ids.event_groups.size, events: ids.events.size, event_games: members };
}

/**
 * Upper bound of D1 "rows written" for one import: every upserted row counts once plus once per index on
 * its table (the upserts SET every indexed column), plus one per event for game_codes (true on an empty
 * database; a re-import only writes events whose games changed). Missing-marks are not counted.
 * indexCounts: { table: number of indexes incl. PRIMARY KEY / UNIQUE autoindexes }.
 */
export function estimateRowsWritten(counts, indexCounts) {
  const tables = {};
  for (const t of ['imports', 'venues', 'event_groups', 'events', 'event_games']) {
    tables[t] = counts[t] * (1 + (indexCounts[t] ?? 0));
  }
  tables['events.game_codes'] = counts.events;
  return { tables, total: Object.values(tables).reduce((a, b) => a + b, 0) };
}

export const toSqlFile = (statements) => statements.map((s) => `${s};\n`).join('\n');
