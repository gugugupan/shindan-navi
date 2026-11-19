// Pure mapping from one players.pokemon-card.com /event_search row to contracts/event.schema.json.

export const SOURCE_ORIGIN = 'https://players.pokemon-card.com';

// eventTypeLabels in the site bundle; 1 and 7 come from getCommonText (大型大会 / その他).
export const EVENT_TYPES = {
  1: { name: '大型大会', code: 'major_tournament', category: 'tournament' },
  2: { name: 'シティリーグ', code: 'city_league', category: 'tournament' },
  3: { name: 'トレーナーズリーグ', code: 'trainers_league', category: 'tournament' },
  4: { name: 'ジムイベント', code: 'gym_event', category: null },
  5: { name: 'キャンペーン', code: 'campaign', category: 'other' },
  6: { name: 'オーガナイザーイベント', code: 'organizer_event', category: null },
  7: { name: 'その他', code: 'other', category: null },
};

// eventAttributeLabels in the site bundle (search filter values are "<attr>:<event_type>").
export const EVENT_ATTRS = { 1: 'ルールを教わる', 2: '初心者歓迎', 3: '真剣勝負', 4: 'リモートポケカ' };

const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];
// leagueLabels in the site bundle; leagueName "その他" carries no age division.
const LEAGUES = new Set(['オープン', 'ジュニア', 'シニア', 'マスター']);

export const PREF_CODE = Object.fromEntries(PREFECTURES.map((n, i) => [n, `JP-${String(i + 1).padStart(2, '0')}`]));

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// The list's free-text `venue` often carries notes, opening hours, TEL or e-mail after the place name.
const CONTACT = /[A-Za-z0-9._%+-]+[@＠][A-Za-z0-9-]+\.[A-Za-z]{2,}|(?<![A-Za-z])TEL(?![A-Za-z])|ＴＥＬ|電話|[0-9０-９]{2,5}[-－ー‐][0-9０-９]{2,4}[-－ー‐][0-9０-９]{3,4}|https?:|営業時間|開店時間/i;
export function containsContact(s) {
  return CONTACT.test(s);
}

/** First line of the free-text `venue`, unless it carries contact details. Decides `source_id` only. */
export function venueLabel(raw) {
  const first = (text(raw) ?? '').split(/\r?\n/)[0].trim();
  return first === '' || CONTACT.test(first) ? null : first;
}

// `shop_term` 1 = the organizer is a shop (shop_name is its name), 2 = a person (shop_name is a nickname);
// 大型大会 rows have none. The free-text `venue` is whatever the organizer typed in 会場: a place name, but just as
// often the address, directions, seat counts, opening hours or house rules.
const SHOP = 1;
// Tested on NFKC-folded text without spaces (full-width digits are ASCII by then).
const DIRECTIONS = /徒歩|歩いて|降りて|下車|改札|出口|駅(?:から|より)|[口駅]から\d|バス|交通|direction/i;
const SENTENCE = /[。、]|ます|ません|ください|下さい|です|でした|お願い|ご注意|ご確認|ご利用|予定|受付|参加|駐車|定員|席数|\d+席|開店|閉店|毎日|毎週|毎月|詳細|未定|調整中|公開|注意|車で|お越し|お借り|ほど|など|対応|駐輪|場合|販売|あり|完備|無休|トイレ|お手洗い|\d:\d\d|\d+時|平日|土日|祝日|\d+年|\d+月\d+日|禁止|協力|アカウント|常備|aed|→|有$|での$|^[(（]|close/i;
const FLOOR_ONLY = /^.{0,24}の\d+[階f][!！]*$|^(?:地下)?\d+(?:階|f)/i;
// A prefecture followed by 立 (山梨県立…, 東京都立…) is a facility, not an address.
const ADDRESS = /^〒|^\d{3}-?\d{4}|^(?:北海道|東京都|京都府|大阪府|.{2,3}県)(?!立)|[市区町村郡].{0,15}?\d+(?:丁目|番地?|号|-\d)|[市区町村郡].{0,15}?字.{0,10}\d+$/;
const GENERIC = /^(?:店内|店舗内?|当店|自店|デュエルスペース|対戦スペース|対戦席|プレイスペース|フリースペース|イベントスペース|トレカコーナー|カードコーナー|会場|未定|tba)\d*席?$/i;
// A room without the facility it is in (研修室4, 本堂2F, レンタルの会議室, 施設内集会室).
const ROOM_ONLY = /^(?:施設内|館内|店内|レンタル(?:の)?|大|中|小|第[0-9一二三四五六七八九十]+)?(?:研修室|会議室|集会室|多目的室|講習室|学習室|講義室|和室|洋室|ホール|本堂|対戦スペース|スペース)(?:第?[0-9a-z一二三四五六七八九十]+)*(?:\d+(?:f|階))?$/i;
const PREFIX = /^(?:開催)?(?:会場|店舗|場所)名?\s*(?:[:：]\s*|\s+)/;
// "<place>様にて実施" / "<place>にて開催中" / "<place>開催" / "<place>にて受け付け" → "<place>"
const TRAILER = /\s*(?:様)?(?:の(?:店内|店舗|デュエルスペース|対戦スペース)(?:内)?)?(?:にて|で)?(?:行います|行っています|開催(?:中|します|いたします|致します|予定)?|実施(?:中|します|いたします|致します)?|受け付け|受付)[。！!]*$/;
const HANDLE = /\s*[(（【]\s*[@＠][^)）】]*[)）】]|(?:^|\s+)[@＠][A-Za-z0-9_.]+/g;
const fold = (s) => s.normalize('NFKC').replace(/\s+/g, '');

