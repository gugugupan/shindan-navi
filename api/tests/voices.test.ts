import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { REPO_DIR } from '../scripts/lib/importer.mjs';
import {
  checkSnapshot, checkTimeline, hashOf, bodyOf, loadVoices, planVoices, removeTopics, voicesState, VOICES_STATE_SQL, DEFAULT_VOICES_DIR,
} from '../scripts/lib/voices.mjs';
import { SqliteD1 } from '../scripts/lib/sqlite-d1.mjs';
import { importDir, run, synthetic, writeDataDir } from './helpers';

const TODAY = '2026-11-21';
const topic = (over: Record<string, unknown> = {}) => ({
  id: 'opcg-test-topic', game: 'OPCG', title: 'テスト', summary: 'テストの要約。', attitude: 'positive',
  share: { positive: 3, negative: 1, neutral: 1 }, volume: 'mid', voices: ['声'], reacting_to: null,
  window: { from: '2026-11-18', to: '2026-11-20' }, first_seen: '2026-11-19', status: 'new', source: 'grok-app', ...over,
});
const snap = (over: Record<string, unknown> = {}, topics: Record<string, unknown>[] = [topic()]) => ({
  version: 1, date: '2026-11-20', window: { from: '2026-11-18', to: '2026-11-20' }, topics, ...over,
});
const check = (s: unknown, name = '2026-11-20.json') => checkSnapshot(name, JSON.stringify(s, null, 2), { today: TODAY });

