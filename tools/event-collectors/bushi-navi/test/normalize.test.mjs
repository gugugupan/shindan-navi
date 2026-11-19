import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenGroups } from '../lib/collect.mjs';
import { buildingOf, classify, containsContact, geoFrom, isOffsite, normalizeEvent, parseFee, sortEvents, splitPlace, toJst } from '../lib/normalize.mjs';
import { buildOutputs, makeValidators } from '../lib/output.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..', '..');
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'event-list.json'), 'utf8')).success;
const rows = flattenGroups(fixture.organizer_event_series);
const byId = (id) => rows.find((r) => r.id === id);
const SEEN = '2026-11-19T10:00:00Z';
const validators = makeValidators(repo);

test('a cancelled free shop event maps to the contract', () => {
  const e = normalizeEvent(byId(1799515), 'HOCG', SEEN);
  assert.deepEqual(e, {
    id: 'bnavi:1799515',
    game_code: 'HOCG',
    source_code: 'bushinavi',
    external_id: '1799515',
    source_url: 'https://www.bushi-navi.com/series/3486/organizer/913',
    group: { source_id: '3486', name: '11月度 hololive OFFICIAL CARD GAME ショップ大会(2026)', category: 'tournament', event_type_code: 'shop_tournament' },
    name: '11月度 hololive OFFICIAL CARD GAME ショップ大会(2026)',
    attendance_mode: 'in_person',
    venue: {
      name: '竜星の嵐 新宿店', source_id: '913', country_code: 'JP', region_code: 'JP-13', region_name: '東京都', city: null,
      address: '新宿区西新宿1-18-1 小川ビル5階', postal_code: null,
      geo: { lat: 35.688915, lng: 139.698593, source: 'bushinavi', precision: null, place_id: null, geocoded_at: null },
    },
    starts_on: '2026-11-19',
    ends_on: null,
    starts_at: '2026-11-19T15:00:00+09:00',
    ends_at: null,
    timezone: 'Asia/Tokyo',
    time_precision: 'datetime',
    format_text: 'スタンダード',
    eligibility_text: null,
    capacity: 16,
    fee_amount: 0,
    fee_currency: 'JPY',
    fee_text: '参加費無料',
    registration_method: 'first_come',
    registration_platform: 'bushinavi',
    registration_url: 'https://www.bushi-navi.com/series/3486/organizer/913',
    registration_opens_at: null,
    registration_closes_at: null,
    registration_status: 'unknown',
    event_status: 'cancelled',
    source_status_text: 'status_id=11;canceled=1;series_type=1;organizer_type=1;entry_method=1;no_advance=0;requirement_type=1;team_count=1;hidden=',
    last_seen_at: SEEN,
  });
});

test('series titles pick the type; plain fees are amounts', () => {
  const e = normalizeEvent(byId(1810388), 'WS', SEEN);
  assert.equal(e.group.event_type_code, 'cx_challenge');
  assert.equal(e.event_status, 'scheduled');
  assert.deepEqual([e.fee_amount, e.fee_currency, e.fee_text], [500, 'JPY', '参加費 500円']);
  assert.equal(e.venue.region_code, 'JP-23');
});

test('fees: only free and plain 参加費 give an amount', () => {
  assert.deepEqual(parseFee(1, '0.000'), { fee_amount: 0, fee_currency: 'JPY', fee_text: '参加費無料' });
  assert.deepEqual(parseFee(6, '1000.000'), { fee_amount: 1000, fee_currency: 'JPY', fee_text: '参加費（参加賞1パック付） 1,000円' });
  assert.deepEqual(parseFee(2, '0.000'), { fee_amount: null, fee_currency: null, fee_text: '1パック購入' });
  assert.deepEqual(parseFee(7, '300.000'), { fee_amount: null, fee_currency: null, fee_text: '参加費（会員価格設定） 300円' });
  assert.deepEqual(parseFee(3, '0.000'), { fee_amount: null, fee_currency: null, fee_text: '参加費' });
  assert.deepEqual(parseFee(undefined, null), { fee_amount: null, fee_currency: null, fee_text: null });
});