const cleanLine = (line) => {
  let s = line.trim().replace(/^[■□◆◇●○・◾️※*＊-]+\s*/u, '').replace(PREFIX, '');
  for (let i = 0; i < 2; i += 1) s = s.replace(TRAILER, '').replace(/\s*様$/, '').replace(/[\s!！／/]+$/, '');
  return s.replace(HANDLE, '').trim();
};

/**
 * A place name from the organizer's free-text `venue`: the first line that is neither contact details, an address,
 * directions, a note nor a bare room. null when no line qualifies.
 */
export function placeLabel(raw, address = null) {
  const addr = fold(address ?? '');
  for (const line of (text(raw) ?? '').split(/\r?\n/)) {
    if (CONTACT.test(line)) continue;
    const s = cleanLine(line);
    if (s === '') continue;
    const f = fold(s);
    if (f.length > 40 || DIRECTIONS.test(f) || SENTENCE.test(f) || FLOOR_ONLY.test(f) || GENERIC.test(f) || ROOM_ONLY.test(f) || ADDRESS.test(f)) continue;
    if (f === addr) continue;
    return s;
  }
  return null;
}

// Shown when an organizer gave neither a usable place name nor an address (the detail page is the reference).
export const VENUE_UNKNOWN = '会場は公式で確認';

const foldAddress = (s) => fold(s).replace(/[‐‑‒–—―−－ー]/g, '-');

/**
 * shop_id → its usual address (the most frequent one among the run's rows, ties unresolved), so a shop's event at
 * another address can be told apart.
 */
export function shopHomes(rows) {
  const counts = new Map();
  for (const r of rows) {
    const address = text(r.address);
    if (r.shop_term !== SHOP || !address || r.shop_id === null || r.shop_id === undefined) continue;
    const byAddr = counts.get(r.shop_id) ?? counts.set(r.shop_id, new Map()).get(r.shop_id);
    const k = foldAddress(address);
    byAddr.set(k, (byAddr.get(k) ?? 0) + 1);
  }
  const homes = new Map();
  for (const [shop, byAddr] of counts) {
    const [[top, n], second] = [...byAddr].sort((a, b) => b[1] - a[1]);
    if (!second || second[1] < n) homes.set(shop, top);
  }
  return homes;
}

/**
 * venue.name: the shop for shop-organized events at the shop's usual address (their free text is notes about the
 * shop), else the place the free text names, else the address without its prefecture and postcode (the page shows the
 * prefecture next to the name), else VENUE_UNKNOWN.
 */
export function venueName(row, homes = new Map()) {
  const shop = text(row.shop_name);
  const address = text(row.address);
  const home = homes.get(row.shop_id);
  const elsewhere = home !== undefined && address !== null && foldAddress(address) !== home;
  if (row.shop_term === SHOP && shop && !elsewhere) return shop;
  const label = placeLabel(row.venue, address);
  if (label) return label;
  if (address) {
    const pref = text(row.prefecture_name);
    const rest = (pref && address.startsWith(pref) ? address.slice(pref.length) : address)
      .trim().replace(/^日本[、,]?\s*/, '').replace(/^〒?\s*[0-9０-９]{3}[-－ー‐]?[0-9０-９]{4}\s*/, '').trim();
    if (rest !== '' && !CONTACT.test(rest)) return rest;
  }
  if (row.shop_term === SHOP && shop) return shop;
  return VENUE_UNKNOWN;
}

export function eventKey(row) {
  return String(row.event_holding_id);
}

export function detailUrl(row) {
  const seg = (v) => (v === null || v === undefined || v === '' ? 0 : v);
  return `${SOURCE_ORIGIN}/event/detail/${row.event_holding_id}/${seg(row.trainers_flg)}/${seg(row.shop_id)}/${seg(row.event_date_params)}/${seg(row.date_id)}`;
}

// Single unconditional amounts only; conditional, ranged, multi-amount or purchase-based fees stay null.
const FEE_FREE = /^(?:参加費:?)?(?:無料|0円)$/;
const FEE_AMOUNT = /^(?:(?:現金|参加費|一人):?)?(?:(\d{1,3}(?:,\d{3})+|\d+)円|¥(\d{1,3}(?:,\d{3})+|\d+))(?:\(税込\))?(?:\((?:現金のみ|現金決済のみ)\)|\/現金のみ)?!*$/;

