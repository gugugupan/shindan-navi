#!/usr/bin/env node
// Import 話題カレンダー snapshots (data/voices/<date>.json) into D1 (docs/design/voices-db.md).
//
//   node scripts/import-voices.mjs [--data DIR] [--target sqlite|wrangler|remote] [--plan] [--yes] [--prune]
//   node scripts/import-voices.mjs --remove-topic ID[,ID…] | --remove-snapshot DATE[,DATE…]  [--target …] [--yes]
//
// Every run validates the files (contracts/voices.md; samples are skipped, never imported), reads the database's
// rows, checks the resulting timeline and prints per date insert / update / unchanged / delete by content hash.
// Nothing is written without --yes. A date in D1 without a local file is kept unless --prune.
// Takedowns start from the rows in D1, remove the topic (from every date that lists it) or the whole date, and with
// --yes write D1 and then apply the same removal to the files in --data (commit them).
//
// sqlite:   node:sqlite file of the Node dev server (api/.local/events.sqlite3). --apply-pending first applies
//           api/migrations-pending/*.sql to that file (local only).
// wrangler: local D1 (.wrangler/state) through wrangler --local.
// remote:   the production D1; needs env D1_DATABASE_ID (never printed). Never migrates: the voices tables come from
//           api/migrations-pending/0008_voices.sql, applied by the owner.
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { API_DIR, toSqlFile } from './lib/importer.mjs';
import {
  DEFAULT_VOICES_DIR, loadVoices, checkTimeline, planVoices, removeTopics, voicesState,
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
  console.error(`import-voices: ${msg}`);
  process.exit(code);
};
if (opts.target === 'local') opts.target = 'wrangler';
if (!['wrangler', 'sqlite', 'remote'].includes(opts.target)) fail('--target must be sqlite, wrangler (local) or remote', 2);
if (opts['apply-pending'] && opts.target !== 'sqlite') fail('--apply-pending is for --target sqlite only; D1 migrations are applied by the owner', 2);
const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const dropIds = list(opts['remove-topic']);
const dropDates = list(opts['remove-snapshot']);
const takedown = dropIds.length > 0 || dropDates.length > 0;
if (takedown && opts.prune) fail('--prune is for imports; a takedown removes only what it names', 2);
if (dropDates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) fail('--remove-snapshot takes YYYY-MM-DD dates', 2);
if (opts.target === 'remote') {
  try {
    remoteConfig(process.env.D1_DATABASE_ID);
  } catch (e) {
    fail(e.message, 2);
  }
}

// ---- the database
function wrangler(args, capture = false) {
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd: API_DIR, env: { ...process.env, CI: '1' }, ...(capture ? { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 } : { stdio: 'inherit' }),
  });
  if (r.status !== 0) {
    if (capture) throw new Error((r.stderr || r.stdout || '').trim());
    process.exit(r.status ?? 1);
  }
  return r.stdout;
}
let sqliteDb = null;
let where;
let config;
let query;
if (opts.target === 'sqlite') {
  const { SqliteD1 } = await import('./lib/sqlite-d1.mjs');
  mkdirSync(dirname(resolve(opts.sqlite)), { recursive: true });
  sqliteDb = new SqliteD1(opts.sqlite).migrate();
  if (opts['apply-pending']) sqliteDb.migratePending();
  query = (sql) => sqliteDb.db.prepare(sql).all();
  where = opts.sqlite;
} else {
  config = opts.target === 'remote' ? writeRemoteConfig(process.env.D1_DATABASE_ID) : BASE_CONFIG;
  const flag = opts.target === 'remote' ? '--remote' : '--local';
  query = (sql) => {
    const out = wrangler(['d1', 'execute', DB_NAME, flag, '--config', config, '--json', '--command', sql], true);
    return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
  };
  where = opts.target === 'remote' ? 'remote D1' : 'local D1';
}
const tables = query(VOICES_TABLE_SQL).map((r) => r.name);
if (tables.length < 2) {
  fail(`${where} has no voice_snapshots / voice_meta table: migration api/migrations-pending/0008_voices.sql is not applied yet. `
    + (opts.target === 'sqlite' ? 'Pass --apply-pending (local file only).' : 'The owner applies it first (docs/design/voices-db.md › Going live).'));
}
const state = voicesState(query(VOICES_STATE_SQL));
const hasVersion = query(VOICES_VERSION_SQL).length > 0;

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
  desired = removeTopics(new Map([...state.snapshots].filter(([d]) => !dropDates.includes(d))), dropIds);
} else {
  if (!existsSync(dataDir)) fail(`${dataDir} does not exist`);
  local = loadVoices(dataDir);
  warnings.push(...local.warnings);
  errors.push(...local.errors);
  desired = opts.prune ? new Map(local.snapshots) : new Map([...state.snapshots, ...local.snapshots]);
}
const timeline = checkTimeline(desired.values());
warnings.push(...timeline.warnings);
// A takedown never fails on continuity: what it removes may have been an id's first day.
if (takedown) warnings.push(...timeline.errors);
else errors.push(...timeline.errors);
for (const w of warnings) console.warn(`warn: ${w}`);
if (errors.length) {
  console.error(`REJECTED (${errors.length} error(s), nothing imported):`);
  for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
  sqliteDb?.close();
  process.exit(1);
}

// ---- plan
let plan;
try {
  plan = planVoices(desired, state.current, { prune: opts.prune || takedown, hasVersion });
} catch (e) {
  fail(e.message);
}
console.log(`plan against ${where}: ${state.current.size} snapshot(s) in the database${takedown ? `, takedown ${[...dropIds, ...dropDates].join(', ')}` : `, ${local.snapshots.size} local file(s)`}`);
for (const r of plan.rows) console.log(`  ${r.date}  ${r.action}${r.topics === null ? '' : `  (${r.topics} topics, ${(r.bytes / 1024).toFixed(1)} KB)`}`);
console.log(`  D1 rows written ~${plan.writes} (voice_snapshots + voice_meta version)`);

// Files a takedown rewrites after D1: the same removal applied to --data.
const fileEdits = [];
if (takedown && existsSync(dataDir)) {
  const files = loadVoices(dataDir).files;
  for (const [d, f] of files) {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (dropDates.includes(d)) fileEdits.push({ f, del: true });
    else if (raw.topics.some((t) => dropIds.includes(t.id))) {
      const topics = raw.topics.filter((t) => !dropIds.includes(t.id));
      fileEdits.push(topics.length ? { f, text: JSON.stringify({ ...raw, topics }, null, 2) + '\n' } : { f, del: true });
    }
  }
  for (const e of fileEdits) console.log(`  local ${e.del ? 'delete' : 'rewrite'} ${e.f}`);
}

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
    wrangler(['d1', 'execute', DB_NAME, opts.target === 'remote' ? '--remote' : '--local', '--yes', '--config', config, '--file', resolve(opts.out)]);
  }
  console.log(`import-voices: applied to ${where}, voices version ${plan.version}`);
}
for (const e of fileEdits) {
  if (e.del) unlinkSync(e.f);
  else writeFileSync(e.f, e.text);
}
if (fileEdits.length) console.log(`import-voices: ${fileEdits.length} local file(s) changed; review and commit them`);
sqliteDb?.close();
