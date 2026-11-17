export const API_DIR: string;
export const REPO_DIR: string;
export const CONTRACTS_DIR: string;
export const DEFAULT_DATA_DIR: string;
export const GAME_CODES: string[];
export const NULL_SORT: number;

export interface GameLoad {
  game: string;
  run: Record<string, any> | null;
  events: Record<string, any>[];
  errors: string[];
  warnings: string[];
}

export function loadGame(dataDir: string, game: string): GameLoad;
export function loadAll(dataDir: string, games?: string[]): GameLoad[];
export function sqlLiteral(v: unknown): string;
export function groupId(ev: Record<string, any>): string;
export function venueId(ev: Record<string, any>): string;
export function importId(run: Record<string, any>): string;
export function buildStatements(accepted: GameLoad[], opts?: { now?: number }): string[];
export function toSqlFile(statements: string[]): string;