export function parseFee(raw) {
  const t = text(raw);
  if (t === null) return { fee_amount: null, fee_currency: null, fee_text: null };
  const s = t.normalize('NFKC').replace(/\s+/g, '');
  if (FEE_FREE.test(s)) return { fee_amount: 0, fee_currency: 'JPY', fee_text: t };
  const m = s.match(FEE_AMOUNT);
  if (m) return { fee_amount: Number((m[1] ?? m[2]).replace(/,/g, '')), fee_currency: 'JPY', fee_text: t };
  return { fee_amount: null, fee_currency: null, fee_text: t };
}

function isoDate(yyyymmdd) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(yyyymmdd ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function hhmm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text(v) ?? '');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function postal(zip) {
  const digits = String(zip ?? '').replace(/\D/g, '');
  if (digits.length === 0 || /^0+$/.test(digits) || digits.length > 7) return null;
  const d = digits.padStart(7, '0');
  return `${d.slice(0, 3)}-${d.slice(3)}`;
}

function category(type, attr) {
  if (type?.category) return type.category;
  if (attr === 3) return 'tournament';
  if (attr === 1) return 'teaching';
  return 'unknown';
}

/** `homes` = shopHomes(all rows of the run); without it every shop event is named after the shop. */
export function normalizeEvent(row, seenAt, homes = new Map()) {
  const startsOn = isoDate(row.event_date_params);
  if (!startsOn) throw new Error(`event ${row.event_holding_id}: bad event_date_params ${row.event_date_params}`);
  const start = hhmm(row.event_started_at);
  const end = hhmm(row.event_ended_at);
  const type = EVENT_TYPES[row.event_type] ?? null;
  const attr = Number(row.event_attr_id);
  const prefName = text(row.prefecture_name);
  const regulation = text(row.regulation);
  const deck = text(row.deck_count);
  const ownVenue = venueLabel(row.venue);
  const league = text(row.leagueName);
  const external = eventKey(row);

  return {
    id: `ptcg:${external}`,
    game_code: 'PTCG',
    source_code: 'pokemon_players',
    external_id: external,
    source_url: detailUrl(row),
    group: {
      source_id: row.event_type === null || row.event_type === undefined ? null : String(row.event_type),
      name: type?.name ?? `event_type ${row.event_type}`,
      category: type ? category(type, attr) : 'unknown',
      event_type_code: type?.code ?? null,
    },
    name: text(row.event_title) ?? type?.name ?? 'イベント',
    attendance_mode: attr === 4 ? 'unknown' : 'in_person',
    venue: ownVenue === null && text(row.shop_name) === null ? null : {
      name: venueName(row, homes),
      source_id: ownVenue ? null : text(row.shop_id),
      country_code: 'JP',
      region_code: PREF_CODE[prefName] ?? null,
      region_name: prefName,
      city: null,
      address: text(row.address),
      postal_code: postal(row.zip_code),
    },
    starts_on: startsOn,
    ends_on: null,
    starts_at: start ? `${startsOn}T${start}:00+09:00` : null,
    ends_at: start && end && end > start ? `${startsOn}T${end}:00+09:00` : null,
    timezone: 'Asia/Tokyo',
    time_precision: start ? 'datetime' : 'date',
    format_text: regulation && deck ? `${regulation}（${deck}）` : regulation ?? deck,
    eligibility_text: LEAGUES.has(league) ? `${league}リーグ` : null,
    capacity: Number.isInteger(row.capacity) && row.capacity > 0 ? row.capacity : null,
    ...parseFee(row.entry_fee),
    registration_method: 'unknown',
    registration_platform: null,
    registration_url: null,
    registration_opens_at: null,
    registration_closes_at: null,
    registration_status: 'unknown',
    event_status: row.discontinuance_flg === 1 ? 'cancelled' : row.discontinuance_flg === 0 ? 'scheduled' : 'unknown',
    source_status_text: [
      `event_type=${row.event_type}`, `event_attr_id=${row.event_attr_id}`,
      `discontinuance_flg=${row.discontinuance_flg}`, `cancelFlg=${row.cancelFlg}`,
      `fullOccupiedFlg=${row.fullOccupiedFlg}`, `entryRestartFlg=${row.entryRestartFlg}`,
      `recruitFlg=${row.recruitFlg}`, `trainers_flg=${row.trainers_flg}`,
    ].join(';'),
    last_seen_at: seenAt,
  };
}

export function sortEvents(events) {
  return [...events].sort((a, b) =>
    a.starts_on.localeCompare(b.starts_on)
    || (a.starts_at === null) - (b.starts_at === null)
    || (a.starts_at ?? '').localeCompare(b.starts_at ?? '')
    || a.id.localeCompare(b.id));
}
