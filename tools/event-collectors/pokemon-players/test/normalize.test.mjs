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
const validators = makeValidators(resolve(here, '..', '..', '..', '..'));

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

test('fee: NFKC single amounts are accepted', () => {
  const ok = {
    '５００円': 500, '現金300円': 300, '参加費200円': 200, '参加費：300円': 300, '参加費 300円': 300,
    '1,000円': 1000, '１，０００円': 1000, '300円（税込）': 300, '300円(税込)': 300, '現金300円（税込）': 300,
    '¥300': 300, '￥３００': 300,
    '500円（現金のみ）': 500, '300円(現金決済のみ)': 300, '200円/現金のみ': 200, '一人100円': 100,
    '200円！！': 200, '200円!': 200, '300円（税込）（現金のみ）': 300, '無料': 0, '0円': 0, '０円': 0, '参加費無料': 0, '参加費0円': 0,
  };
  for (const [raw, amount] of Object.entries(ok)) {
    assert.deepEqual(parseFee(raw), { fee_amount: amount, fee_currency: 'JPY', fee_text: raw }, raw);
  }
});

test('fee: conditional, ranged, multi-amount and purchase fees stay null', () => {
  for (const raw of [
    '1パック購入', '１パック購入、学生無料', '300円（高校生以下無料）', '300円（小中高生200円）',
    '200円（商品500円購入で参加費無料）', '現金300円または350円以上のお買い物', '300円orワンオーダー',
    '2パック購入或いは200円', '関連商品購入：300円', '100円　（見学は無料です）', '300円(税込) ※現金支払いのみ',
    '300円～500円', '300-500円', '100', '1,00円', '300円 エントリー方法：2F受付30分前から先着', 'お一人300円/大人のみ',
    '2時間毎にドリンク1本付き300円', '無料（要予約）',
    '500円（現金のみ可）', '大人のみ２００円', '一人100円（中学生以下無料）', '200円（ドリンクバー付き）', '!200円', '200円/現金',
  ]) {
    assert.deepEqual(parseFee(raw), { fee_amount: null, fee_currency: null, fee_text: raw }, raw);
  }
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

// Real list rows (2026-11-19 run) whose free-text 会場 was shown as the venue name.
const shopRow = (over) => ({ ...byId(1169952), shop_term: 1, ...over });
const REPORTED = [
  [{ shop_id: 10914, shop_name: 'シゲヤ', venue: '市バス平野宮町2丁目降りて進行方向に歩いて2－3分', address: '大阪府大阪市平野区平野市町3丁目5-14', prefecture_name: '大阪府' }, 'シゲヤ'],
  [{ shop_id: 10893, shop_name: 'トイコンプ　大阪駅前第3ビル店', venue: '大阪駅前第3ビルの2階！\n毎日ジムバトルやってます！', address: '大阪府大阪市北区梅田1-1-3　2F-21', prefecture_name: '大阪府' }, 'トイコンプ　大阪駅前第3ビル店'],
  [{ shop_id: 18397, shop_name: 'カードショップJoe', venue: '守口市大枝西町17-15', address: '大阪府守口市大枝西町17-15', prefecture_name: '大阪府' }, 'カードショップJoe'],
];

test('shop events are named after the shop, not the free-text 会場', () => {
  for (const [over, name] of REPORTED) {
    const e = normalizeEvent(shopRow(over), SEEN);
    assert.equal(e.venue.name, name);
    assert.equal(e.venue.address, over.address);
    assert.equal(e.venue.source_id, null); // own free text keeps the fp cache key, as before
  }
  const seats = normalizeEvent(byId(1186915), SEEN);
  assert.equal(seats.venue.name, byId(1186915).shop_name);
});

test('organizer events: a place line from 会場, else the address, else a pointer to the detail page', async () => {
  const { VENUE_UNKNOWN } = await import('../lib/normalize.mjs');
  const org = (over) => ({ ...byId(1168984), shop_term: 2, shop_name: 'ニックネーム', ...over });
  const name = (over) => normalizeEvent(org(over), SEEN).venue.name;
  assert.equal(name({ venue: '豊島区巣鴨3-28-7 大木ビル3F\nボードゲームカフェ ASOBAKO', address: '東京都豊島区巣鴨3-28-7 大木ビル3F', prefecture_name: '東京都' }), 'ボードゲームカフェ ASOBAKO');
  assert.equal(name({ venue: '篠路コミュニティーセンターにて行います。' }), '篠路コミュニティーセンター');
  assert.equal(name({ venue: '開催会場：ONEポケ\n伊勢崎から店舗移転していますのでご注意ください。' }), 'ONEポケ');
  assert.equal(name({ venue: 'ホビーステーション 町田店様' }), 'ホビーステーション 町田店');
  assert.equal(name({ venue: '', address: '茨城県土浦市中神立町18-2', prefecture_name: '茨城県' }), '土浦市中神立町18-2');
  assert.equal(name({ venue: 'JR茨木駅　東出口より徒歩約２分', address: '大阪府茨木市駅前１丁目３番９号　生田ビル３０１号', prefecture_name: '大阪府' }), '茨木市駅前１丁目３番９号　生田ビル３０１号');
  assert.equal(name({ venue: 'レンタルスペースなど\nご参加確定後、DMにて公開致しますが、神田駅近辺が多いです。', address: '東京都', prefecture_name: '東京都' }), VENUE_UNKNOWN);
  assert.equal(normalizeEvent(org({ venue: '' }), SEEN).venue.source_id, String(byId(1168984).shop_id));
});

test('major tournaments without a shop term use the 会場 text', () => {
  const row = { ...byId(1169952), shop_term: null, shop_name: null, shop_id: null, venue: '幕張メッセ　展示ホール4・5・6', address: '千葉県千葉市美浜区中瀬2丁目1', prefecture_name: '千葉県' };
  assert.equal(normalizeEvent(row, SEEN).venue.name, '幕張メッセ　展示ホール4・5・6');
});

test('placeLabel skips addresses, directions, notes, floors and generic spaces', async () => {
  const { placeLabel } = await import('../lib/normalize.mjs');
  for (const s of [
    '市バス平野宮町2丁目降りて進行方向に歩いて2－3分', '大阪駅前第3ビルの2階！', '守口市大枝西町17-15',
    '〒652-0897 兵庫県神戸市兵庫区駅南通5丁目4－55', 'さいたま市中央区大字下落合1712', '南海電鉄 難波駅南改札口より徒歩8分',
    'デュエルスペース（プレイスペース）は3Fとなります。', '対戦スペース 32席', 'デュエルスペース', '2F トレカコーナー',
    '■注意事項', '無料駐輪場あり（約15台）', '部屋の開場13:00 対戦開始13:30', 'TEL 0000-00-0000',
  ]) assert.equal(placeLabel(s), null, s);
  assert.equal(placeLabel('長崎市民会館　6F 第七会議室＋第八会議室'), '長崎市民会館　6F 第七会議室＋第八会議室');
  assert.equal(placeLabel('東京都豊島区東池袋1-20-10', '東京都豊島区東池袋1-20-10'), null);
});

test('renameVenues keeps geo and carries the cache entry to the renamed key', async () => {
  const { renameVenues } = await import('../lib/renormalize.mjs');
  const { venueKey } = await import('../../lib/venue-cache.mjs');
  const [[over]] = REPORTED;
  const row = shopRow(over);
  const geo = { lat: 34.6, lng: 135.5, source: 'ptcg', precision: null, place_id: null, geocoded_at: null };
  const old = normalizeEvent(row, SEEN);
  old.venue.name = over.venue;
  old.venue.geo = geo;
  const oldKey = venueKey(old.venue);
  const cache = { entries: { [oldKey]: { name: over.venue, address: over.address, geo, checked_at: '2026-11-19' } } };
  const { changes, missing } = renameVenues([old], new Map([[String(row.event_holding_id), row]]), cache);
  assert.equal(missing, 0);
  assert.deepEqual(changes.map((c) => c.to), ['シゲヤ']);
  assert.deepEqual(old.venue.geo, geo);
  assert.deepEqual(cache.entries[venueKey(old.venue)].geo, geo);
  assert.equal(cache.entries[venueKey(old.venue)].name, 'シゲヤ');
  assert.equal(renameVenues([old], new Map([[String(row.event_holding_id), row]]), cache).changes.length, 0);
});

test('placeLabel rejects notes, hours and bare rooms but keeps rooms inside a named facility', async () => {
  const { placeLabel } = await import('../lib/normalize.mjs');
  for (const s of [
    '交通アクセス', '多目的トイレ（オストメイト有）', '年中無休', 'お手洗いは2階です', '平日：火～金１４時ー１９時',
    '公共交通機関(バス・電車)', 'AED常備', '飲食禁止(ふた付き飲み物可)', '研修室4', '会議室2', '本堂2F', 'レンタルの会議室',
    '施設内集会室', '店内対戦スペース', '2027年　1月10日（日）　9階　『第3学習室』', 'xアカウント【＠cardshop_kaede】',
  ]) assert.equal(placeLabel(s), null, s);
  assert.equal(placeLabel('諏訪湖ハイツ\n研修室'), '諏訪湖ハイツ');
  assert.equal(placeLabel('とかちプラザ4F　研修室'), 'とかちプラザ4F　研修室');
  for (const s of ['山梨県立青少年センター', '東京都立産業貿易センター', '大阪府立体育会館', '北海道立総合体育センター']) {
    assert.equal(placeLabel(s), s, s);
  }
});

test('placeLabel strips label prefixes, trailers and @handles', async () => {
  const { placeLabel } = await import('../lib/normalize.mjs');
  assert.equal(placeLabel('店舗名：TCG SHOP CIAN様\nOwl大江の2階'), 'TCG SHOP CIAN');
  assert.equal(placeLabel('会場名：三洋堂書店　みのかも店\n店内2階の対戦スペースをお借りして開催します。'), '三洋堂書店　みのかも店');
  assert.equal(placeLabel('場所　うるま市福祉健康センターうるみん（第二交流室）'), 'うるま市福祉健康センターうるみん（第二交流室）');
  assert.equal(placeLabel('金谷北地域交流センター開催'), '金谷北地域交流センター');
  assert.equal(placeLabel('タッチ松本店様デュエルスペースにて開催中'), 'タッチ松本店様デュエルスペース');
  assert.equal(placeLabel('ブックオフ溝ノ口店 対戦スペースにて受け付け'), 'ブックオフ溝ノ口店 対戦スペース');
  assert.equal(placeLabel('浦和コミュニティセンター／'), '浦和コミュニティセンター');
  assert.equal(placeLabel('カードショップキャット 綾瀬店（＠catayasetenn）'), 'カードショップキャット 綾瀬店');
  assert.equal(placeLabel('GAME SHOP H@PPINESS'), 'GAME SHOP H@PPINESS');
  assert.equal(placeLabel('連絡先 someone@example.com'), null);
});

test('address fallback drops the prefecture, 日本 and the postcode', () => {
  const org = (over) => ({ ...byId(1168984), shop_term: 2, venue: '', ...over });
  assert.equal(normalizeEvent(org({ address: '福岡県〒813-0013  福岡市東区香椎駅前２丁目13-10', prefecture_name: '福岡県' }), SEEN).venue.name, '福岡市東区香椎駅前２丁目13-10');
  assert.equal(normalizeEvent(org({ address: '岡山県日本、〒700-0066 岡山市北区野殿西町３２９－１', prefecture_name: '岡山県' }), SEEN).venue.name, '岡山市北区野殿西町３２９－１');
});

test('a shop event away from the shop usual address is named after its own venue', async () => {
  const { shopHomes } = await import('../lib/normalize.mjs');
  const home = '高知県高知市帯屋町2丁目１−24 ３階';
  const away = '高知県高知市九反田2-1 高知市文化プラザ　かるぽーと';
  const shop = (id, address, venue = '') => shopRow({ event_holding_id: id, shop_id: 15212, shop_name: 'カードショップ楓', address, venue, prefecture_name: '高知県' });
  const rows = [shop(1, home), shop(2, '高知県高知市帯屋町2丁目1-24　3階'), shop(5, home), shop(3, away, '外部会場での開催になります。\n来場の際は場所を間違えないようにお願いします。'), shop(4, away, 'かるぽーと 9階 第3学習室')];
  const homes = shopHomes(rows);
  const names = rows.map((r) => normalizeEvent(r, SEEN, homes).venue.name);
  assert.deepEqual(names, ['カードショップ楓', 'カードショップ楓', 'カードショップ楓', '高知市九反田2-1 高知市文化プラザ　かるぽーと', 'かるぽーと 9階 第3学習室']);
  // A tie leaves the shop without a usual address: every row keeps the shop name.
  const tie = shopHomes([shop(1, home), shop(3, away)]);
  assert.equal(normalizeEvent(shop(3, away), SEEN, tie).venue.name, 'カードショップ楓');
  assert.equal(normalizeEvent(shop(3, away), SEEN).venue.name, 'カードショップ楓');
});

test('renameVenues leaves an occupied cache key alone and counts rows it cannot find', async () => {
  const { renameVenues } = await import('../lib/renormalize.mjs');
  const { venueKey } = await import('../../lib/venue-cache.mjs');
  const [[over]] = REPORTED;
  const row = shopRow(over);
  const geo = (lat) => ({ lat, lng: 135.5, source: 'ptcg', precision: null, place_id: null, geocoded_at: null });
  const e = normalizeEvent(row, SEEN);
  const newKey = venueKey(e.venue);
  e.venue.name = over.venue;
  e.venue.geo = geo(34.6);
  const oldKey = venueKey(e.venue);
  const cache = { entries: {
    [oldKey]: { name: over.venue, address: over.address, geo: geo(34.6), checked_at: '2026-11-19' },
    [newKey]: { name: 'シゲヤ', address: over.address, geo: geo(34.7), checked_at: '2026-11-19' },
  } };
  const lost = { ...normalizeEvent({ ...row, event_holding_id: 1 }, SEEN) };
  const r = renameVenues([e, lost], new Map([[String(row.event_holding_id), row]]), cache);
  assert.equal(r.missing, 1);
  assert.equal(r.changes.length, 1);
  assert.deepEqual(cache.entries[newKey].geo, geo(34.7));
  assert.deepEqual(e.venue.geo, geo(34.6));
});
