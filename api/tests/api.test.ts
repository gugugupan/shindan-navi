import { beforeAll, describe, expect, it } from 'vitest';
import { SCAN_LIMIT } from '../src/events';
import { ALL_PREFS, api, apiAll, asApi, newDb, sampleEvents, synthetic, writeDataDir, importDir, type Ev } from './helpers';
import type { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';

const NULL_SORT = 253402300799;
const sortKey = (e: Ev): [string, number, string] => [e.starts_on, e.starts_at ? Math.floor(Date.parse(e.starts_at) / 1000) : NULL_SORT, e.id];
const cmp = (a: Ev, b: Ev) => {
  const [x, y] = [sortKey(a), sortKey(b)];
  return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
};
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

let db: SqliteD1;
let all: Ev[];

beforeAll(() => {
  all = [...sampleEvents(), ...synthetic(600)];
  db = newDb();
  const results = importDir(db, writeDataDir(all));
  expect(results.flatMap((r) => r.errors)).toEqual([]);
});

const withPref = (q: string) => (/(^|&)pref=/.test(q) ? q : `${q}&${ALL_PREFS}`);

async function fetchAll(query: string, on = db): Promise<Ev[]> {
  const r = await apiAll(on, `/api/v1/events?${withPref(query)}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.events;
}

describe('GET /api/v1/events', () => {
  it('returns fixture events in exactly the contract shape', async () => {
    const r = await api(db, `/api/v1/events?from=2026-11-18&until=2026-12-01&game=OPCG,PTCG,UATCG&${ALL_PREFS}`);
    const byId = new Map(r.body.events.map((e: Ev) => [e.id, e]));
    for (const ev of sampleEvents()) {
      // Key order matters too: compare serialized JSON.
      expect(JSON.stringify(byId.get(ev.id) ?? (await fetchAll(`from=${ev.starts_on}&until=2027-02-18`)).find((e) => e.id === ev.id))).toBe(JSON.stringify(asApi(ev)));
    }
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  const cases: Array<[string, (e: Ev) => boolean]> = [
    ['game=OPCG', (e) => e.game_code === 'OPCG'],
    ['game=OPCG,PTCG', (e) => ['OPCG', 'PTCG'].includes(e.game_code)],
    ['pref=JP-13,JP-40', (e) => ['JP-13', 'JP-40'].includes(e.venue?.region_code)],
    ['pref=online', (e) => !e.venue],
    ['pref=JP-27,online', (e) => !e.venue || e.venue.region_code === 'JP-27'],
    ['type=standard_battle', (e) => e.group.event_type_code === 'standard_battle'],
    ['type=meetup,standard_battle', (e) => ['meetup', 'standard_battle'].includes(e.group.event_type_code)],
    ['days=weekend', (e) => [0, 6].includes(dow(e.starts_on))],
    ['days=weekday', (e) => ![0, 6].includes(dow(e.starts_on))],
    ['game=UATCG&pref=JP-14&type=meetup&days=weekend', (e) => e.game_code === 'UATCG' && e.venue?.region_code === 'JP-14' && e.group.event_type_code === 'meetup' && [0, 6].includes(dow(e.starts_on))],
  ];
  for (const [q, pred] of cases) {
    it(`filters ${q}`, async () => {
      const range = 'from=2026-11-18&until=2027-02-18';
      const expected = all.filter((e) => e.starts_on >= '2026-11-18' && e.starts_on < '2027-02-18').filter(pred).sort(cmp).map((e) => e.id);
      expect(expected.length).toBeGreaterThan(0);
      const got = await fetchAll(`${range}&${q}`);
      expect(got.map((e) => e.id)).toEqual(expected);
      const days = await apiAll(db, `/api/v1/events/days?${withPref(`${range}&${q}`)}`);
      expect(days.body.days.reduce((n: number, d: Ev) => n + d.count, 0)).toBe(expected.length);
    });
  }

  it('applies from inclusive and until exclusive', async () => {
    const got = await fetchAll('from=2026-12-05&until=2026-12-06');
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((e) => e.starts_on === '2026-12-05')).toBe(true);
    expect(got.map((e) => e.id)).toEqual(all.filter((e) => e.starts_on === '2026-12-05').sort(cmp).map((e) => e.id));
  });

  it('orders timed events before date-only ones within a day, ties by id', async () => {
    const got = await fetchAll('from=2026-11-18&until=2027-02-18');
    expect(got.map((e) => e.id)).toEqual([...got].sort(cmp).map((e) => e.id));
    const day = got.filter((e) => e.starts_on === got[0].starts_on);
    const firstNull = day.findIndex((e) => e.starts_at === null);
    if (firstNull >= 0) expect(day.slice(firstNull).every((e) => e.starts_at === null)).toBe(true);
  });

  it('paginates in pages of 50 without gaps or duplicates', async () => {
    const got = (await fetchAll('from=2026-11-18&until=2027-02-18')).map((e) => e.id);
    expect(got).toEqual([...all].sort(cmp).map((e) => e.id));
    const first = await api(db, `/api/v1/events?from=2026-11-18&until=2026-12-01&${ALL_PREFS}`);
    expect(first.body.events).toHaveLength(50);
    expect(first.body.next_cursor).not.toBeNull();
  });

  it('accepts only the page size 50', async () => {
    const q = `/api/v1/events?from=2026-11-18&until=2026-12-01&${ALL_PREFS}`;
    expect((await api(db, `${q}&limit=50`)).status).toBe(200);
    for (const l of ['1', '49', '51', '200']) expect((await api(db, `${q}&limit=${l}`)).body.error).toMatch(/limit must be 50/);
  });

  it('rejects forged cursors', async () => {
    const q = `/api/v1/events?from=2026-11-18&until=2026-12-01&${ALL_PREFS}`;
    const p1 = await api(db, q);
    const [v, fp] = JSON.parse(Buffer.from(p1.body.next_cursor, 'base64url').toString());
    const forge = (x: unknown[]) => Buffer.from(JSON.stringify(x)).toString('base64url');
    expect((await api(db, `${q}&cursor=${forge([v, fp, '2026-12-05', 0, 'tcgp:x'])}`)).body.error).toMatch(/outside the date range/);
    expect((await api(db, `${q}&cursor=${forge([v, fp, '2026-11-20', -1, 'tcgp:x'])}`)).body.error).toMatch(/invalid cursor/);
    expect((await api(db, `${q}&cursor=${forge([v, fp, '2026-11-20', 0, 'nope'])}`)).body.error).toMatch(/invalid cursor/);
  });

  it('clamps ranges to the data window and answers ranges outside it without data', async () => {
    const clamped = await api(db, `/api/v1/events/days?from=2026-11-01&until=2026-12-01&${ALL_PREFS}`);
    expect(clamped.body.days[0].date >= '2026-11-18').toBe(true);
    const ids = async (q: string) => (await api(db, `/api/v1/events?${q}&${ALL_PREFS}`)).body.events.map((e: Ev) => e.id);
    expect(await ids('from=2026-11-05&until=2026-12-01')).toEqual(await ids('from=2026-11-18&until=2026-12-01'));
    expect((await api(db, `/api/v1/events/days?from=2027-03-01&until=2027-04-01&${ALL_PREFS}`)).body).toEqual({ days: [] });
    expect((await api(db, `/api/v1/events?from=2026-10-05&until=2026-11-01&${ALL_PREFS}`)).body).toEqual({ events: [], next_cursor: null });
  });

  it('caps the rows one filtered page reads and continues with a cursor', async () => {
    const local = newDb();
    const tokyo = synthetic(8000).filter((e) => e.venue?.region_code === 'JP-13' && e.starts_on < '2026-12-01').sort(cmp);
    // Only the last event in list order has the type, so the first page reads SCAN_LIMIT rows and finds nothing.
    const rare = tokyo.map((e, i) => (i === tokyo.length - 1 ? { ...e, group: { ...e.group, event_type_code: 'rare_kind' } } : e));
    importDir(local, writeDataDir(rare));
    expect(tokyo.length).toBeGreaterThan(SCAN_LIMIT);
    const q = '/api/v1/events?from=2026-11-18&until=2026-12-01&pref=JP-13&type=rare_kind';
    const p1 = await api(local, q);
    expect(p1.body.events).toEqual([]);
    expect(p1.body.next_cursor).not.toBeNull();
    const all2 = await apiAll(local, q);
    expect(all2.body.events.map((e: Ev) => e.id)).toEqual([rare[rare.length - 1].id]);
  });

  it('keeps later pages stable when rows are added before the cursor', async () => {
    const local = newDb();
    const evs = synthetic(1200).filter((e) => e.starts_on < '2026-12-01');
    const dir = writeDataDir(evs);
    importDir(local, dir);
    const q = `/api/v1/events?from=2026-11-18&until=2026-12-01&${ALL_PREFS}`;
    const p1 = await api(local, q);
    // A new run adds an event that sorts first; the second page must continue after the cursor.
    const early = { ...synthetic(1, 999)[0], starts_on: '2026-11-18', starts_at: null, time_precision: 'date' };
    importDir(local, writeDataDir([...evs, { ...early, game_code: 'OPCG', id: 'tcgp:early', external_id: 'early', source_code: 'bandai_tcg_plus' }], {}, dir));
    const p2 = await api(local, `${q}&cursor=${p1.body.next_cursor}`);
    const ids = [...p1.body.events, ...p2.body.events].map((e: Ev) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('tcgp:early');
    expect(p2.body.events.map((e: Ev) => e.id)).toEqual(evs.sort(cmp).slice(50, 100).map((e) => e.id));
  });

  it('returns no count (the page sums /events/days)', async () => {
    const r = await api(db, `/api/v1/events?from=2026-11-18&until=2026-12-01&${ALL_PREFS}`);
    expect(Object.keys(r.body)).toEqual(['events', 'next_cursor']);
  });

  const P = 'pref=JP-13';
  const M = 'from=2026-12-01&until=2027-01-01';
  const bad: Array<[string, RegExp]> = [
    ['', /from is required/],
    [`from=2026-11-18&${P}`, /until is required/],
    [M, /pref is required/],
    [`${M}&pref=`, /pref is required/],
    [`${M}&pref=JP-01,JP-02,JP-03,JP-04,JP-05,online`, /at most 5 pref/],
    [`${M}&pref=Online`, /invalid pref/],
    [`${M}&pref=JP-48`, /invalid pref/],
    [`${M}&${P}&x=1`, /unknown parameter: x/],
    [`${M}&${P}&_=123`, /unknown parameter: _/],
    [`${M}&${P}&category=tournament`, /unknown parameter: category/],
    [`${M}&${P}&fee=free`, /unknown parameter: fee/],
    [`${M}&${P}&mode=online`, /unknown parameter: mode/],
    [`from=2026-13-01&until=2027-01-01&${P}`, /from is not a valid date/],
    [`from=2026/11/18&until=2027-01-01&${P}`, /from must be YYYY-MM-DD/],
    [`from=2026-12-05&until=2026-12-20&${P}`, /until must be the first day of the month after from/],
    [`from=2026-12-05&until=2027-02-01&${P}`, /until must be the first day of the month after from/],
    [`${M}&from=2026-12-02&${P}`, /more than once/],
    [`${M}&${P}&game=MTG`, /invalid game/],
    [`${M}&${P}&type=Bad-Type`, /invalid type/],
    [`${M}&${P}&days=1`, /invalid days/],
    [`${M}&${P}&days=weekend&days=weekday`, /more than once/],
    [`${M}&${P}&limit=0`, /limit must be 50/],
    [`${M}&${P}&limit=ten`, /limit must be 50/],
    [`${M}&${P}&cursor=garbage`, /invalid cursor/],
  ];
  for (const [q, msg] of bad) {
    it(`400 for "${q}"`, async () => {
      const r = await api(db, `/api/v1/events?${q}`);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(msg);
    });
  }

  it('accepts a whole month and a month tail', async () => {
    expect((await api(db, '/api/v1/events?from=2026-12-01&until=2027-01-01&pref=JP-13')).status).toBe(200);
    expect((await api(db, '/api/v1/events?from=2026-12-24&until=2027-01-01&pref=JP-13')).status).toBe(200);
  });

  it('rejects a cursor reused with different filters', async () => {
    const p1 = await api(db, `/api/v1/events?from=2026-11-18&until=2026-12-01&${ALL_PREFS}`);
    const r = await api(db, `/api/v1/events?from=2026-11-18&until=2026-12-01&${ALL_PREFS}&game=OPCG&cursor=${p1.body.next_cursor}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cursor does not match/);
  });

  it('404s unknown API paths and 405s other methods', async () => {
    expect((await api(db, '/api/v1/nope')).status).toBe(404);
    const { default: worker } = await import('../src/index');
    const res = await worker.fetch(new Request('http://localhost/api/v1/events', { method: 'POST' }), { DB: db as unknown as D1Database });
    expect(res.status).toBe(405);
  });
});

