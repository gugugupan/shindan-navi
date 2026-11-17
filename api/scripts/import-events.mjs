#!/usr/bin/env node
// Import data/events/ into the LOCAL database. Never touches a remote D1.
//
//   node scripts/import-events.mjs [--data DIR] [--games OPCG,PTCG] [--target wrangler|sqlite]
//                                  [--sqlite FILE] [--out FILE] [--dry-run]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { API_DIR, DEFAULT_DATA_DIR, loadAll, buildStatements, toSqlFile } from './lib/importer.mjs';

const DB_NAME = 'shindan-navi-events';
const { values: opts } = parseArgs({
  options: {
    data: { type: 'string', default: DEFAULT_DATA_DIR },
    games: { type: 'string' },
    target: { type: 'string', default: 'wrangler' },
    sqlite: { type: 'string', default: join(API_DIR, '.local', 'events.sqlite3') },
    out: { type: 'string', default: join(API_DIR, '.local', 'import.sql') },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!['wrangler', 'sqlite'].includes(opts.target)) {
  console.error(`--target must be wrangler or sqlite`);
  process.exit(2);
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

const statements = buildStatements(accepted);
mkdirSync(dirname(resolve(opts.out)), { recursive: true });
writeFileSync(opts.out, toSqlFile(statements));
console.log(`import: ${statements.length} statements -> ${opts.out} (${Date.now() - t0} ms)`);

if (!opts['dry-run']) {
  const t1 = Date.now();
  if (opts.target === 'sqlite') {
    const { SqliteD1 } = await import('./lib/sqlite-d1.mjs');
    mkdirSync(dirname(resolve(opts.sqlite)), { recursive: true });
    const db = new SqliteD1(opts.sqlite).migrate();
    db.execAll(statements);
    db.close();
    console.log(`import: applied to ${opts.sqlite} (${Date.now() - t1} ms)`);
  } else {
    // CI=1 makes wrangler skip its interactive confirmation; --local keeps everything in .wrangler/state.
    const run = (args) => {
      const r = spawnSync('npx', ['wrangler', ...args], { cwd: API_DIR, stdio: 'inherit', env: { ...process.env, CI: '1' } });
      if (r.status !== 0) process.exit(r.status ?? 1);
    };
    run(['d1', 'migrations', 'apply', DB_NAME, '--local']);
    run(['d1', 'execute', DB_NAME, '--local', '--yes', '--file', resolve(opts.out)]);
    console.log(`import: applied to local D1 ${DB_NAME} (${Date.now() - t1} ms)`);
  }
}
process.exit(results.length === accepted.length ? 0 : 1);
