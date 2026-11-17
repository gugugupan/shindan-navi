import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detailUrl, normalizeEvent, parseFee, PREF_CODE, sortEvents } from '../lib/normalize.mjs';
import { buildOutputs, makeValidators } from '../lib/output.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, 'fixtures', 'event-search-rows.json'), 'utf8'));
const byId = (id) => rows.find((r) => r.event_holding_id === id);
const SEEN = '2026-11-18T00:00:00Z';
const validators = makeValidators(resolve(here, '..', '..', '..'));

test('fee: free and plain yen amounts only', () => {
  assert.deepEqual(parseFee('無料'), { fee_amount: 0, fee_currency: 'JPY', fee_text: '無料' });
  assert.deepEqual(parseFee('200円'), { fee_amount: 200, fee_currency: 'JPY', fee_text: '200円' });
  assert.deepEqual(parseFee('1,000円'), { fee_amount: 1000, fee_currency: 'JPY', fee_text: '1,000円' });
  assert.equal(parseFee('¥300').fee_amount, 300);
  assert.deepEqual(parseFee('1パック購入'), { fee_amount: null, fee_currency: null, fee_text: '1パック購入' });
  assert.equal(parseFee('300円（高校生以下無料）').fee_amount, null);
  assert.equal(parseFee('100').fee_amount, null);
  assert.deepEqual(parseFee(''), { fee_amount: null, fee_currency: null, fee_text: null });
});

test('prefecture codes follow ISO 3166-2:JP order', () => {
  assert.equal(PREF_CODE['北海道'], 'JP-01');
  assert.equal(PREF_CODE['東京都'], 'JP-13');
  assert.equal(PREF_CODE['沖縄県'], 'JP-47');
  assert.equal(Object.keys(PREF_CODE).length, 47);
});

test('gym event row maps to contract fields', () => {
  const row = byId(1169952);
  const e = normalizeEvent(row, SEEN);
  assert.equal(e.id, 'ptcg:1169952');
  assert.equal(e.source_url, detailUrl(row));
  assert.match(e.source_url, /^https:\/\/players\.pokemon-card\.com\/event\/detail\/1169952\/1\/\d+\/20261121\/\d+$/);
  assert.equal(e.group.event_type_code, 'gym_event');
  assert.equal(e.group.name, 'ジムイベント');
  assert.equal(e.starts_on, '2026-11-21');
  assert.match(e.starts_at, /^2026-11-21T\d{2}:\d{2}:00\+09:00$/);
  assert.equal(e.fee_amount, 0);
  assert.equal(e.capacity, row.capacity);
  assert.equal(e.registration_status, 'unknown');
  assert.equal(e.registration_method, 'unknown');
  assert.equal(e.venue.region_code, PREF_CODE[row.prefecture_name]);
  assert.match(e.venue.postal_code, /^\d{3}-\d{4}$/);
});

test('category comes from event type, then attribute', () => {
  assert.equal(normalizeEvent(byId(1186761), SEEN).group.category, 'tournament'); // trainers league
  assert.equal(normalizeEvent(byId(1186798), SEEN).group.category, 'tournament'); // gym, 真剣勝負
  assert.equal(normalizeEvent(byId(1169688), SEEN).group.category, 'unknown'); // organizer, 初心者歓迎
  const teaching = rows.find((r) => r.event_attr_id === 1 && r.event_type !== 1 && r.event_type !== 2 && r.event_type !== 3);
  assert.equal(normalizeEvent(teaching, SEEN).group.category, 'teaching');
});

test('league division becomes eligibility text; その他 stays null', () => {
  assert.equal(normalizeEvent(byId(1186761), SEEN).eligibility_text, 'オープンリーグ');
  assert.equal(normalizeEvent(byId(1169952), SEEN).eligibility_text, null);
});

test('separate venue drops the organizer shop id', () => {
  const row = byId(1168984);
  const e = normalizeEvent(row, SEEN);
  assert.equal(e.venue.name, row.venue);
  assert.equal(e.venue.source_id, null);
  assert.equal(normalizeEvent(byId(1169952), SEEN).venue.source_id, String(byId(1169952).shop_id));
});

test('discontinued events are cancelled', () => {
  assert.equal(normalizeEvent(byId(1186837), SEEN).event_status, 'cancelled');
  assert.equal(normalizeEvent(byId(1169952), SEEN).event_status, 'scheduled');
});

test('times: end before start is dropped, missing start is date precision', () => {
  const base = byId(1169952);
  const e = normalizeEvent({ ...base, event_started_at: '9:00', event_ended_at: '8:30' }, SEEN);
  assert.equal(e.starts_at, '2026-11-21T09:00:00+09:00');
  assert.equal(e.ends_at, null);
  const d = normalizeEvent({ ...base, event_started_at: '', event_ended_at: '' }, SEEN);
  assert.equal(d.time_precision, 'date');
  assert.equal(d.starts_at, null);
});

test('all fixture rows validate and sort per contract', () => {
  const events = sortEvents(rows.map((r) => normalizeEvent(r, SEEN)));
  const run = {
    game_code: 'PTCG', source_code: 'pokemon_players', fetched_at: SEEN,
    window: { from: '2026-11-18', until: '2027-02-18' }, query: {}, source_total: events.length,
    record_count: events.length, complete: true, collector_version: 'test', notes: [],
  };
  const files = buildOutputs(events, run, validators);
  assert.deepEqual(Object.keys(files).sort(), ['2026-11.json', '_run.json']);
  for (let i = 1; i < events.length; i += 1) {
    const [a, b] = [events[i - 1], events[i]];
    assert.ok(a.starts_on < b.starts_on || (a.starts_on === b.starts_on && ((a.starts_at ?? '~') < (b.starts_at ?? '~') || (a.starts_at === b.starts_at && a.id < b.id))));
  }
});

test('schema violations throw before any output', () => {
  const bad = { ...normalizeEvent(rows[0], SEEN), capacity: -1 };
  assert.throws(() => buildOutputs([bad], {}, validators), /event\.schema\.json/);
});

test('venue keeps the first line and never contact details', async () => {
  const { venueLabel } = await import('../lib/normalize.mjs');
  assert.equal(venueLabel('会場ホール\nTEL: 000-000-0000'), '会場ホール');
  assert.equal(venueLabel('TEL 0000-00-0000\n営業時間 9時から'), null);
  assert.equal(venueLabel('連絡先 someone@example.com'), null);
  assert.equal(venueLabel('トーナメントセンター satellite駅前'), 'トーナメントセンター satellite駅前');
  const row = { ...byId(1169952), venue: 'TEL 0000-00-0000' };
  const e = normalizeEvent(row, SEEN);
  assert.equal(e.venue.name, row.shop_name);
  assert.equal(e.venue.source_id, String(row.shop_id));
});

test('output refuses contact-like text', () => {
  const e = { ...normalizeEvent(rows[0], SEEN), fee_text: '問合せ someone@example.com' };
  assert.throws(() => buildOutputs([e], {}, validators), /contact-like/);
});