describe('GET /api/v1/events/days', () => {
  const daysOf = (evs: Ev[]) => {
    const m = new Map<string, Ev>();
    for (const e of evs) {
      const d = m.get(e.starts_on) ?? { date: e.starts_on, count: 0, by_game: {} };
      d.count++;
      d.by_game[e.game_code] = (d.by_game[e.game_code] ?? 0) + 1;
      m.set(e.starts_on, d);
    }
    return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  };

  for (const q of ['', '&game=OPCG,PTCG', '&pref=JP-13&days=weekend', '&type=standard_battle&days=weekday']) {
    it(`matches /events for "${q}"`, async () => {
      const r = await apiAll(db, `/api/v1/events/days?${withPref(`from=2026-11-18&until=2027-02-18${q}`)}`);
      expect(r.status).toBe(200);
      const expected = daysOf(await fetchAll(`from=2026-11-18&until=2027-02-18${q}`));
      expect(expected.length).toBeGreaterThan(0);
      expect(r.body).toEqual({ days: expected });
      expect(r.body.days.every((d: Ev) => d.count > 0)).toBe(true);
    });
  }

  it('includes cancelled and postponed events in days and count', async () => {
    expect(all.some((e) => e.event_status === 'cancelled') && all.some((e) => e.event_status === 'postponed')).toBe(true);
    const r = await apiAll(db, `/api/v1/events/days?from=2026-11-18&until=2027-02-18&${ALL_PREFS}`);
    expect(r.body.days.reduce((n: number, d: Ev) => n + d.count, 0)).toBe(all.length);
  });

  it('validates filters like /events and rejects limit/cursor', async () => {
    expect((await api(db, '/api/v1/events/days?from=2026-11-18&pref=JP-13')).status).toBe(400);
    expect((await api(db, '/api/v1/events/days?from=2026-12-01&until=2027-01-01')).body.error).toMatch(/pref is required/);
    expect((await api(db, '/api/v1/events/days?from=2026-12-01&until=2027-01-01&pref=JP-13&game=MTG')).status).toBe(400);
    expect((await api(db, '/api/v1/events/days?from=2026-12-01&until=2027-01-01&pref=JP-13&limit=50')).body.error).toMatch(/unknown parameter: limit/);
    expect((await api(db, '/api/v1/events/days?from=2026-11-18&until=2026-12-01&pref=JP-13')).body.error).toMatch(/whole months/);
  });
});

