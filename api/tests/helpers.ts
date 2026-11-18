import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/index';
import { loadAll, planImport, REPO_DIR } from '../scripts/lib/importer.mjs';
import { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';

export type Ev = Record<string, any>;
export const WINDOW = { from: '2026-11-18', until: '2027-02-18' };

export const sampleEvents = (): Ev[] =>
  JSON.parse(readFileSync(join(REPO_DIR, 'contracts/fixtures/sample-events.json'), 'utf8'));

export const SOURCE: Record<string, string> = { OPCG: 'bandai_tcg_plus', UATCG: 'bandai_tcg_plus', CONAN: 'conan_official', PTCG: 'pokemon_players' };
const PREFIX: Record<string, string> = { bandai_tcg_plus: 'tcgp', pokemon_players: 'ptcg', conan_official: 'conan' };

export function run(game: string, count: number, extra: Ev = {}): Ev {
  return {
    game_code: game,
    source_code: SOURCE[game],
    fetched_at: '2026-11-18T00:00:00Z',
    window: WINDOW,
    query: {},
    source_total: count,
    record_count: count,
    complete: true,
    collector_version: 'test',
    notes: [],
    ...extra,
  };
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** SYNTHETIC events for tests only; every name starts with 【SYNTHETIC】. */
export function synthetic(n: number, seed = 0): Ev[] {
  const games = ['OPCG', 'UATCG', 'CONAN', 'PTCG'];
  const prefs = [['JP-13', '東京都'], ['JP-14', '神奈川県'], ['JP-27', '大阪府'], ['JP-40', '福岡県']];
  const cats = ['tournament', 'casual', 'teaching', 'festival', 'other', 'unknown'];
  const types = ['standard_battle', 'meetup', null];
  const regs = ['open', 'unknown', 'closed', 'not_open', 'waitlist'];
  const fees = [0, 500, null];
  const out: Ev[] = [];
  for (let i = 0; i < n; i++) {
    const k = i + seed;
    const game = games[k % 4];
    const ext = `syn${String(k).padStart(6, '0')}`;
    const startsOn = addDays(WINDOW.from, (k * 7) % 92);
    const online = k % 11 === 0;
    const timed = k % 3 !== 0;
    // Group and venue fields depend only on their keys, so shared source_ids never disagree.
    const gk = k % 5;
    const vk = k % 9;
    const [pref, prefName] = prefs[vk % prefs.length];
    const fee = fees[k % 3];
    out.push({
      id: `${PREFIX[SOURCE[game]]}:${ext}`,
      game_code: game,
      source_code: SOURCE[game],
      external_id: ext,
      source_url: `https://example.invalid/synthetic/${ext}`,
      group: { source_id: gk % 2 ? `g${gk}` : null, name: `【SYNTHETIC】group ${gk}`, category: cats[gk], event_type_code: types[gk % 3] },
      name: `【SYNTHETIC】event ${k}`,
      attendance_mode: online ? 'online' : k % 13 === 0 ? 'hybrid' : 'in_person',
      venue: online ? null : { name: `【SYNTHETIC】shop ${vk}`, source_id: vk % 2 ? `v${vk}` : null, country_code: 'JP', region_code: pref, region_name: prefName, city: null, address: null, postal_code: null },
      starts_on: startsOn,
      ends_on: null,
      // Hours repeat so several events share starts_at and order falls back to id.
      starts_at: timed ? `${startsOn}T${String(10 + (k % 3)).padStart(2, '0')}:00:00+09:00` : null,
      ends_at: null,
      timezone: 'Asia/Tokyo',
      time_precision: timed ? 'datetime' : 'date',
      format_text: null,
      eligibility_text: null,
      capacity: k % 4 ? 16 : null,
      fee_amount: fee,
      fee_currency: fee === null ? null : 'JPY',
      fee_text: null,
      registration_method: 'unknown',
      registration_platform: null,
      registration_url: null,
      registration_opens_at: null,
      registration_closes_at: null,
      registration_status: regs[k % regs.length],
      event_status: k % 17 === 0 ? 'cancelled' : k % 19 === 0 ? 'postponed' : 'scheduled',
      source_status_text: 'SYNTHETIC',
      last_seen_at: '2026-11-18T00:00:00Z',
    });
  }
  return out;
}

/** Write data/events-style files for the given events into a fresh temp dir. */
export function writeDataDir(events: Ev[], runs: Record<string, Ev> = {}, dir = mkdtempSync(join(tmpdir(), 'events-data-'))): string {
  const byGame = new Map<string, Ev[]>();
  for (const ev of events) byGame.set(ev.game_code, [...(byGame.get(ev.game_code) ?? []), ev]);
  for (const game of new Set([...byGame.keys(), ...Object.keys(runs)])) {
    const evs = byGame.get(game) ?? [];
    const gdir = join(dir, game);
    mkdirSync(gdir, { recursive: true });
    const byMonth = new Map<string, Ev[]>();
    for (const ev of evs) byMonth.set(ev.starts_on.slice(0, 7), [...(byMonth.get(ev.starts_on.slice(0, 7)) ?? []), ev]);
    for (const [month, list] of byMonth) writeFileSync(join(gdir, `${month}.json`), JSON.stringify(list, null, 2) + '\n');
    writeFileSync(join(gdir, '_run.json'), JSON.stringify(runs[game] ?? run(game, evs.length), null, 2) + '\n');
  }
  return dir;
}

export function importDir(db: SqliteD1, dataDir: string, now?: number) {
  const results = loadAll(dataDir);
  const accepted = results.filter((r) => r.errors.length === 0);
  const plan = planImport(accepted, db.readState(), now === undefined ? {} : { now });
  db.execAll(plan.statements);
  return Object.assign(results, { plan });
}

export function newDb(): SqliteD1 {
  return new SqliteD1().migrate();
}

/** Every prefecture the synthetic data uses plus online: the API requires 1-5 pref values. */
export const ALL_PREFS = 'pref=JP-13,JP-14,JP-27,JP-40,online';

export async function api(db: SqliteD1, path: string): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await worker.fetch(new Request(`http://localhost${path}`), { DB: db as unknown as D1Database });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

/**
 * SYNTHETIC events that reuse one group source_id with different categories/types and one venue source_id
 * with different addresses and regions, as the real sources do.
 */
export function conflicting(n: number): Ev[] {
  return synthetic(n, 5000).map((e, i) => ({
    ...e,
    group: { ...e.group, source_id: 'g-shared', name: '【SYNTHETIC】shared group', category: ['tournament', 'teaching', 'casual'][i % 3], event_type_code: ['gym_battle', null][i % 2] },
    venue: e.venue && { ...e.venue, source_id: 'org-1', address: `【SYNTHETIC】address ${i % 4}`, postal_code: `100-000${i % 4}`, region_code: ['JP-14', 'JP-04'][i % 2], region_name: ['神奈川県', '宮城県'][i % 2] },
  }));
}

/** The API shape of a single-game event from the data files. */
export function asApi(ev: Ev): Ev {
  const { id, game_code, ...rest } = ev;
  return { id, game_code, game_codes: [game_code], ...rest };
}
