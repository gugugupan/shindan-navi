#!/usr/bin/env node
// Import 話題カレンダー snapshots (data/voices/<date>.json) into D1 (docs/design/voices-db.md).
//
//   node scripts/import-voices.mjs [--data DIR] [--target sqlite|wrangler|remote] [--plan | --yes] [--prune]
//   node scripts/import-voices.mjs --remove-topic ID[,ID…] | --remove-snapshot DATE[,DATE…]  [--target …] [--plan | --yes]
//
// Every run validates the files (contracts/voices.md; samples are skipped, never imported), reads the database's
// rows, checks the resulting timeline and prints per date insert / update / unchanged / delete by content hash.
// Nothing is written without --yes (--plan says so explicitly and cannot be combined with it). A local file with
// topics [] deletes its date; a date in D1 without any local file is kept unless --prune.
// Takedowns start from the rows in D1, remove the topic (from every date that lists it) or the whole date, and with
// --yes write D1 and then apply the same removal to every file in --data that holds it (commit them). A file the
// removal cannot clean (unreadable, or still naming the id) stops the run before anything is written.
//
// sqlite:   node:sqlite file of the Node dev server (api/.local/events.sqlite3). --apply-pending (with --yes) first
//           applies api/migrations-pending/*.sql to that file (local only). Without --yes the file is opened read-only.
// wrangler: local D1 (.wrangler/state) through wrangler --local.
// remote:   the production D1; needs env D1_DATABASE_ID. Never migrates: the voices tables come from
//           api/migrations-pending/0008_voices.sql, applied by the owner. Wrangler's output is captured and every
//           UUID / the id is redacted before it is shown.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { API_DIR, toSqlFile } from './lib/importer.mjs';
import {
  DEFAULT_VOICES_DIR, loadVoices, checkTimeline, planVoices, removeTopics, voicesState, redact, strings,
  VOICES_TABLE_SQL, VOICES_STATE_SQL, VOICES_VERSION_SQL,
} from './lib/voices.mjs';
import { BASE_CONFIG, writeRemoteConfig, remoteConfig } from './remote-config.mjs';

const DB_NAME = 'shindan-navi-events';
const { values: opts } = parseArgs({
  options: {
    data: { type: 'string', default: DEFAULT_VOICES_DIR },
    target: { type: 'string', default: 'wrangler' },
    sqlite: { type: 'string', default: join(API_DIR, '.local', 'events.sqlite3') },
    out: { type: 'string', default: join(API_DIR, '.local', 'import-voices.sql') },
    plan: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    'apply-pending': { type: 'boolean', default: false },
    'remove-topic': { type: 'string' },
    'remove-snapshot': { type: 'string' },
  },
});
const fail = (msg, code = 1) => {
  console.error(`import-voices: ${redact(msg)}`);
  process.exit(code);
};
if (opts.target === 'local') opts.target = 'wrangler';
if (!['wrangler', 'sqlite', 'remote'].includes(opts.target)) fail('--target must be sqlite, wrangler (local) or remote', 2);
if (opts.plan && opts.yes) fail('--plan and --yes contradict each other: --plan never writes, --yes writes', 2);
if (opts['apply-pending'] && opts.target !== 'sqlite') fail('--apply-pending is for --target sqlite only; D1 migrations are applied by the owner', 2);
const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const dropIds = list(opts['remove-topic']);
const dropDates = list(opts['remove-snapshot']);
// An empty value (an unset shell variable) must not fall through to a normal import.
if (opts['remove-topic'] !== undefined && !dropIds.length) fail('--remove-topic names no topic id', 2);
if (opts['remove-snapshot'] !== undefined && !dropDates.length) fail('--remove-snapshot names no date', 2);
if (dropIds.some((id) => !/^[a-z0-9][a-z0-9-]{2,63}$/.test(id))) fail('--remove-topic takes topic ids (a-z, 0-9, -)', 2);
if (dropDates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) fail('--remove-snapshot takes YYYY-MM-DD dates', 2);
const takedown = dropIds.length > 0 || dropDates.length > 0;
// An empty --data (an unset shell variable) would resolve to the current directory.
if (!opts.data.trim()) fail('--data is empty', 2);
// A takedown also cleans --data: a mistyped directory must not let it succeed on D1 alone.
if (takedown && !existsSync(resolve(opts.data))) fail(`${resolve(opts.data)} does not exist (a takedown also removes the topic or date from the local files)`, 2);
// ids are [a-z0-9-], so a match needs no such character on either side (opcg-x is not inside opcg-x-2)
const idIn = (text, id) => new RegExp(`(?<![a-z0-9-])${id}(?![a-z0-9-])`).test(text);
if (takedown && opts.prune) fail('--prune is for imports; a takedown removes only what it names', 2);
if (opts.target === 'remote') {
  try {
    remoteConfig(process.env.D1_DATABASE_ID);
  } catch (e) {
    fail(e.message, 2);
  }
}