describe('GET /api/v1/events/meta', () => {
  it('lists games, all 47 prefectures, categories and types', async () => {
    const r = await api(db, '/api/v1/events/meta');
    expect(r.status).toBe(200);
    const m = r.body;
    expect(m.games.map((g: Ev) => [g.code, g.slug])).toEqual([['OPCG', 'onepiece'], ['UATCG', 'unionarena'], ['CONAN', 'conan'], ['PTCG', 'pokemon']]);
    const opcg = m.games[0];
    expect(opcg).toMatchObject({ name: 'ONE PIECEカードゲーム', fetched_at: '2026-11-18T00:00:00Z', complete: true, window: { from: '2026-11-18', until: '2027-02-18' } });
    expect(opcg.record_count).toBe(all.filter((e) => e.game_code === 'OPCG').length);
    expect(m.prefectures).toHaveLength(47);
    expect(m.prefectures[0]).toEqual({ code: 'JP-01', name: '北海道', count: 0 });
    expect(m.prefectures.find((p: Ev) => p.code === 'JP-13').count).toBe(all.filter((e) => e.venue?.region_code === 'JP-13').length);
    expect(m.online).toEqual({ count: all.filter((e) => !e.venue).length });
    expect(m.online.count).toBeGreaterThan(0);
    expect(m.categories.map((c: Ev) => c.code)).toEqual(['tournament', 'casual', 'teaching', 'festival', 'other', 'unknown']);
    expect(m.categories.reduce((s: number, c: Ev) => s + c.count, 0)).toBe(all.length);
    expect(m.types).toContainEqual({ game_code: 'PTCG', code: 'gym_battle', name: 'ジムバトル', count: 1 });
    expect(m.types).toContainEqual(expect.objectContaining({ game_code: 'OPCG', code: 'standard_battle', name: 'スタンダードバトル' }));
  });

  it('reports games without an import as empty', async () => {
    const m = (await api(newDb(), '/api/v1/events/meta')).body;
    expect(m.games[0]).toEqual({ code: 'OPCG', name: 'ONE PIECEカードゲーム', slug: 'onepiece', record_count: 0, fetched_at: null, complete: false, window: null });
    expect(m.types).toEqual([]);
    expect(m.online).toEqual({ count: 0 });
  });

  it('rejects query parameters', async () => {
    expect((await api(db, '/api/v1/events/meta?x=1')).status).toBe(400);
  });
});
