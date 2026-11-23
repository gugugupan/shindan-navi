import type { DatabaseSync } from 'node:sqlite';

export const PENDING_MIGRATIONS_DIR: string;

export class SqliteD1 {
  constructor(path?: string);
  db: DatabaseSync;
  prepare(sql: string): unknown;
  batch(statements: unknown[]): Promise<unknown[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  execAll(statements: string[]): void;
  migrate(dir?: string, opts?: { pending?: boolean }): this;
  readState(opts?: { landingFrom?: string }): import('./importer.mjs').ImportState;
  close(): void;
}