test('hidden start time, hidden capacity, team events, walk-in and finished statuses', () => {
  const base = byId(1808563);
  const hidden = normalizeEvent({ ...base, group: { ...base.group, is_start_datetime_hidden: true, is_max_join_count_hidden: true } }, 'WS', SEEN);
  assert.deepEqual([hidden.starts_on, hidden.starts_at, hidden.time_precision, hidden.capacity], ['2026-11-21', null, 'date', null]);
  const trio = normalizeEvent({ ...base, max_join_count: 8, group: { ...base.group, team_count: 3 } }, 'WS', SEEN);
  assert.deepEqual([trio.capacity, trio.eligibility_text], [null, '3人チーム戦（定員8チーム）']);
  const walkIn = normalizeEvent({ ...base, is_no_advance_application: true }, 'WS', SEEN);
  assert.deepEqual([walkIn.registration_method, walkIn.registration_platform, walkIn.registration_url], ['walk_in', null, null]);
  const lottery = normalizeEvent({ ...base, entry_method: 3, status_id: 21 }, 'WS', SEEN);
  assert.deepEqual([lottery.registration_method, lottery.registration_status], ['lottery', 'closed']);
  const firstCome = normalizeEvent({ ...base, status_id: 21 }, 'WS', SEEN);
  assert.equal(firstCome.registration_status, 'unknown');
  const done = normalizeEvent({ ...base, status_id: 61 }, 'WS', SEEN);
  assert.deepEqual([done.event_status, done.registration_status], ['completed', 'closed']);
});

test('classify: title rules first, then series_type', () => {
  assert.deepEqual(classify('12月度 ホロカ交流会(2026)', 1), { category: 'casual', event_type_code: 'meetup' });
  assert.deepEqual(classify('【D】VG 12月度ショップファイト スタンダード (2026)', 1), { category: 'tournament', event_type_code: 'shop_tournament' });
  assert.deepEqual(classify('【個人戦】12月開催 Championship (2026)', 3), { category: 'tournament', event_type_code: 'championship' });
  assert.deepEqual(classify('【DAY1】WGPデラックス2026 Season2 東京会場 イラストレーターサイン会', 2), { category: 'other', event_type_code: 'signing' });
  assert.deepEqual(classify('Persona 30th Anniversary カップ', 3), { category: 'tournament', event_type_code: 'cs' });
  assert.deepEqual(classify(null, 9), { category: 'tournament', event_type_code: null });
});

test('official organizers are named by the building only, else by the organizer, without a shop id', () => {
  const base = byId(1808563);
  const official = { ...base, group: { ...base.group, organizer_type: 2, organizer_name: 'ヴァンガード公式' } };
  const e = normalizeEvent({ ...official, pref_code: 13, place: ' 江東区有明3-11-1\u3000東京ビッグサイト 南4ホール' }, 'VG', SEEN);
  assert.deepEqual([e.venue.name, e.venue.source_id, e.venue.address], ['東京ビッグサイト 南4ホール', null, '江東区有明3-11-1 東京ビッグサイト 南4ホール']);
  const plain = normalizeEvent(official, 'VG', SEEN);
  assert.deepEqual([plain.venue.name, plain.venue.source_id, plain.venue.address], ['ヴァンガード公式', null, '大館市常盤木町12-24']);
});

test('buildingOf keeps what follows the street number, not a bare floor', () => {
  const cases = [
    ['中野区中野2-9-7\u3000なかのZERO 西館\u30003F', 'なかのZERO 西館 3F'],
    ['熊本市中央区桜町3番40号 熊本城ホール３F大会議室', '熊本城ホール3F大会議室'],
    ['大阪市浪速区日本橋3丁目8-16安田ビル2F', '安田ビル2F'],
    ['名古屋市中村区 椿町11-1\u3000Vプラザ7-10階', 'Vプラザ7-10階'],
    ['金沢市袋畠町南193番地', null],
    ['福岡市博多区 博多駅中央街9-1 7階', null],
    ['金沢市 此花町3-2\u3000B1F', null],
    ['長野市川中島町 御厨字堂野946-3', null],
    ['札幌市中央区南1条西4丁目2 札幌パルコ7F', '札幌パルコ7F'],
    ['江東区有明3丁目 11-1 東京ビッグサイト 南4ホール', '東京ビッグサイト 南4ホール'],
    ['金沢市本町9番地の1 金沢フォーラス6F', '金沢フォーラス6F'],
    ['新潟市東区古川町4-12 中地区公民館 ４階 講座室', '中地区公民館 4階 講座室'],
    [null, null],
  ];
  for (const [address, building] of cases) assert.equal(buildingOf(address), building, address);
});

