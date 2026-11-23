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
  siteMeta: Record<string, string>;
  dayCounts: Map<string, number>;
  /** content_hash per `${game}\t${loc}`; null while landing_pages does not exist. */
  landing: Map<string, string> | null;
}

export interface GamePlan {
  fetched_at: string;
  source_total: number | null;
  record_count: number;
  complete: boolean;
  inserted: number;
  rewritten: number;
  unchanged: number;
  hidden: number;
  in_db: number;
}

export interface PlanStats {
  inserted: number;
  rewritten: number;
  mask_updates: number;
  imports: number;
  day_counts: number;
  site_meta: number;
  landing_pages: number;
  unchanged: number;
}

export function loadGame(dataDir: string, game: string): GameLoad;
export function loadAll(dataDir: string, games?: string[]): GameLoad[];
export function eventContent(ev: Record<string, any>): Record<string, any>;
export function withoutExpiredGeo(ev: Record<string, any>, cutoff: string): Record<string, any>;
export function locOf(ev: Record<string, any>): string | null;
export function sqlLiteral(v: unknown): string;
export function importId(run: Record<string, any>): string;
export function emptyState(opts?: { landing?: boolean }): ImportState;
export function stateFromRows(eventRows: Record<string, any>[], importRows: Record<string, any>[], siteMetaRows?: Record<string, any>[], dayCountRows?: Record<string, any>[], landingRows?: Record<string, any>[] | null): ImportState;
export function stateLandingSql(): string;
export const LANDING_MISSING: string;
export const LANDING_DAYS: number;
export const LANDING_PER_DAY: number;
export const MAX_LANDING_BYTES: number;
export const LANDING_LOCS: string[];
export function jstDay(sec: number): string;
export function landingEvent(ev: Record<string, any>, codes: string[] | null, loc: string): Record<string, any>;
export function landingRows(run: Record<string, any>, events: Record<string, any>[], builtOn: string, codesOf?: (id: string) => string[] | null, shown?: Iterable<Record<string, any>> | null): Record<string, any>[];
export function readLandingState(query: (sql: string) => Record<string, any>[]): Record<string, any>[] | null;
export function stateSiteMetaSql(): string;
export function stateDayCountsSql(): string;
export function computeDayCounts(events: ImportState['events']): Map<string, number>;
export const MAX_STATEMENT_BYTES: number;
export const MAX_SITE_META_BYTES: number;
export function stateEventsSql(afterId: string | null, pageSize: number): string;
export function stateImportsSql(): string;
export function computeMeta(events: ImportState['events'], imports: Record<string, any>[]): Record<string, any>;
export function planImport(accepted: GameLoad[], state?: ImportState, opts?: { now?: number; maxSiteMetaBytes?: number }): {
  statements: string[];
  stats: PlanStats;
  perGame: Record<string, GamePlan>;
  meta: Record<string, any>;
  notes: string[];
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
