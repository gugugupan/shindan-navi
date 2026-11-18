#!/usr/bin/env node
// Import data/events/ into a database built from the root wrangler.jsonc. The importer reads the
// database's current rows, diffs, and writes only what changed (see lib/importer.mjs planImport).
//
//   node scripts/import-events.mjs [--data DIR] [--games OPCG,PTCG] [--target sqlite|wrangler|remote]
//                                  [--sqlite FILE] [--out FILE] [--dry-run] [--plan] [--yes] [--max-writes N]
//
// sqlite:   node:sqlite file for dev-node / tests (always applied unless --dry-run).
// wrangler: local D1 (.wrangler/state) through wrangler --local.
// remote:   the production D1. Needs env D1_DATABASE_ID. Without flags: validate and estimate against an
//           empty database (first-import cost), no remote call. --plan: also read the remote rows and print
//           the exact plan. --yes: migrate, read, plan and apply when the plan writes at most --max-writes rows.
//           --plan / --yes require the data directory to be committed in git.
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  API_DIR, DEFAULT_DATA_DIR, loadAll, planImport, toSqlFile, estimateCost, emptyState, stateFromRows, stateEventsSql, stateImportsSql,
} from './lib/importer.mjs';
import { BASE_CONFIG, writeRemoteConfig, remoteConfig } from './remote-config.mjs';

const DB_NAME = 'shindan-navi-events';
// D1 Free: 100,000 rows written and 5,000,000 rows read per day (UTC); past either, every query fails until 00:00 UTC.
const FREE_WRITES_PER_DAY = 100_000;
const STATE_PAGE = 5000;
const { values: opts } = parseArgs({
  options: {
    data: { type: 'string', default: DEFAULT_DATA_DIR },
    games: { type: 'string' },
    target: { type: 'string', default: 'wrangler' },
    sqlite: { type: 'string', default: join(API_DIR, '.local', 'events.sqlite3') },
    out: { type: 'string', default: join(API_DIR, '.local', 'import.sql') },
    'dry-run': { type: 'boolean', default: false },
    plan: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'max-writes': { type: 'string', default: '90000' },
  },
});
const fail = (msg, code = 1) => {
  console.error(`import: ${msg}`);
  process.exit(code);
};
if (!['wrangler', 'sqlite', 'remote'].includes(opts.target)) fail('--target must be sqlite, wrangler or remote', 2);
const maxWrites = Number(opts['max-writes']);
if (!Number.isInteger(maxWrites) || maxWrites < 0) fail('--max-writes must be a non-negative integer', 2);
const remote = opts.target === 'remote';
const readRemote = remote && (opts.plan || opts.yes);
if (remote) {
  // Fail before the slow part; the id itself is never printed.
  try {
    remoteConfig(process.env.D1_DATABASE_ID);
  } catch (e) {
    fail(e.message, 2);
  }
}

const dataDir = resolve(opts.data);
if (!existsSync(dataDir)) {
  console.log(`import: ${dataDir} does not exist; nothing to import`);
  process.exit(0);
}

/** The production database only takes data that is reviewed and committed: tracked and clean in git. */
function requireCommitted(dir) {
  const git = (...args) => spawnSync('git', ['-C', dirname(dir), ...args], { encoding: 'utf8' });
  const name = basename(dir);
  const tracked = git('ls-files', '--', name);
  if (tracked.status !== 0) fail(`${dir} is not inside a git checkout`);
  if (!tracked.stdout.trim()) fail(`${dir} has no committed files (an untracked directory or symlink?); commit the reviewed data first`);
  const dirty = git('status', '--porcelain', '--untracked-files=all', '--', name);
  if (dirty.stdout.trim()) fail(`${dir} has uncommitted changes; commit the reviewed data first:\n${dirty.stdout}`);
  const head = git('log', '-1', '--format=%h %s', '--', name).stdout.trim();
  console.log(`data: committed (${head})`);
}
if (readRemote) requireCommitted(dataDir);

const t0 = Date.now();
const results = loadAll(dataDir, opts.games?.split(',').map((s) => s.trim()).filter(Boolean));
const accepted = [];
for (const r of results) {
  for (const w of r.warnings) console.warn(`warn: ${w}`);
  if (r.errors.length) {
    console.error(`REJECTED ${r.game} (${r.errors.length} error(s), nothing imported for this game):`);
    for (const e of r.errors) console.error(`  - ${e}`);
  } else {
    accepted.push(r);
    console.log(`ok ${r.game}: ${r.events.length} events, fetched_at ${r.run.fetched_at}, window ${r.run.window.from}..${r.run.window.until}, complete=${r.run.complete}`);
  }
}
if (!accepted.length) {
  console.log('import: no accepted games');
  process.exit(results.length ? 1 : 0);
}
if (remote && accepted.length !== results.length) fail('refusing a remote import while a game is rejected; fix the data or pass --games');

function wrangler(args, capture = false) {
  // CI=1 makes wrangler skip its interactive confirmations.
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd: API_DIR, env: { ...process.env, CI: '1' }, ...(capture ? { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 } : { stdio: 'inherit' }),
  });
  if (r.status !== 0) {
    if (capture) throw new Error((r.stderr || r.stdout || '').trim());
    process.exit(r.status ?? 1);
  }
  return r.stdout;
}

