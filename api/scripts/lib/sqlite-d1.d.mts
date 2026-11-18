import type { DatabaseSync } from 'node:sqlite';

export class SqliteD1 {
  constructor(path?: string);
  db: DatabaseSync;
  prepare(sql: string): unknown;
  batch(statements: unknown[]): Promise<unknown[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  execAll(statements: string[]): void;
  migrate(): this;
  readState(): import('./importer.mjs').ImportState;
  close(): void;
}
