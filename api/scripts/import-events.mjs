#!/usr/bin/env node
// Import data/events/ into a database built from the root wrangler.jsonc.
//
//   node scripts/import-events.mjs [--data DIR] [--games OPCG,PTCG] [--target wrangler|sqlite|remote]
//                                  [--sqlite FILE] [--out FILE] [--dry-run] [--yes] [--allow-over-free-limit]
//
// wrangler: local D1 (.wrangler/state). sqlite: node:sqlite file for dev-node / tests.
// remote: the production D1. Needs env D1_DATABASE_ID and --yes; without --yes it only prints what it would do.
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { API_DIR, DEFAULT_DATA_DIR, loadAll, buildStatements, toSqlFile, importCounts, estimateRowsWritten } from './lib/importer.mjs';
import { BASE_CONFIG, writeRemoteConfig, remoteConfig } from './remote-config.mjs';

const DB_NAME = 'shindan-navi-events';
// D1 Free: 100,000 rows written per day (UTC); over it every query fails until 00:00 UTC.
const FREE_WRITES_PER_DAY = 100_000;
const { values: opts } = parseArgs({
  options: {
    data: { type: 'string', default: DEFAULT_DATA_DIR },
    games: { type: 'string' },
    target: { type: 'string', default: 'wrangler' },
    sqlite: { type: 'string', default: join(API_DIR, '.local', 'events.sqlite3') },
    out: { type: 'string', default: join(API_DIR, '.local', 'import.sql') },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'allow-over-free-limit': { type: 'boolean', default: false },
  },
});
if (!['wrangler', 'sqlite', 'remote'].includes(opts.target)) {
  console.error(`--target must be wrangler, sqlite or remote`);
  process.exit(2);
}
const remote = opts.target === 'remote';
if (remote) {
  // Fail before the slow part; the id itself is never printed.
  try {
    remoteConfig(process.env.D1_DATABASE_ID);
  } catch (e) {
    console.error(`import: ${e.message}`);
    process.exit(2);
  }
}

const dataDir = resolve(opts.data);
if (!existsSync(dataDir)) {
  console.log(`import: ${dataDir} does not exist; nothing to import`);
  process.exit(0);
}

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
// A remote import with a rejected game would still mark nothing missing for it, but it is almost always a mistake.
if (remote && accepted.length !== results.length) {
  console.error('import: refusing a remote import while a game is rejected; fix the data or pass --games');
  process.exit(1);
}

const statements = buildStatements(accepted);
mkdirSync(dirname(resolve(opts.out)), { recursive: true });
writeFileSync(opts.out, toSqlFile(statements));
console.log(`import: ${statements.length} statements -> ${opts.out} (${(statSync(opts.out).size / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms)`);

const { SqliteD1 } = await import('./lib/sqlite-d1.mjs');

function printWriteEstimate() {
  const schema = new SqliteD1().migrate();
  const counts = importCounts(accepted);
  const est = estimateRowsWritten(counts, schema.indexCounts());
  schema.close();
  console.log(`rows: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  console.log(`D1 rows written (upper bound, incl. index entries): ~${est.total.toLocaleString('en-US')}`);
  for (const [t, n] of Object.entries(est.tables)) console.log(`  ${t.padEnd(18)} ${n.toLocaleString('en-US')}`);
  if (est.total > FREE_WRITES_PER_DAY) {
    console.log(`  exceeds the D1 Free limit of ${FREE_WRITES_PER_DAY.toLocaleString('en-US')} rows written/day: on Free the import fails and D1 rejects every query (the API too) until 00:00 UTC`);
  }
  return est.total;
}

function wrangler(args) {
  // CI=1 makes wrangler skip its interactive confirmations.
  const r = spawnSync('npx', ['wrangler', ...args], { cwd: API_DIR, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (remote) {
  const writes = printWriteEstimate();
  const sqlFile = resolve(opts.out);
  const cmds = [
    ['d1', 'migrations', 'apply', DB_NAME, '--remote', '--config', '<repo>/wrangler.remote.json'],
    ['d1', 'execute', DB_NAME, '--remote', '--yes', '--config', '<repo>/wrangler.remote.json', '--file', sqlFile],
  ];
  const overLimit = writes > FREE_WRITES_PER_DAY && !opts['allow-over-free-limit'];
  if (!opts.yes || opts['dry-run'] || overLimit) {
    console.log('remote import NOT run. It would:');
    for (const c of cmds) console.log(`  npx wrangler ${c.join(' ')}`);
    if (overLimit) console.log('Over the D1 Free daily write limit: pass --allow-over-free-limit as well (Workers Paid, or a load deliberately split by --games).');
    console.log('Re-run with --yes to apply to the production D1.');
    process.exit(opts.yes && overLimit ? 1 : 0);
  }
  const config = writeRemoteConfig(process.env.D1_DATABASE_ID);
  const t1 = Date.now();
  wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote', '--config', config]);
  wrangler(['d1', 'execute', DB_NAME, '--remote', '--yes', '--config', config, '--file', sqlFile]);
  console.log(`import: applied to remote D1 ${DB_NAME} (${Date.now() - t1} ms)`);
} else if (!opts['dry-run']) {
  const t1 = Date.now();
  if (opts.target === 'sqlite') {
    mkdirSync(dirname(resolve(opts.sqlite)), { recursive: true });
    const db = new SqliteD1(opts.sqlite).migrate();
    db.execAll(statements);
    db.close();
    console.log(`import: applied to ${opts.sqlite} (${Date.now() - t1} ms)`);
  } else {
    wrangler(['d1', 'migrations', 'apply', DB_NAME, '--local', '--config', BASE_CONFIG]);
    wrangler(['d1', 'execute', DB_NAME, '--local', '--yes', '--config', BASE_CONFIG, '--file', resolve(opts.out)]);
    console.log(`import: applied to local D1 ${DB_NAME} (${Date.now() - t1} ms)`);
  }
} else {
  printWriteEstimate();
}
process.exit(results.length === accepted.length ? 0 : 1);