describe('voices validation (build.py voices_data rules)', () => {
  it('accepts the committed snapshots and keeps only date, window and topics', () => {
    const r = loadVoices(DEFAULT_VOICES_DIR, { today: TODAY });
    expect(r.errors).toEqual([]);
    expect(r.snapshots.size).toBe(readdirSync(DEFAULT_VOICES_DIR).filter((f) => f.endsWith('.json')).length);
    for (const s of r.snapshots.values()) expect(Object.keys(s)).toEqual(['date', 'window', 'topics']);
    expect(checkTimeline(r.snapshots.values()).errors).toEqual([]);
  });

  it('skips samples', () => {
    const r = check(snap({ sample: true }));
    expect(r.snapshot).toBeNull();
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toMatch(/sample snapshot skipped/);
  });

  it.each([
    ['posts', snap({}, [{ ...topic(), posts: ['https://x.com/someone/status/1'] }]), /posts: player post URLs/],
    ['an X URL outside reacting_to', snap({ note: 'see https://x.com/someone/status/12' }), /X URL that is not a topic's reacting_to/],
    ['a twitter.com URL in a voice', snap({}, [topic({ voices: ['https://twitter.com/a/status/1'] })]), /X URL/],
    ['a non-status reacting_to', snap({}, [topic({ reacting_to: 'https://x.com/ONEPIECE_tcg' })]), /reacting_to must be/],
    ['a long title', snap({}, [topic({ title: 'あ'.repeat(41) })]), /title empty or over 40/],
    ['a long summary', snap({}, [topic({ summary: 'あ'.repeat(161) })]), /summary empty or over 160/],
    ['four voices', snap({}, [topic({ voices: ['a', 'b', 'c', 'd'] })]), /at most 3 strings/],
    ['share all zero', snap({}, [topic({ share: { positive: 0, negative: 0, neutral: 0 } })]), /share/],
    ['an unknown game', snap({}, [topic({ game: 'ZZZ' })]), /unknown game ZZZ/],
    ['a duplicate id', snap({}, [topic(), topic()]), /bad or duplicate id/],
    ['first_seen after the date', snap({}, [topic({ first_seen: '2026-11-21' })]), /first_seen after/],
    ['a topic window that differs', snap({}, [topic({ window: { from: '2026-11-17', to: '2026-11-20' } })]), /window differs/],
    ['a name / date mismatch', snap({ date: '2026-11-19' }), /file name, date and window.to/],
    ['a future date', snap({ date: '2026-11-22', window: { from: '2026-11-18', to: '2026-11-22' } }, [topic({ window: { from: '2026-11-18', to: '2026-11-22' } })]), /after today/],
    ['an extra top-level field', snap({ extra: 1 }), /wrong top-level fields/],
  ])('refuses %s', (_label, s, re) => {
    const name = (s as { date: string }).date === '2026-11-22' ? '2026-11-22.json' : '2026-11-20.json';
    const r = check(s, name);
    expect(r.snapshot).toBeNull();
    expect(r.errors.join('\n')).toMatch(re);
  });

  it('counts code points like Python', () => {
    expect(check(snap({}, [topic({ title: '🃏'.repeat(40) })])).errors).toEqual([]);
  });

  it('checks ids across snapshots', () => {
    const a = { date: '2026-11-20', window: { from: '2026-11-18', to: '2026-11-20' }, topics: [topic()] };
    const ok = { date: '2026-11-21', window: a.window, topics: [topic({ status: 'continuing' })] };
    expect(checkTimeline([ok, a])).toEqual({ errors: [], warnings: [] });
    const errs = checkTimeline([a, { ...ok, topics: [topic({ game: 'PTCG', first_seen: '2026-11-18', status: 'new' })] }]).errors.join('\n');
    expect(errs).toMatch(/game PTCG != OPCG/);
    expect(errs).toMatch(/first_seen 2026-11-18 != 2026-11-19/);
    expect(errs).toMatch(/is new but 2026-11-20 already lists it/);
    expect(checkTimeline([ok]).warnings[0]).toMatch(/continuing but no earlier snapshot/);
  });
});

describe('voices plan', () => {
  const s1 = { date: '2026-11-20', window: { from: '2026-11-18', to: '2026-11-20' }, topics: [topic()] };
  const s2 = { date: '2026-11-21', window: { from: '2026-11-19', to: '2026-11-21' }, topics: [topic({ id: 'opcg-other', window: { from: '2026-11-19', to: '2026-11-21' } })] };
  const now = new Date(1_000);

  it('inserts, updates and keeps by hash, and bumps the version only when it writes', () => {
    const first = planVoices(new Map([[s1.date, s1], [s2.date, s2]]), new Map(), { now, hasVersion: false });
    expect(first.rows.map((r) => [r.date, r.action])).toEqual([['2026-11-20', 'insert'], ['2026-11-21', 'insert']]);
    expect(first.statements).toHaveLength(3);
    expect(first.statements[2]).toMatch(/voice_meta.*'1000'/);
    const cur = new Map([[s1.date, { hash: hashOf(bodyOf(s1)) }], [s2.date, { hash: 'x'.repeat(64) }]]);
    const second = planVoices(new Map([[s1.date, s1], [s2.date, s2]]), cur, { now });
    expect(second.rows.map((r) => r.action)).toEqual(['unchanged', 'update']);
    expect(second.writes).toBe(2);
    const none = planVoices(new Map([[s1.date, s1]]), new Map([[s1.date, { hash: hashOf(bodyOf(s1)) }]]), { now });
    expect(none.statements).toEqual([]);
  });

  it('keeps dates without a local file unless pruning', () => {
    const cur = new Map([[s1.date, { hash: hashOf(bodyOf(s1)) }], [s2.date, { hash: hashOf(bodyOf(s2)) }]]);
    const kept = planVoices(new Map([[s1.date, s1]]), cur, { now });
    expect(kept.rows[1].action).toMatch(/^kept/);
    expect(kept.statements).toEqual([]);
    const pruned = planVoices(new Map([[s1.date, s1]]), cur, { now, prune: true });
    expect(pruned.rows[1].action).toBe('delete');
    expect(pruned.statements[0]).toBe("DELETE FROM voice_snapshots WHERE date IN ('2026-11-21')");
  });

  it('removes a topic from every snapshot and drops a snapshot left empty', () => {
    const both = new Map([[s1.date, s1], [s2.date, { ...s2, topics: [...s2.topics, topic({ status: 'continuing', window: s2.window })] }]]);
    const out = removeTopics(both, ['opcg-test-topic']);
    expect([...out.keys()]).toEqual(['2026-11-21']);
    expect(out.get('2026-11-21')!.topics.map((t: { id: string }) => t.id)).toEqual(['opcg-other']);
  });
});

// ---- API
class FakeCache {
  store = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();
  puts: string[] = [];
  async match(req: Request) {
    const hit = this.store.get(req.url);
    return hit ? new Response(hit.body.slice(0), hit.init) : undefined;
  }
  async put(req: Request, res: Response) {
    this.puts.push(req.url);
    this.store.set(req.url, { body: await res.arrayBuffer(), init: { status: res.status, headers: res.headers } });
  }
}

function seed(db: SqliteD1, now = 2_000) {
  const r = loadVoices(DEFAULT_VOICES_DIR, { today: TODAY });
  const plan = planVoices(r.snapshots, voicesState(db.db.prepare(VOICES_STATE_SQL).all()).current, { now: new Date(now), hasVersion: false });
  db.execAll(plan.statements);
  return r.snapshots;
}
const files = () => readdirSync(DEFAULT_VOICES_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(join(DEFAULT_VOICES_DIR, f), 'utf8'))).filter((s) => !s.sample);

