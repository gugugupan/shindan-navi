// Minimal D1Database stand-in over node:sqlite, for tests and the Node dev server on machines
// where workerd cannot run (macOS < 13.5).
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_DIR, stateDayCountsSql, stateEventsSql, stateFromRows, stateImportsSql, stateSiteMetaSql } from './importer.mjs';

const MIGRATIONS_DIR = join(API_DIR, 'migrations');

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }
  _all() {
    return this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r }));
  }
  _run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async all() {
    return { success: true, results: this._all(), meta: {} };
  }
  async first(col) {
    const row = this._all()[0] ?? null;
    return col === undefined || row === null ? row : row[col];
  }
  async run() {
    return this._run();
  }
  async raw() {
    return this._all().map((r) => Object.values(r));
  }
}

export class SqliteD1 {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => (/^\s*(select|with)\b/i.test(s.sql) ? { success: true, results: s._all(), meta: {} } : s._run()));
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
  /** Run statements in one transaction (the importer's SQL). */
  execAll(statements) {
    this.db.exec('BEGIN');
    try {
      for (const s of statements) this.db.exec(s);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  /** Apply migrations/*.sql not yet recorded, using the same table name as wrangler. */
  migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    const done = new Set(this.db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
    for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      this.execAll([readFileSync(join(MIGRATIONS_DIR, name), 'utf8'), `INSERT INTO d1_migrations (name) VALUES ('${name.replaceAll("'", "''")}')`]);
    }
    return this;
  }
  /** The importer's view of this database (see importer.mjs stateFromRows). */
  readState() {
    const events = [];
    for (let after = null; ; ) {
      const page = this.db.prepare(stateEventsSql(after, 5000)).all();
      events.push(...page);
      if (page.length < 5000) break;
      after = page[page.length - 1].id;
    }
    return stateFromRows(events, this.db.prepare(stateImportsSql()).all(), this.db.prepare(stateSiteMetaSql()).all(), this.db.prepare(stateDayCountsSql()).all());
  }
  close() {
    this.db.close();
  }
}