// ---- the database
/** Wrangler with its output captured: shown only redacted (it prints the database id). */
function wrangler(args, { show = false } = {}) {
  const r = spawnSync('npx', ['wrangler', ...args], { cwd: API_DIR, env: { ...process.env, CI: '1' }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (show || r.status !== 0) {
    if (r.stdout) process.stdout.write(redact(r.stdout));
    if (r.stderr) process.stderr.write(redact(r.stderr));
  }
  if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(' ')} failed (exit ${r.status ?? 'signal'})`);
  return r.stdout;
}
let sqliteDb = null;
let rawDb = null;
let where;
let config;
let query;
let pendingSoon = false;
if (opts.target === 'sqlite') {
  const file = resolve(opts.sqlite);
  where = opts.sqlite;
  if (opts.yes) {
    const { SqliteD1 } = await import('./lib/sqlite-d1.mjs');
    mkdirSync(dirname(file), { recursive: true });
    sqliteDb = new SqliteD1(file).migrate();
    if (opts['apply-pending']) sqliteDb.migratePending();
    rawDb = sqliteDb.db;
  } else if (existsSync(file)) {
    const { DatabaseSync } = await import('node:sqlite');
    rawDb = new DatabaseSync(file, { readOnly: true });
  }
  query = (sql) => (rawDb ? rawDb.prepare(sql).all().map((r) => ({ ...r })) : []);
  // Plan only: --apply-pending would create the tables with --yes, so plan against an empty database.
  pendingSoon = !opts.yes && opts['apply-pending'];
} else {
  config = opts.target === 'remote' ? writeRemoteConfig(process.env.D1_DATABASE_ID) : BASE_CONFIG;
  const flag = opts.target === 'remote' ? '--remote' : '--local';
  query = (sql) => {
    const out = wrangler(['d1', 'execute', DB_NAME, flag, '--config', config, '--json', '--command', sql]);
    return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
  };
  where = opts.target === 'remote' ? 'remote D1' : 'local D1';
}
let state;
let hasVersion;
try {
  const tables = query(VOICES_TABLE_SQL).map((r) => r.name);
  if (tables.length < 2 && !pendingSoon) {
    fail(`${where} has no voice_snapshots / voice_meta table${rawDb || opts.target !== 'sqlite' ? '' : ' (the file does not exist)'}: migration api/migrations-pending/0008_voices.sql is not applied yet. `
      + (opts.target === 'sqlite' ? 'Pass --apply-pending --yes (local file only).' : 'The owner applies it first (docs/design/voices-db.md › Going live).'));
  }
  state = voicesState(tables.length < 2 ? [] : query(VOICES_STATE_SQL));
  hasVersion = tables.length < 2 ? false : query(VOICES_VERSION_SQL).length > 0;
} catch (e) {
  fail(`reading ${where} failed: ${e.message}`);
}

// ---- desired state
let desired;
const warnings = [];
const errors = [];
let local = null;
const dataDir = resolve(opts.data);
if (takedown) {
  const missing = [...dropIds.filter((id) => ![...state.snapshots.values()].some((s) => s.topics.some((t) => t.id === id))),
    ...dropDates.filter((d) => !state.snapshots.has(d))];
  if (missing.length) warnings.push(`not in ${where}: ${missing.join(', ')}`);
  const kept = removeTopics(state.snapshots, dropIds);
  for (const d of dropDates) if (kept.has(d)) kept.set(d, { ...kept.get(d), topics: [] });
  desired = kept;
} else {
  if (!existsSync(dataDir)) fail(`${dataDir} does not exist`);
  local = loadVoices(dataDir);
  warnings.push(...local.warnings);
  errors.push(...local.errors);
  desired = opts.prune ? new Map(local.snapshots) : new Map([...state.snapshots, ...local.snapshots]);
}
const timeline = checkTimeline([...desired.values()].filter((s) => s.topics.length));
warnings.push(...timeline.warnings);
// A takedown never fails on continuity: what it removes may have been an id's first day.
if (takedown) warnings.push(...timeline.errors);
else errors.push(...timeline.errors);

// Files a takedown changes: every *.json in --data that holds a removed id or date, valid or not. Readable files are
// judged on their decoded JSON (an id written with escapes still matches), others on the raw text. A file the removal
// cannot clean is an error before anything is written.
/** What a file still holds of the takedown: [removed id or date, …] (decoded strings; raw text if not JSON). */
function holds(name, text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return [...dropIds.filter((id) => idIn(text, id)), ...dropDates.filter((d) => name === `${d}.json` || text.includes(d))];
  }
  const vals = [...strings(v)].map(([, x]) => x);
  return [...dropIds.filter((id) => vals.some((x) => idIn(x, id))),
    ...dropDates.filter((d) => name === `${d}.json` || (v && v.date === d))];
}
const fileEdits = [];
if (takedown) {
  for (const f of readdirSync(dataDir).filter((x) => x.endsWith('.json')).sort()) {
    const path = join(dataDir, f);
    const text = readFileSync(path, 'utf8');
    const held = holds(f, text);
    if (!held.length) continue;
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch {}
    if (dropDates.includes(f.replace(/\.json$/, '')) || (raw && dropDates.includes(raw.date))) {
      fileEdits.push({ path, del: true });
      continue;
    }
    if (!raw || !Array.isArray(raw.topics)) {
      errors.push(`${path}: names ${held.join(', ')} but is not a readable snapshot; remove it by hand`);
      continue;
    }
    const topics = raw.topics.filter((t) => !(t && dropIds.includes(t.id)));
    // the last topic gone: the file goes too (an empty newest snapshot would hide the home block in static builds)
    if (!topics.length) {
      fileEdits.push({ path, del: true });
      continue;
    }
    const next = JSON.stringify({ ...raw, topics }, null, 2) + '\n';
    const still = holds(f, next);
    if (still.length) {
      errors.push(`${path}: still names ${still.join(', ')} outside its topics (note?) after removing the topic; edit it by hand`);
      continue;
    }
    fileEdits.push({ path, text: next });
  }
}

for (const w of warnings) console.warn(`warn: ${w}`);
if (errors.length) {
  console.error(`REJECTED (${errors.length} error(s), nothing written):`);
  for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
  sqliteDb?.close();
  process.exit(1);
}

// ---- plan
let plan;
try {
  plan = planVoices(desired, state.current, { prune: opts.prune, hasVersion });
} catch (e) {
  fail(e.message);
}
console.log(`plan against ${where}: ${state.current.size} snapshot(s) in the database${pendingSoon ? ' (tables created by --apply-pending --yes)' : ''}${takedown ? `, takedown ${[...dropIds, ...dropDates].join(', ')}` : `, ${local.snapshots.size} local file(s)`}`);
for (const r of plan.rows) console.log(`  ${r.date}  ${r.action}${r.topics === null ? '' : `  (${r.topics} topics, ${(r.bytes / 1024).toFixed(1)} KB)`}`);
console.log(`  D1 rows written ~${plan.writes} (voice_snapshots + voice_meta version)`);
for (const e of fileEdits) console.log(`  local ${e.del ? 'delete' : 'rewrite'} ${e.path}`);

if (!plan.statements.length && !fileEdits.length) {
  console.log('import-voices: nothing changed');
  sqliteDb?.close();
  process.exit(0);
}
if (!opts.yes) {
  console.log(`import-voices: plan only. Re-run with --yes to write ${where}${fileEdits.length ? ' and the local files' : ''}.`);
  sqliteDb?.close();
  process.exit(0);
}
if (plan.statements.length) {
  if (opts.target === 'sqlite') {
    sqliteDb.execAll(plan.statements);
  } else {
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(opts.out, toSqlFile(plan.statements));
    try {
      wrangler(['d1', 'execute', DB_NAME, opts.target === 'remote' ? '--remote' : '--local', '--yes', '--config', config, '--file', resolve(opts.out)], { show: true });
    } catch (e) {
      fail(`writing ${where} failed: ${e.message}; nothing in --data was changed`);
    }
  }
  console.log(`import-voices: applied to ${where}, voices version ${plan.version}`);
}
for (const e of fileEdits) {
  if (e.del) unlinkSync(e.path);
  else writeFileSync(e.path, e.text);
}
sqliteDb?.close();
// Check the result: no file in --data may still hold what was removed.
if (takedown) {
  const left = readdirSync(dataDir).filter((x) => x.endsWith('.json')).filter((f) => holds(f, readFileSync(join(dataDir, f), 'utf8')).length);
  if (left.length) fail(`takedown incomplete: ${left.join(', ')} in ${dataDir} still hold ${[...dropIds, ...dropDates].join(', ')}; fix by hand before committing`);
}
if (fileEdits.length) console.log(`import-voices: ${fileEdits.length} local file(s) changed; review and commit them`);
