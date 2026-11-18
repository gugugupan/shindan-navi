export const API_DIR: string;
export const REPO_DIR: string;
export const CONTRACTS_DIR: string;
export const DEFAULT_DATA_DIR: string;
export const GAME_CODES: string[];
export const GAME_BITS: Record<string, number>;
export const NULL_SORT: number;
export const STATE_EVENT_COLS: string[];
export const STATE_IMPORT_COLS: string[];

export interface GameLoad {
  game: string;
  run: Record<string, any> | null;
  events: Record<string, any>[];
  errors: string[];
  warnings: string[];
}

export interface ImportState {
  events: Map<string, Record<string, any>>;
  imports: Record<string, any>[];
}

export interface PlanStats {
  inserted: number;
  rewritten: number;
  mask_updates: number;
  imports: number;
  site_meta: number;
  unchanged: number;
}

export function loadGame(dataDir: string, game: string): GameLoad;
export function loadAll(dataDir: string, games?: string[]): GameLoad[];
export function eventContent(ev: Record<string, any>): Record<string, any>;
export function locOf(ev: Record<string, any>): string | null;
export function sqlLiteral(v: unknown): string;
export function importId(run: Record<string, any>): string;
export function emptyState(): ImportState;
export function stateFromRows(eventRows: Record<string, any>[], importRows: Record<string, any>[]): ImportState;
export function stateEventsSql(afterId: string | null, pageSize: number): string;
export function stateImportsSql(): string;
export function computeMeta(events: ImportState['events'], imports: Record<string, any>[]): Record<string, any>;
export function planImport(accepted: GameLoad[], state?: ImportState, opts?: { now?: number }): {
  statements: string[];
  stats: PlanStats;
  meta: Record<string, any>;
  version: string | null;
  state: ImportState;
};
export function estimateCost(stats: PlanStats, state: ImportState): {
  writes: Record<string, number>;
  rowsWritten: number;
  reads: Record<string, number>;
  rowsRead: number;
};
export function toSqlFile(statements: string[]): string;