test('a shop event held elsewhere is named by its building, else the address; postcode and prefecture split off', () => {
  const base = byId(1808563);
  const row = { ...base, pref_code: 13, place: '〒170-0013 東京都豊島区東池袋１丁目２０−１０　としま区民センター 504', place_geo: { x: 35.7303, y: 139.7174 } };
  assert.ok(isOffsite(row));
  const e = normalizeEvent(row, 'WS', SEEN);
  assert.deepEqual([e.venue.name, e.venue.source_id, e.venue.address, e.venue.postal_code],
    ['としま区民センター 504', null, '東京都豊島区東池袋1丁目20−10 としま区民センター 504', '170-0013']);
  const bare = normalizeEvent({ ...row, place: '習志野市津田沼1-3-11 8F' }, 'WS', SEEN);
  assert.deepEqual([bare.venue.name, bare.venue.source_id], ['習志野市津田沼1-3-11 8F', null]);
  assert.equal(e.venue.geo.lat, 35.7303);
  // 100 m away is the same shop.
  assert.ok(!isOffsite({ ...base, place_geo: { x: base.place_geo.x + 0.0009, y: base.place_geo.y } }));
  assert.deepEqual(splitPlace('大館市常盤木町12-24', '秋田県'), { address: '大館市常盤木町12-24', postal_code: null, label: '大館市常盤木町12-24' });
});

test('geo, times and contact checks', () => {
  assert.equal(geoFrom({ x: 0, y: 0 }), null);
  assert.equal(geoFrom(null), null);
  assert.equal(toJst('2026-11-30T15:30:00+00:00'), '2026-12-01T00:30:00+09:00');
  assert.ok(containsContact('お問い合わせ 03-1234-5678'));
  assert.ok(containsContact('09012345678'));
  assert.ok(!containsContact('名古屋市中村区椿町11-1 Vプラザ7-10階'));
  assert.ok(!containsContact('港区1-23-456', { address: true }));
  for (const a of ['江東区有明3-11-1 東京ビッグサイト', '中野区中野2-9-7 なかのZERO', '豊島区東池袋1-20-10 としま区民センタ-504', '名古屋市中村区椿町11-1 Vプラザ7-10階', '港区10-203-1001']) {
    assert.ok(!containsContact(a, { address: true }), a);
  }
  for (const a of ['渋谷区1-2-3 03-1234-5678', '大阪市北区1-2 06-6123-4567', 'ＸＸビル ０３－１２３４－５６７８', '0120-123-456']) {
    assert.ok(containsContact(a, { address: true }), a);
  }
});

test('normalized fixture rows pass the contract and split by month', () => {
  const events = sortEvents(rows.map((r) => normalizeEvent(r, 'WS', SEEN)));
  const run = {
    game_code: 'WS', source_code: 'bushinavi', fetched_at: SEEN, window: { from: '2026-11-18', until: '2027-02-18' },
    query: {}, source_total: null, record_count: events.length, complete: true, collector_version: 'test', notes: [],
  };
  const files = buildOutputs(events, run, validators);
  assert.deepEqual(Object.keys(files), ['2026-11.json', '_run.json']);
  assert.equal(files['2026-11.json'].length, 6);
  assert.equal(files['2026-11.json'][0].id, 'bnavi:1799515');
});

test('buildOutputs refuses contact-like text', () => {
  const e = normalizeEvent(byId(1808563), 'WS', SEEN);
  const run = { game_code: 'WS', source_code: 'bushinavi', fetched_at: SEEN, window: { from: '2026-11-18', until: '2027-02-18' }, query: {}, source_total: null, record_count: 1, complete: true, collector_version: 'test', notes: [] };
  assert.throws(() => buildOutputs([{ ...e, name: '大会 TEL 0312345678' }], run, validators), /contact-like/);
});
