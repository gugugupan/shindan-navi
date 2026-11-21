// 話題カレンダー snapshots → D1 (docs/design/voices-db.md). Reads data/voices/<date>.json, validates them with the rules
// scripts/build.py voices_data() enforces (plus contracts/voices.schema.json and checks across snapshots), and turns
// the difference against the database's voice_snapshots rows into SQL.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { CONTRACTS_DIR, REPO_DIR, sqlLiteral } from './importer.mjs';

export const DEFAULT_VOICES_DIR = join(REPO_DIR, 'data', 'voices');
// D1 rejects statements over 100 KB; one snapshot is one statement (29 topics ≈ 27 KB).
export const MAX_BODY_BYTES = 90_000;
const TOP = ['version', 'date', 'window', 'sample', 'note', 'topics'];
const TOPIC = ['id', 'game', 'title', 'summary', 'attitude', 'share', 'volume', 'voices', 'reacting_to', 'window', 'first_seen', 'status', 'source'];
const XPOST = /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/[0-9]{1,20}$/;
// an X / Twitter host anywhere in a decoded string, with or without a scheme (box.com does not match)
const ANY_X = /(?:^|[^a-z0-9-])(?:[a-z0-9-]+\.)*(?:x|twitter)\.com(?![a-z0-9-])/i;
const ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const realDate = (v) => typeof v === 'string' && DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
// Python len(): code points, not UTF-16 units
const len = (s) => [...s].length;
export const todayJst = (nowMs = Date.now()) => new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);

/** Game codes from GAMES in src/voices.html, as build.py reads them. */
export function voiceGames(src = readFileSync(join(REPO_DIR, 'src/voices.html'), 'utf8')) {
  const block = src.split('const GAMES = [')[1].split('];')[0];
  return [...block.matchAll(/\{code:'([A-Z]+)'/g)].map((m) => m[1]);
}

let schema;
const validateSchema = (s) => {
  schema ??= new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(join(CONTRACTS_DIR, 'voices.schema.json'), 'utf8')));
  return schema(s) ? [] : schema.errors.slice(0, 10).map((e) => `schema: ${e.instancePath || '/'} ${e.message}`);
};

/** [JSON pointer, value] of every string in v; object keys come under their path + '#key'. */
function* strings(v, p = '') {
  if (typeof v === 'string') yield [p, v];
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* strings(v[i], `${p}/${i}`);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      yield [`${p}/${k}#key`, k];
      yield* strings(x, `${p}/${k}`);
    }
  }
}

/**
 * One snapshot file's text. Returns {date, sample, snapshot: {date, window, topics} | null, errors, warnings}.
 * The served snapshot drops version / note / sample.
 */
