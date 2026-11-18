import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_PREFS, api, asApi, newDb, sampleEvents, synthetic, writeDataDir, importDir, type Ev } from './helpers';
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

async function fetchAll(query: string, limit = 37, on = db): Promise<Ev[]> {
  const out: Ev[] = [];
  let cursor: string | null = null;
  do {
    const r = await api(on, `/api/v1/events?${withPref(query)}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    out.push(...r.body.events);
    cursor = r.body.next_cursor;
  } while (cursor);
  return out;
}

describe('GET /api/v1/events', () => {
  it('returns fixture events in exactly the contract shape', async () => {
    const r = await api(db, `/api/v1/events?from=2026-11-18&until=2027-02-18&limit=200&game=OPCG,PTCG,UATCG&${ALL_PREFS}`);
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
    ['category=tournament,casual', (e) => ['tournament', 'casual'].includes(e.group.category)],
    ['type=standard_battle', (e) => e.group.event_type_code === 'standard_battle'],
    ['days=weekend', (e) => [0, 6].includes(dow(e.starts_on))],
    ['days=weekday', (e) => ![0, 6].includes(dow(e.starts_on))],
    ['days=1,3', (e) => [1, 3].includes(dow(e.starts_on))],
    ['fee=free', (e) => e.fee_amount === 0],
    ['fee=paid', (e) => e.fee_amount > 0],
    ['fee=unknown', (e) => e.fee_amount === null],
    ['fee=free,unknown', (e) => e.fee_amount === 0 || e.fee_amount === null],
    ['registration=open', (e) => e.registration_status === 'open'],
    ['mode=online', (e) => ['online', 'hybrid'].includes(e.attendance_mode)],
    ['mode=in_person', (e) => ['in_person', 'hybrid'].includes(e.attendance_mode)],
    ['mode=hybrid', (e) => e.attendance_mode === 'hybrid'],
    ['pref=JP-13&mode=online', (e) => e.attendance_mode === 'hybrid' && e.venue?.region_code === 'JP-13'],
    ['game=UATCG&pref=JP-14&fee=paid&days=weekend', (e) => e.game_code === 'UATCG' && e.venue?.region_code === 'JP-14' && e.fee_amount > 0 && [0, 6].includes(dow(e.starts_on))],
  ];
  for (const [q, pred] of cases) {
    it(`filters ${q}`, async () => {
      const range = 'from=2026-11-18&until=2027-02-18';
      const expected = all.filter((e) => e.starts_on >= '2026-11-18' && e.starts_on < '2027-02-18').filter(pred).sort(cmp).map((e) => e.id);
      expect(expected.length).toBeGreaterThan(0);
      const got = await fetchAll(`${range}&${q}`);
      expect(got.map((e) => e.id)).toEqual(expected);
      const days = await api(db, `/api/v1/events/days?${withPref(`${range}&${q}`)}`);
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
    const got = await fetchAll('from=2026-11-18&until=2027-02-18', 200);
    expect(got.map((e) => e.id)).toEqual([...got].sort(cmp).map((e) => e.id));
    const day = got.filter((e) => e.starts_on === got[0].starts_on);
    const firstNull = day.findIndex((e) => e.starts_at === null);
    if (firstNull >= 0) expect(day.slice(firstNull).every((e) => e.starts_at === null)).toBe(true);
  });

  it('paginates without gaps or duplicates for several page sizes', async () => {
    const reference = (await fetchAll('from=2026-11-18&until=2027-02-18', 200)).map((e) => e.id);
    expect(reference.length).toBe(all.length);
    for (const limit of [1, 7, 50, 199]) {
      if (limit === 1) {
        const few = await fetchAll('from=2026-11-18&until=2026-11-25', 1);
        expect(few.map((e) => e.id)).toEqual(reference.filter((id) => few.some((e) => e.id === id)));
        continue;
      }
      expect((await fetchAll('from=2026-11-18&until=2027-02-18', limit)).map((e) => e.id)).toEqual(reference);
    }
  });

  it('keeps later pages stable when rows are added before the cursor', async () => {
    const local = newDb();
    const evs = synthetic(60);
    const dir = writeDataDir(evs);
    importDir(local, dir);
    const q = `/api/v1/events?from=2026-11-18&until=2027-02-18&limit=20&${ALL_PREFS}`;
    const p1 = await api(local, q);
    // A new run adds an event that sorts first; the second page must continue after the cursor.
    const early = { ...synthetic(1, 999)[0], starts_on: '2026-11-18', starts_at: null, time_precision: 'date' };
    importDir(local, writeDataDir([...evs, { ...early, game_code: 'OPCG', id: 'tcgp:early', external_id: 'early', source_code: 'bandai_tcg_plus' }], {}, dir));
    const p2 = await api(local, `${q}&cursor=${p1.body.next_cursor}`);
    const ids = [...p1.body.events, ...p2.body.events].map((e: Ev) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('tcgp:early');
    expect(p2.body.events.map((e: Ev) => e.id)).toEqual(evs.sort(cmp).slice(20, 40).map((e) => e.id));
  });

  it('caps limit at 200 and returns no count (the page sums /events/days)', async () => {
    const r = await api(db, `/api/v1/events?from=2026-11-18&until=2027-02-18&limit=500&${ALL_PREFS}`);
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBe(200);
    expect(Object.keys(r.body)).toEqual(['events', 'next_cursor']);
  });

  const P = 'pref=JP-13';
  const bad: Array<[string, RegExp]> = [
    ['', /from is required/],
    [`from=2026-11-18&${P}`, /until is required/],
    ['from=2026-11-18&until=2026-12-01', /pref is required/],
    ['from=2026-11-18&until=2026-12-01&pref=', /pref is required/],
    ['from=2026-11-18&until=2026-12-01&pref=JP-01,JP-02,JP-03,JP-04,JP-05,online', /at most 5 pref/],
    ['from=2026-11-18&until=2026-12-01&pref=Online', /invalid pref/],
    ['from=2026-11-18&until=2026-12-01&pref=JP-48', /invalid pref/],
    [`from=2026-11-18&until=2026-12-01&${P}&x=1`, /unknown parameter: x/],
    [`from=2026-11-18&until=2026-12-01&${P}&_=123`, /unknown parameter: _/],
    [`from=2026-13-01&until=2027-01-01&${P}`, /from is not a valid date/],
    [`from=2026/11/18&until=2027-01-01&${P}`, /from must be YYYY-MM-DD/],
    [`from=2026-11-18&until=2026-11-18&${P}`, /until must be after from/],
    [`from=2026-11-18&until=2027-02-19&${P}`, /at most 92 days/],
    [`from=2026-11-18&until=2026-11-20&from=2026-11-19&${P}`, /more than once/],
    [`from=2026-11-18&until=2026-12-01&${P}&game=MTG`, /invalid game/],
    [`from=2026-11-18&until=2026-12-01&${P}&category=party`, /invalid category/],
    [`from=2026-11-18&until=2026-12-01&${P}&type=Bad-Type`, /invalid type/],
    [`from=2026-11-18&until=2026-12-01&${P}&days=7`, /invalid days/],
    [`from=2026-11-18&until=2026-12-01&${P}&fee=cheap`, /invalid fee/],
    [`from=2026-11-18&until=2026-12-01&${P}&registration=yes`, /invalid registration/],
    [`from=2026-11-18&until=2026-12-01&${P}&mode=vr`, /invalid mode/],
    [`from=2026-11-18&until=2026-12-01&${P}&limit=0`, /limit must be/],
    [`from=2026-11-18&until=2026-12-01&${P}&limit=ten`, /limit must be/],
    [`from=2026-11-18&until=2026-12-01&${P}&cursor=garbage`, /invalid cursor/],
  ];
  for (const [q, msg] of bad) {
    it(`400 for "${q}"`, async () => {
      const r = await api(db, `/api/v1/events?${q}`);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(msg);
    });
  }

  it('accepts exactly 92 days', async () => {
    expect((await api(db, '/api/v1/events?from=2026-11-18&until=2027-02-18&pref=JP-13')).status).toBe(200);
  });

  it('rejects a cursor reused with different filters', async () => {
    const p1 = await api(db, '/api/v1/events?from=2026-11-18&until=2027-02-18&limit=5&pref=JP-13');
    const r = await api(db, `/api/v1/events?from=2026-11-18&until=2027-02-18&limit=5&pref=JP-13&game=OPCG&cursor=${p1.body.next_cursor}`);
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

  for (const q of ['', '&game=OPCG,PTCG', '&pref=JP-13&days=weekend', '&mode=online&fee=free']) {
    it(`matches /events for "${q}"`, async () => {
      const r = await api(db, `/api/v1/events/days?${withPref(`from=2026-11-18&until=2027-02-18${q}`)}`);
      expect(r.status).toBe(200);
      const expected = daysOf(await fetchAll(`from=2026-11-18&until=2027-02-18${q}`, 200));
      expect(expected.length).toBeGreaterThan(0);
      expect(r.body).toEqual({ days: expected });
      expect(r.body.days.every((d: Ev) => d.count > 0)).toBe(true);
    });
  }

  it('includes cancelled and postponed events in days and count', async () => {
    expect(all.some((e) => e.event_status === 'cancelled') && all.some((e) => e.event_status === 'postponed')).toBe(true);
    const r = await api(db, `/api/v1/events/days?from=2026-11-18&until=2027-02-18&${ALL_PREFS}`);
    expect(r.body.days.reduce((n: number, d: Ev) => n + d.count, 0)).toBe(all.length);
  });

  it('validates filters like /events and rejects limit/cursor', async () => {
    expect((await api(db, '/api/v1/events/days?from=2026-11-18&pref=JP-13')).status).toBe(400);
    expect((await api(db, '/api/v1/events/days?from=2026-11-18&until=2026-12-01')).body.error).toMatch(/pref is required/);
    expect((await api(db, '/api/v1/events/days?from=2026-11-18&until=2026-12-01&pref=JP-13&game=MTG')).status).toBe(400);
    expect((await api(db, '/api/v1/events/days?from=2026-11-18&until=2026-12-01&pref=JP-13&limit=10')).body.error).toMatch(/unknown parameter: limit/);
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
