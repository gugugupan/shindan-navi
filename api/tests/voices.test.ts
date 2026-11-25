import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { REPO_DIR } from '../scripts/lib/importer.mjs';
import {
  checkSnapshot, checkTimeline, hashOf, bodyOf, loadVoices, planVoices, removeTopics, voicesState, redact, todayJst,
  VOICES_STATE_SQL,
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
const API_DIR = join(REPO_DIR, 'api');

/** Fixed fixture snapshots: 11-20 with two topics, 11-21 continuing one. */
const FIXTURES = [
  snap({}, [topic(), topic({ id: 'ptcg-fixture', game: 'PTCG', status: 'new', reacting_to: 'https://x.com/pokemon_cojp/status/123' })]),
  snap({ date: '2026-11-21', window: { from: '2026-11-19', to: '2026-11-21' } }, [topic({ status: 'continuing', window: { from: '2026-11-19', to: '2026-11-21' } })]),
];
function fixtureDir(list: Record<string, any>[] = FIXTURES) {
  const dir = mkdtempSync(join(tmpdir(), 'voices-fixture-'));
  for (const s of list) writeFileSync(join(dir, `${s.date}.json`), JSON.stringify(s, null, 2) + '\n');
  return dir;
}
const served = (list: Record<string, any>[] = FIXTURES) => list.map((s) => ({ date: s.date, window: s.window, topics: s.topics }));

describe('voices validation (contracts/voices.md rules)', () => {
  it('accepts the gate fixtures once their sample flag is dropped, and keeps only date, window and topics', () => {
    // tools/verify/fixtures/voices/: the real snapshots live only in D1 and the owner's local copy, never in the repo
    const src = join(REPO_DIR, 'tools', 'verify', 'fixtures', 'voices');
    const files = readdirSync(src).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(1);
    const raw = files.map((f) => JSON.parse(readFileSync(join(src, f), 'utf8')));
    expect(raw.every((s) => s.sample === true)).toBe(true);
    expect(loadVoices(src, { today: '2026-12-31' }).snapshots.size).toBe(0);
    const r = loadVoices(fixtureDir(raw.map(({ sample, ...s }) => s)), { today: '2026-12-31' });
    expect(r.errors).toEqual([]);
    expect(r.snapshots.size).toBe(files.length);
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
    ['an X URL in the note', snap({ note: 'see https://x.com/someone/status/12' }), /X URL outside a topic's reacting_to at \/note/],
    ['a twitter.com URL in a voice', snap({}, [topic({ voices: ['https://twitter.com/a/status/1'] })]), /at \/topics\/0\/voices\/0/],
    ['an official URL repeated in a summary', snap({}, [topic({ reacting_to: 'https://x.com/ONEPIECE_tcg/status/1', summary: 'https://x.com/ONEPIECE_tcg/status/1' })]), /at \/topics\/0\/summary/],
    ['another topic\'s reacting_to in a title', snap({}, [topic({ reacting_to: 'https://x.com/a/status/1' }), topic({ id: 'opcg-two', title: 'x.com/a/status/1' })]), /at \/topics\/1\/title/],
    ['a scheme-less X host', snap({}, [topic({ voices: ['mobile.x.com/someone'] })]), /X URL outside/],
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

  it('decodes escaped slashes before looking for X URLs', () => {
    const text = JSON.stringify(snap({ note: 'NOTE' })).replace('"NOTE"', '"https:\\/\\/x.com\\/someone\\/status\\/1"');
    expect(text).toContain('\\/x.com');
    expect(checkSnapshot('2026-11-20.json', text, { today: TODAY }).errors.join()).toMatch(/at \/note/);
  });

  it('accepts a topic\'s own reacting_to and hosts that only end like x.com', () => {
    expect(check(snap({ note: 'box.com, fax.company' }, [topic({ reacting_to: 'https://x.com/ONEPIECE_tcg/status/1' })])).errors).toEqual([]);
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

  it('removes a topic from every snapshot; a snapshot left empty deletes its row', () => {
    const both = new Map([[s1.date, s1], [s2.date, { ...s2, topics: [...s2.topics, topic({ status: 'continuing', window: s2.window })] }]]);
    const out = removeTopics(both, ['opcg-test-topic']);
    expect(out.get('2026-11-20')!.topics).toEqual([]);
    expect(out.get('2026-11-21')!.topics.map((t: { id: string }) => t.id)).toEqual(['opcg-other']);
    const cur = new Map([[s1.date, { hash: hashOf(bodyOf(s1)) }], [s2.date, { hash: hashOf(bodyOf(both.get(s2.date)!)) }]]);
    const plan = planVoices(out, cur, { now });
    expect(plan.rows.map((r) => [r.date, r.action])).toEqual([['2026-11-20', 'delete'], ['2026-11-21', 'update']]);
  });

  it('a local file with topics [] deletes that date (and bumps the version); other D1-only dates stay', () => {
    const s3 = { date: '2026-11-19', window: { from: '2026-11-17', to: '2026-11-19' }, topics: [] };
    const cur = new Map([[s1.date, { hash: hashOf(bodyOf(s1)) }], [s3.date, { hash: 'y'.repeat(64) }], ['2026-11-18', { hash: 'z'.repeat(64) }]]);
    const plan = planVoices(new Map<string, any>([[s1.date, s1], [s3.date, s3]]), cur, { now });
    expect(plan.rows.map((r) => [r.date, r.action])).toEqual([['2026-11-18', 'kept (no local file; --prune deletes)'], ['2026-11-19', 'delete'], ['2026-11-20', 'unchanged']]);
    expect(plan.statements).toEqual([
      "DELETE FROM voice_snapshots WHERE date IN ('2026-11-19')",
      "INSERT INTO voice_meta (key, value) VALUES ('version', '1000') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ]);
    // a date with topics [] that D1 does not have: nothing to do
    expect(planVoices(new Map<string, any>([[s3.date, s3]]), new Map(), { now }).statements).toEqual([]);
  });

  it('redacts every UUID and the database id from wrangler output', () => {
    const id = '0badc0de-1234-4abc-8def-0123456789ab';
    expect(redact(`Executing on remote database shindan-navi-events (${id}):\n${id.toUpperCase()}`, id)).toBe('Executing on remote database shindan-navi-events (<redacted>):\n<redacted>');
    expect(redact('id=not-a-uuid-secret', 'not-a-uuid-secret')).toBe('id=<redacted>');
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
  const r = loadVoices(fixtureDir(), { today: TODAY });
  const plan = planVoices(r.snapshots, voicesState(db.db.prepare(VOICES_STATE_SQL).all()).current, { now: new Date(now), hasVersion: false });
  db.execAll(plan.statements);
  return r.snapshots;
}

describe('voices API', () => {
  let raw: SqliteD1;
  let cache: FakeCache;
  let queries: number;
  let db: D1Database;
  beforeEach(() => {
    raw = new SqliteD1().migrate();
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

  it('answers empty before the first import and without the migration', async () => {
    expect((await call('/api/v1/voices')).body).toEqual({ version: null, snapshots: [] });
    expect((await call('/api/v1/voices/latest')).body).toEqual({ version: null, snapshot: null });
    const old = new SqliteD1() as unknown as D1Database;
    expect((await call('/api/v1/voices', undefined, old)).body).toEqual({ version: null, snapshots: [] });
    expect((await call('/api/v1/voices/latest', undefined, old)).res.status).toBe(200);
  });

  it('serves every snapshot oldest first, and the latest one', async () => {
    seed(raw);
    const want = served();
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
    const plan = planVoices(new Map([[d, { ...s, topics: s.topics.map((t: any) => ({ ...t, title: '更新' })) }]]), voicesState(raw.db.prepare(VOICES_STATE_SQL).all()).current, { now: new Date(3_000) });
    raw.execAll(plan.statements);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    const b = await call('/api/v1/voices/latest');
    expect(b.res.headers.get('x-edge-cache')).toBe('miss');
    expect(b.body.version).toBe('3000');
    expect(b.body.snapshot.topics.map((t: any) => t.title)).toEqual(s.topics.map(() => '更新'));
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

describe('migration 0008', () => {
  it('is in migrations/ and creates the voice tables', () => {
    const db = new SqliteD1().migrate();
    expect(db.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('voice_snapshots', 'voice_meta')").all()).toHaveLength(2);
  });
});

// ---- the CLI on a throwaway SQLite file
describe('import-voices.mjs', () => {
  const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['scripts/import-voices.mjs', ...args], {
    cwd: API_DIR, encoding: 'utf8', env: { ...process.env, ...env },
  });
  const sqliteArgs = (db: string) => ['--target', 'sqlite', '--sqlite', db];
  const rows = (db: string) => {
    const d = new SqliteD1(db);
    const out = d.db.prepare('SELECT date, body FROM voice_snapshots ORDER BY date').all().map((r) => [r.date, JSON.parse(String(r.body)).topics.map((t: any) => t.id)]);
    d.close();
    return out;
  };
  const seeded = () => {
    const db = join(mkdtempSync(join(tmpdir(), 'voices-cli-')), 'db.sqlite3');
    const data = fixtureDir();
    const r = cli([...sqliteArgs(db), '--data', data, '--yes']);
    expect(r.status, r.stderr).toBe(0);
    return { db, data };
  };

  it('refuses --plan with --yes before opening anything', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'voices-cli-')), 'db.sqlite3');
    const r = cli([...sqliteArgs(db), '--data', fixtureDir(), '--plan', '--yes']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--plan and --yes/);
    expect(existsSync(db)).toBe(false);
  });

  it('needs an explicit --data for the production D1 and for takedowns', () => {
    for (const args of [['--target', 'remote', '--plan'], ['--target', 'sqlite', '--remove-topic', 'opcg-test-topic', '--plan'],
      ['--target', 'sqlite', '--remove-snapshot', '2026-11-20', '--plan']]) {
      const r = cli(args, { D1_DATABASE_ID: '' });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/needs an explicit --data/);
    }
  });

  it('takes --today only for local targets', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'voices-cli-')), 'db.sqlite3');
    const future = snap({ date: '2099-01-03', window: { from: '2099-01-01', to: '2099-01-03' } },
      [topic({ window: { from: '2099-01-01', to: '2099-01-03' }, first_seen: '2099-01-02' })]);
    expect(cli([...sqliteArgs(db), '--data', fixtureDir([future]), '--plan']).status).toBe(1);
    const ok = cli([...sqliteArgs(db), '--data', fixtureDir([future]), '--today', '2099-01-03', '--plan']);
    expect(ok.status, ok.stderr).toBe(0);
    const r = cli(['--target', 'remote', '--data', fixtureDir([future]), '--today', '2099-01-03', '--plan']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--today .* local targets only/);
  });

  it('plans without creating or migrating the database file', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'voices-cli-')), 'db.sqlite3');
    const plan = cli([...sqliteArgs(db), '--data', fixtureDir(), '--plan']);
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toMatch(/2026-11-20 {2}insert/);
    expect(existsSync(db)).toBe(false);
  });

  it('refuses an empty --remove-topic / --remove-snapshot instead of importing', () => {
    const { db, data } = seeded();
    writeFileSync(join(data, '2026-11-21.json'), JSON.stringify(snap({ date: '2026-11-21', window: { from: '2026-11-19', to: '2026-11-21' } }, [topic({ id: 'opcg-new', window: { from: '2026-11-19', to: '2026-11-21' } })]), null, 2));
    for (const flag of ['--remove-topic', '--remove-snapshot']) {
      for (const v of ['', ' , ']) {
        const r = cli([...sqliteArgs(db), '--data', data, flag, v, '--yes']);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/names no/);
      }
    }
    expect(rows(db)).toEqual([['2026-11-20', ['opcg-test-topic', 'ptcg-fixture']], ['2026-11-21', ['opcg-test-topic']]]);
  });

  it('a takedown cleans every local file holding the id, also one that fails validation', () => {
    const { db, data } = seeded();
    // 11-21 made invalid (an unknown game on another topic): the import would reject it, the takedown still cleans it
    const bad = JSON.parse(readFileSync(join(data, '2026-11-21.json'), 'utf8'));
    bad.topics.push(topic({ id: 'zzz-other', game: 'ZZZ', window: bad.window }));
    writeFileSync(join(data, '2026-11-21.json'), JSON.stringify(bad, null, 2));
    const r = cli([...sqliteArgs(db), '--data', data, '--remove-topic', 'opcg-test-topic', '--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(rows(db)).toEqual([['2026-11-20', ['ptcg-fixture']]]);
    for (const f of readdirSync(data)) expect(readFileSync(join(data, f), 'utf8')).not.toMatch(/"opcg-test-topic"/);
    expect(JSON.parse(readFileSync(join(data, '2026-11-21.json'), 'utf8')).topics.map((t: any) => t.id)).toEqual(['zzz-other']);
  });

  it('a takedown stops before writing when a file cannot be cleaned', () => {
    const { db, data } = seeded();
    writeFileSync(join(data, 'broken.json'), '{ "topics": [ "opcg-test-topic" ');
    const r = cli([...sqliteArgs(db), '--data', data, '--remove-topic', 'opcg-test-topic', '--yes']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/broken\.json: names opcg-test-topic but is not a readable snapshot/);
    expect(rows(db)).toEqual([['2026-11-20', ['opcg-test-topic', 'ptcg-fixture']], ['2026-11-21', ['opcg-test-topic']]]);
    const noted = fixtureDir();
    const s = JSON.parse(readFileSync(join(noted, '2026-11-20.json'), 'utf8'));
    writeFileSync(join(noted, '2026-11-20.json'), JSON.stringify({ ...s, note: 'see opcg-test-topic' }, null, 2));
    const r2 = cli([...sqliteArgs(db), '--data', noted, '--remove-topic', 'opcg-test-topic', '--yes']);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toMatch(/still names opcg-test-topic outside its topics/);
  });

  it('a takedown matches decoded ids, deletes a file left without topics and fails on a missing --data', () => {
    const { db, data } = seeded();
    // the id written with a JSON escape in 11-20: still the same topic
    const p20 = join(data, '2026-11-20.json');
    writeFileSync(p20, readFileSync(p20, 'utf8').replace('"opcg-test-topic"', '"opcg\\u002dtest-topic"'));
    expect(readFileSync(p20, 'utf8')).not.toContain('opcg-test-topic');
    const missing = cli([...sqliteArgs(db), '--data', join(data, 'nope'), '--remove-topic', 'opcg-test-topic', '--yes']);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/does not exist/);
    const blank = cli([...sqliteArgs(db), '--data', ' ', '--remove-topic', 'opcg-test-topic', '--yes']);
    expect(blank.status).toBe(2);
    expect(blank.stderr).toMatch(/--data is empty/);
    expect(rows(db)).toEqual([['2026-11-20', ['opcg-test-topic', 'ptcg-fixture']], ['2026-11-21', ['opcg-test-topic']]]);
    const r = cli([...sqliteArgs(db), '--data', data, '--remove-topic', 'opcg-test-topic', '--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(rows(db)).toEqual([['2026-11-20', ['ptcg-fixture']]]);
    expect(JSON.parse(readFileSync(p20, 'utf8')).topics.map((t: any) => t.id)).toEqual(['ptcg-fixture']);
    // 11-21 listed only that topic: the file goes, as its row did
    expect(readdirSync(data)).toEqual(['2026-11-20.json']);
  });

  it('a whole-snapshot takedown deletes the row and the file', () => {
    const { db, data } = seeded();
    const r = cli([...sqliteArgs(db), '--data', data, '--remove-snapshot', '2026-11-21', '--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(rows(db).map((x) => x[0])).toEqual(['2026-11-20']);
    expect(readdirSync(data)).toEqual(['2026-11-20.json']);
  });

  it('an emptied local file deletes its date on import', () => {
    const { db, data } = seeded();
    const s = JSON.parse(readFileSync(join(data, '2026-11-21.json'), 'utf8'));
    writeFileSync(join(data, '2026-11-21.json'), JSON.stringify({ ...s, topics: [] }, null, 2));
    const r = cli([...sqliteArgs(db), '--data', data, '--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/2026-11-21 {2}delete/);
    expect(rows(db).map((x) => x[0])).toEqual(['2026-11-20']);
  });
});