export function checkSnapshot(name, text, { games = voiceGames(), today = todayJst() } = {}) {
  const errors = [];
  const bad = (m) => errors.push(`${name}: ${m}`);
  let s;
  try {
    s = JSON.parse(text);
  } catch (e) {
    bad(`not JSON (${e.message})`);
    return { errors, warnings: [] };
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    bad('not an object');
    return { errors, warnings: [] };
  }
  if (s.sample === true) return { date: s.date, sample: true, snapshot: null, errors: [], warnings: [`${name}: sample snapshot skipped (samples are never imported)`] };
  const keys = Object.keys(s);
  if (keys.some((k) => !TOP.includes(k)) || !['version', 'date', 'window', 'topics'].every((k) => keys.includes(k))) bad('wrong top-level fields');
  if (s.version !== 1) bad('version must be 1');
  const w = s.window;
  const winOk = w && typeof w === 'object' && Object.keys(w).sort().join() === 'from,to' && realDate(w.from) && realDate(w.to) && w.from <= w.to;
  if (!winOk) bad('bad window');
  if (!(realDate(s.date) && winOk && s.date === w.to && s.date === name.replace(/\.json$/, ''))) bad('file name, date and window.to must match');
  if (realDate(s.date) && s.date > today) bad(`date ${s.date} is after today (${today}, Asia/Tokyo)`);
  if ('sample' in s && typeof s.sample !== 'boolean') bad('sample must be true/false');
  if (!Array.isArray(s.topics)) {
    bad('topics must be a list');
    return { errors, warnings: [] };
  }
  errors.push(...validateSchema(s).map((e) => `${name}: ${e}`));
  const ids = new Set();
  for (const t of s.topics) {
    const tid = t && typeof t === 'object' ? t.id : '?';
    const tbad = (m) => bad(`topic ${tid}: ${m}`);
    if (!t || typeof t !== 'object') {
      tbad('not an object');
      continue;
    }
    if ('posts' in t) tbad('posts: player post URLs are never committed (contracts/voices.md)');
    const tk = Object.keys(t);
    const diff = [...tk.filter((k) => !TOPIC.includes(k)), ...TOPIC.filter((k) => !tk.includes(k))].sort();
    if (diff.length) {
      tbad(`fields ${JSON.stringify(diff)}`);
      continue;
    }
    if (typeof tid !== 'string' || !ID.test(tid) || ids.has(tid)) tbad('bad or duplicate id');
    ids.add(tid);
    if (!games.includes(t.game)) tbad(`unknown game ${t.game} (GAMES in src/voices.html)`);
    for (const [k, n] of [['title', 40], ['summary', 160]]) {
      if (typeof t[k] !== 'string' || !t[k].trim() || len(t[k]) > n) tbad(`${k} empty or over ${n} characters`);
    }
    if (!['positive', 'negative', 'mixed', 'neutral'].includes(t.attitude)) tbad('attitude');
    const sh = t.share;
    const shOk = sh && typeof sh === 'object' && Object.keys(sh).sort().join() === 'negative,neutral,positive'
      && Object.values(sh).every((v) => Number.isInteger(v) && v >= 0) && Object.values(sh).reduce((a, b) => a + b, 0) > 0;
    if (!shOk) tbad('share');
    if (!['high', 'mid', 'low'].includes(t.volume)) tbad('volume');
    if (!(Array.isArray(t.voices) && t.voices.length <= 3 && t.voices.every((v) => typeof v === 'string' && v.trim() && len(v) <= 80))) tbad('voices: at most 3 strings of 1-80 characters');
    if (t.reacting_to !== null && !(typeof t.reacting_to === 'string' && XPOST.test(t.reacting_to))) tbad('reacting_to must be an x.com status URL or null');
    const tw = t.window;
    if (!(tw && typeof tw === 'object' && Object.keys(tw).length === 2 && w && tw.from === w.from && tw.to === w.to)) tbad('window differs from the snapshot window');
    if (!realDate(t.first_seen) || t.first_seen > s.date) tbad('first_seen after the snapshot date');
    if (!['new', 'continuing', 'cooling'].includes(t.status)) tbad('status');
    if (!['grok-app', 'openrouter', 'x-api'].includes(t.source)) tbad('source');
  }
  // every decoded string (note and keys included): an X / Twitter URL is only ever a topic's own reacting_to, checked above
  for (const [p, v] of strings(s)) if (!/^\/topics\/\d+\/reacting_to$/.test(p) && ANY_X.test(v)) bad(`X URL outside a topic's reacting_to at ${p}: ${v.slice(0, 80)}`);
  if (errors.length) return { date: s.date, sample: false, snapshot: null, errors, warnings: [] };
  return { date: s.date, sample: false, snapshot: { date: s.date, window: s.window, topics: s.topics }, errors, warnings: [] };
}

/** Every <date>.json in dir: {snapshots: Map date → snapshot, files: Map date → path, errors, warnings}. */
export function loadVoices(dir, opts = {}) {
  const out = { snapshots: new Map(), files: new Map(), errors: [], warnings: [] };
  if (!existsSync(dir)) return out;
  const games = opts.games ?? voiceGames();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const r = checkSnapshot(f, readFileSync(join(dir, f), 'utf8'), { ...opts, games });
    out.errors.push(...r.errors);
    out.warnings.push(...r.warnings);
    if (r.snapshot) {
      out.snapshots.set(r.date, r.snapshot);
      out.files.set(r.date, join(dir, f));
    }
  }
  return out;
}

/**
 * Checks across snapshots (oldest first): an id keeps its game and first_seen, first_seen is not after the id's
 * first appearance, and `new` only marks that first appearance. A `continuing` / `cooling` id without an earlier
 * snapshot is only a warning: the first snapshot and a takedown of an earlier day both leave such ids.
 */
export function checkTimeline(snapshots) {
  const errors = [];
  const warnings = [];
  const seen = new Map();
  for (const s of [...snapshots].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    for (const t of s.topics) {
      const prev = seen.get(t.id);
      if (!prev) {
        seen.set(t.id, { game: t.game, first_seen: t.first_seen, date: s.date });
        if (t.status !== 'new') warnings.push(`${s.date}: topic ${t.id} is ${t.status} but no earlier snapshot lists it`);
        continue;
      }
      if (t.game !== prev.game) errors.push(`${s.date}: topic ${t.id} game ${t.game} != ${prev.game} on ${prev.date} (an id keeps its game)`);
      if (t.first_seen !== prev.first_seen) errors.push(`${s.date}: topic ${t.id} first_seen ${t.first_seen} != ${prev.first_seen} on ${prev.date} (first_seen stays fixed)`);
      if (t.status === 'new') errors.push(`${s.date}: topic ${t.id} is new but ${prev.date} already lists it (use continuing / cooling, or a new id)`);
    }
  }
  return { errors, warnings };
}