describe('voices API', () => {
  let raw: SqliteD1;
  let cache: FakeCache;
  let queries: number;
  let db: D1Database;
  beforeEach(() => {
    raw = new SqliteD1().migratePending();
    importDir(raw, writeDataDir(synthetic(10), { OPCG: run('OPCG', 3) }), 1_000);
    queries = 0;
    db = new Proxy(raw, {
      get(t, prop, recv) {
        if (prop === 'prepare') queries++;
        const v = Reflect.get(t, prop, recv);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as unknown as D1Database;
    cache = new FakeCache();
  });
  afterEach(() => vi.unstubAllGlobals());
  const call = async (path: string, limiter?: RateLimit, on = db) => {
    const res = await worker.fetch(new Request(`https://shindan-navi.app${path}`), { DB: on, API_LIMIT: limiter });
    return { res, body: await res.json() as any };
  };

  it('answers empty before the first import and while the migration is pending', async () => {
    expect((await call('/api/v1/voices')).body).toEqual({ version: null, snapshots: [] });
    expect((await call('/api/v1/voices/latest')).body).toEqual({ version: null, snapshot: null });
    const old = new SqliteD1().migrate() as unknown as D1Database;
    expect((await call('/api/v1/voices', undefined, old)).body).toEqual({ version: null, snapshots: [] });
    expect((await call('/api/v1/voices/latest', undefined, old)).res.status).toBe(200);
  });

  it('serves every snapshot oldest first, and the latest one', async () => {
    seed(raw);
    const want = files().map((s) => ({ date: s.date, window: s.window, topics: s.topics }));
    const all = await call('/api/v1/voices');
    expect(all.res.status).toBe(200);
    expect(all.res.headers.get('x-robots-tag')).toBe('noindex');
    expect(all.body).toEqual({ version: '2000', snapshots: want });
    expect((await call('/api/v1/voices/latest')).body).toEqual({ version: '2000', snapshot: want.at(-1) });
  });

  it('rejects parameters and other methods', async () => {
    expect((await call('/api/v1/voices?x=1')).res.status).toBe(400);
    expect((await call('/api/v1/voices/latest?date=2026-11-20')).res.status).toBe(400);
    const post = await worker.fetch(new Request('https://shindan-navi.app/api/v1/voices', { method: 'POST' }), { DB: db });
    expect(post.status).toBe(405);
  });

  it('caches under the voices version, apart from the events version', async () => {
    vi.stubGlobal('caches', { default: cache });
    seed(raw);
    const a = await call('/api/v1/voices');
    expect(a.res.headers.get('x-edge-cache')).toBe('miss');
    await call('/api/v1/events/meta');
    expect(cache.puts.filter((u) => !u.includes('__state'))).toEqual([
      'https://shindan-navi.app/api/v1/voices?v=2000',
      'https://shindan-navi.app/api/v1/events/meta?v=1000',
    ]);
    expect(cache.puts).toContain('https://shindan-navi.app/api/__state/voices');
    const n = queries;
    expect((await call('/api/v1/voices')).res.headers.get('x-edge-cache')).toBe('hit');
    expect((await call('/api/v1/events/meta')).res.headers.get('x-edge-cache')).toBe('hit');
    expect(queries).toBe(n);
  });

  it('a new import makes a new cache key once the memo expires', async () => {
    vi.stubGlobal('caches', { default: cache });
    const snaps = seed(raw);
    await call('/api/v1/voices/latest');
    const [d, s] = [...snaps].at(-1)!;
    const plan = planVoices(new Map([[d, { ...s, topics: s.topics.slice(1) }]]), voicesState(raw.db.prepare(VOICES_STATE_SQL).all()).current, { now: new Date(3_000) });
    raw.execAll(plan.statements);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    const b = await call('/api/v1/voices/latest');
    expect(b.res.headers.get('x-edge-cache')).toBe('miss');
    expect(b.body.version).toBe('3000');
    expect(b.body.snapshot.topics).toHaveLength(s.topics.length - 1);
    vi.restoreAllMocks();
  });

  it('rate-limits misses only', async () => {
    vi.stubGlobal('caches', { default: cache });
    seed(raw);
    const deny = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    expect((await call('/api/v1/voices', deny)).res.status).toBe(429);
    await call('/api/v1/voices');
    expect((await call('/api/v1/voices', deny)).res.status).toBe(200);
  });
});

it('the migration stays pending: not in api/migrations', () => {
  expect(readdirSync(join(REPO_DIR, 'api/migrations')).some((f) => f.includes('voices'))).toBe(false);
  expect(readdirSync(join(REPO_DIR, 'api/migrations-pending'))).toContain('0008_voices.sql');
});
