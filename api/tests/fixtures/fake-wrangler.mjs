// Stand-in for `wrangler d1 …` in tests/import-wrangler.test.ts: runs the importer's commands on the SQLite file in
// FAKE_D1 and, like wrangler, prints warnings on stderr and errors as JSON on stdout (exit 1).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const db = new DatabaseSync(process.env.FAKE_D1);
console.error('▲ [WARNING] fake wrangler: a warning on stderr');
const opt = (k) => args[args.indexOf(k) + 1];
if (args[1] === 'migrations') process.exit(0);
try {
  if (args.includes('--file')) {
    db.exec(readFileSync(opt('--file'), 'utf8'));
    console.log('[{"results":[],"success":true}]');
  } else {
    const rows = db.prepare(opt('--command')).all().map((r) => ({ ...r }));
    console.log(JSON.stringify([{ results: rows, success: true }]));
  }
} catch (e) {
  console.log(JSON.stringify({ error: { text: `${e.message}: SQLITE_ERROR` } }));
  process.exit(1);
}