export const bodyOf = (snapshot) => JSON.stringify({ date: snapshot.date, window: snapshot.window, topics: snapshot.topics });
export const hashOf = (body) => createHash('sha256').update(body).digest('hex');

/** Removes topic ids from every snapshot; a snapshot left without topics keeps topics [] (planVoices deletes its row). */
export function removeTopics(snapshots, ids) {
  const out = new Map();
  for (const [d, s] of snapshots) {
    const topics = s.topics.filter((t) => !ids.includes(t.id));
    out.set(d, topics.length === s.topics.length ? s : { ...s, topics });
  }
  return out;
}

/**
 * desired: Map date → snapshot; current: Map date → {hash}. A desired date with topics [] (an emptied local file, a
 * takedown) deletes its row. A row whose date is not in desired at all is deleted only with prune.
 * Returns {rows: [{date, action, topics}], statements, writes}.
 */
export function planVoices(desired, current, { prune = false, now = new Date(), hasVersion = true } = {}) {
  const rows = [];
  const upserts = [];
  const deletes = [];
  for (const [date, s] of [...desired].sort()) {
    if (!s.topics.length) {
      if (current.has(date)) {
        rows.push({ date, action: 'delete', topics: null });
        deletes.push(date);
      }
      continue;
    }
    const body = bodyOf(s);
    const hash = hashOf(body);
    const cur = current.get(date);
    const action = !cur ? 'insert' : cur.hash === hash ? 'unchanged' : 'update';
    rows.push({ date, action, topics: s.topics.length, bytes: Buffer.byteLength(body) });
    if (action !== 'unchanged') upserts.push({ date, body, hash });
  }
  for (const date of [...current.keys()].sort()) {
    if (desired.has(date)) continue;
    rows.push({ date, action: prune ? 'delete' : 'kept (no local file; --prune deletes)', topics: null });
    if (prune) deletes.push(date);
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  const big = upserts.filter((u) => Buffer.byteLength(u.body) > MAX_BODY_BYTES);
  if (big.length) throw new Error(`snapshot(s) over ${MAX_BODY_BYTES} bytes (D1 statement limit): ${big.map((u) => u.date).join(', ')}`);
  const at = now.toISOString();
  const statements = upserts.map((u) =>
    `INSERT INTO voice_snapshots (date, body, hash, updated_at) VALUES (${sqlLiteral(u.date)}, ${sqlLiteral(u.body)}, ${sqlLiteral(u.hash)}, ${sqlLiteral(at)})\n`
    + 'ON CONFLICT(date) DO UPDATE SET body = excluded.body, hash = excluded.hash, updated_at = excluded.updated_at');
  if (deletes.length) statements.push(`DELETE FROM voice_snapshots WHERE date IN (${deletes.map(sqlLiteral).join(', ')})`);
  const changed = statements.length > 0;
  const version = String(now.getTime());
  if (changed || !hasVersion) {
    statements.push(`INSERT INTO voice_meta (key, value) VALUES ('version', ${sqlLiteral(version)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  }
  return { rows, statements, version, writes: upserts.length + deletes.length + (statements.length ? 1 : 0) };
}

export const VOICES_TABLE_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('voice_snapshots', 'voice_meta')";
export const VOICES_STATE_SQL = 'SELECT date, body, hash FROM voice_snapshots ORDER BY date';
export const VOICES_VERSION_SQL = "SELECT value FROM voice_meta WHERE key = 'version'";

/** Database rows → {current: Map date → {hash}, snapshots: Map date → snapshot}. */
export function voicesState(rows) {
  const current = new Map();
  const snapshots = new Map();
  for (const r of rows) {
    current.set(r.date, { hash: r.hash });
    snapshots.set(r.date, JSON.parse(r.body));
  }
  return { current, snapshots };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Wrangler output with every UUID and the D1_DATABASE_ID value replaced: the database id is never printed. */
export function redact(text, secret = process.env.D1_DATABASE_ID) {
  let out = String(text ?? '').replace(UUID, '<redacted>');
  const id = (secret ?? '').trim();
  if (id) out = out.split(id).join('<redacted>');
  return out;
}