function wranglerQuery(where, config, sql) {
  const out = wrangler(['d1', 'execute', DB_NAME, where, '--config', config, '--json', '--command', sql], true);
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}

function readWranglerState(where, config) {
  try {
    const events = [];
    for (let after = null; ; ) {
      const page = wranglerQuery(where, config, stateEventsSql(after, STATE_PAGE));
      events.push(...page);
      if (page.length < STATE_PAGE) break;
      after = page[page.length - 1].id;
    }
    return stateFromRows(events, wranglerQuery(where, config, stateImportsSql()));
  } catch (e) {
    if (/no such table/.test(e.message)) return emptyState();
    throw e;
  }
}

const { SqliteD1 } = await import('./lib/sqlite-d1.mjs');
let state;
let sqliteDb = null;
let config = null;
let stateLabel;
if (opts.target === 'sqlite') {
  mkdirSync(dirname(resolve(opts.sqlite)), { recursive: true });
  sqliteDb = new SqliteD1(opts.sqlite).migrate();
  state = sqliteDb.readState();
  stateLabel = opts.sqlite;
} else if (opts.target === 'wrangler') {
  if (!opts['dry-run']) wrangler(['d1', 'migrations', 'apply', DB_NAME, '--local', '--config', BASE_CONFIG]);
  state = opts['dry-run'] ? emptyState() : readWranglerState('--local', BASE_CONFIG);
  stateLabel = opts['dry-run'] ? 'empty database (dry run)' : 'local D1';
} else if (readRemote) {
  config = writeRemoteConfig(process.env.D1_DATABASE_ID);
  if (opts.yes && !opts['dry-run']) wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote', '--config', config]);
  state = readWranglerState('--remote', config);
  stateLabel = 'remote D1';
} else {
  state = emptyState();
  stateLabel = 'empty database (first import; --plan reads the remote rows)';
}

const plan = planImport(accepted, state);
const cost = estimateCost(plan.stats, state);
console.log(`plan against ${stateLabel}: ${state.events.size} existing events`);
console.log(`  ${Object.entries(plan.stats).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  D1 rows written ~${cost.rowsWritten.toLocaleString('en-US')} (${Object.entries(cost.writes).filter(([, n]) => n).map(([k, n]) => `${k} ${n.toLocaleString('en-US')}`).join(', ') || 'nothing'})`);
console.log(`  D1 rows read    ~${cost.rowsRead.toLocaleString('en-US')} (${Object.entries(cost.reads).map(([k, n]) => `${k} ${n.toLocaleString('en-US')}`).join(', ')})`);
if (cost.rowsWritten > FREE_WRITES_PER_DAY) console.log(`  over the D1 Free limit of ${FREE_WRITES_PER_DAY.toLocaleString('en-US')} rows written/day: split with --games across UTC days`);

if (!plan.statements.length) {
  console.log('import: nothing changed');
  sqliteDb?.close();
  process.exit(results.length === accepted.length ? 0 : 1);
}
mkdirSync(dirname(resolve(opts.out)), { recursive: true });
writeFileSync(opts.out, toSqlFile(plan.statements));
console.log(`import: ${plan.statements.length} statements -> ${opts.out} (${(statSync(opts.out).size / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms)`);
const sqlFile = resolve(opts.out);

if (opts['dry-run']) {
  sqliteDb?.close();
  process.exit(results.length === accepted.length ? 0 : 1);
}
const t1 = Date.now();
if (opts.target === 'sqlite') {
  sqliteDb.execAll(plan.statements);
  sqliteDb.close();
  console.log(`import: applied to ${opts.sqlite} (${Date.now() - t1} ms)`);
} else if (opts.target === 'wrangler') {
  wrangler(['d1', 'execute', DB_NAME, '--local', '--yes', '--config', BASE_CONFIG, '--file', sqlFile]);
  console.log(`import: applied to local D1 ${DB_NAME} (${Date.now() - t1} ms)`);
} else {
  const over = cost.rowsWritten > maxWrites;
  if (!opts.yes || over) {
    console.log('remote import NOT applied. It would run:');
    console.log(`  npx wrangler d1 migrations apply ${DB_NAME} --remote --config <repo>/wrangler.remote.json`);
    console.log(`  npx wrangler d1 execute ${DB_NAME} --remote --yes --config <repo>/wrangler.remote.json --file ${sqlFile}`);
    if (over) console.log(`The plan writes more than --max-writes ${maxWrites.toLocaleString('en-US')} rows: import fewer games per UTC day (--games), or raise --max-writes knowingly.`);
    else console.log('Re-run with --yes to apply to the production D1.');
    process.exit(opts.yes && over ? 1 : 0);
  }
  wrangler(['d1', 'execute', DB_NAME, '--remote', '--yes', '--config', config, '--file', sqlFile]);
  console.log(`import: applied to remote D1 ${DB_NAME}, data version ${plan.version} (${Date.now() - t1} ms)`);
}
process.exit(results.length === accepted.length ? 0 : 1);
