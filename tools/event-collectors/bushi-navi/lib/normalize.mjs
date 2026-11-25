// Pure mapping from one flattened Bushi Navi list row (lib/collect.mjs flattenGroups) to contracts/event.schema.json.

export const SITE_ORIGIN = 'https://www.bushi-navi.com';

// game_title_id → game_code. Ids from /api/masterdata `game_title` (2026-11-19). Also listed there but not collected:
// 7 ヴァイスシュヴァルツブラウ, 12 ヴァイスシュヴァルツロゼ, 5 Reバース for you, 13 ゴジラ カードゲーム,
// 14 パルワールド オフィシャルカードゲーム, 8 プロ野球カードゲーム ドリームオーダー, 9 五等分の花嫁 カードゲーム, 99 ブシロード.
export const GAMES = {
  WS: { id: 2, name: 'ヴァイスシュヴァルツ' },
  VG: { id: 1, name: 'カードファイト!! ヴァンガード' },
  SVE: { id: 6, name: 'Shadowverse EVOLVE' },
  HOCG: { id: 10, name: 'hololive OFFICIAL CARD GAME' },
  LLOCG: { id: 11, name: 'ラブライブ！シリーズ オフィシャルカードゲーム' },
};

// masterdata series_type: 公認イベント / 公式イベント / CS大会.
export const SERIES_TYPES = {
  1: { code: 'shop_event', label: '公認イベント' },
  2: { code: 'official_event', label: '公式イベント' },
  3: { code: 'cs', label: 'CS大会' },
};

// masterdata requirement_type (参加条件). Only 1 (free) and 3 / 6 (a plain fee) give a fee_amount.
export const REQUIREMENTS = {
  1: '参加費無料', 2: '1パック購入', 3: '参加費', 4: '1パック購入 または 参加費', 5: '1パック購入 または お買い物金額',
  6: '参加費（参加賞1パック付）', 7: '参加費（会員価格設定）', 8: 'お買い物金額', 9: '入場には別途チケットが必要です',
};

const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
};

const CONTACT = /[A-Za-z0-9._%+-]+[@＠][A-Za-z0-9-]+\.[A-Za-z]{2,}|(?<![A-Za-z])TEL(?![A-Za-z])|ＴＥＬ|電話|[0-9０-９]{2,5}[-－ー‐][0-9０-９]{2,4}[-－ー‐][0-9０-９]{3,4}|(?<![0-9])0[0-9]{9,10}(?![0-9])|https?:/i;
// Addresses legitimately read like 12-34-567 (丁目-番-号 + room), so only dashed numbers starting with 0 (phone
// numbers; 丁目 / 番地 never start with 0) count there.
const ADDRESS_CONTACT = /[A-Za-z0-9._%+-]+[@＠][A-Za-z0-9-]+\.[A-Za-z]{2,}|(?<![A-Za-z])TEL(?![A-Za-z])|ＴＥＬ|電話|(?<![0-9])0[0-9]{9,10}(?![0-9])|(?<![0-9０-９\-－ー‐−])[0０][0-9０-９]{1,4}[-－ー‐−][0-9０-９]{1,4}[-－ー‐−][0-9０-９]{3,4}(?![0-9０-９\-－ー‐−])|https?:/i;
export function containsContact(s, { address = false } = {}) {
  return (address ? ADDRESS_CONTACT : CONTACT).test(s);
}

export function region(prefCode) {
  const n = Number(prefCode);
  if (!Number.isInteger(n) || n < 1 || n > 47) return { region_code: null, region_name: null };
  return { region_code: `JP-${String(n).padStart(2, '0')}`, region_name: PREFECTURES[n - 1] };
}

/** place_geo is {x: latitude, y: longitude} (same shape as TCG+). Rounded to 6 decimals; outside Japan → null. */
export function geoFrom(placeGeo) {
  if (!placeGeo || typeof placeGeo !== 'object') return null;
  const lat = Number(placeGeo.x);
  const lng = Number(placeGeo.y);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 20 || lat > 46 || lng < 122 || lng > 154) return null;
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  return { lat: r6(lat), lng: r6(lng), source: 'bushinavi', precision: null, place_id: null, geocoded_at: null };
}

/** ISO instant → `YYYY-MM-DDTHH:MM:SS+09:00`. */
export function toJst(iso) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  return `${new Date(t + 9 * 3600_000).toISOString().slice(0, 19)}+09:00`;
}

export function parseFee(requirementType, entryFee) {
  const label = REQUIREMENTS[requirementType] ?? null;
  const amount = Number(entryFee);
  const yen = Number.isFinite(amount) && amount >= 0 && Number.isInteger(amount) ? amount : null;
  if (requirementType === 1) return { fee_amount: 0, fee_currency: 'JPY', fee_text: label };
  if ((requirementType === 3 || requirementType === 6) && yen !== null && yen > 0) {
    return { fee_amount: yen, fee_currency: 'JPY', fee_text: `${label} ${yen.toLocaleString('ja-JP')}円` };
  }
  const withAmount = [4, 7].includes(requirementType) && yen ? `${label} ${yen.toLocaleString('ja-JP')}円` : label;
  return { fee_amount: null, fee_currency: null, fee_text: withAmount };
}

// masterdata entry_method: 1 先着予約, 2 手動抽選, 3 自動抽選. is_no_advance_application = 事前申込なし (当日受付).
function registrationMethod(row) {
  if (row.is_no_advance_application === true) return 'walk_in';
  return { 1: 'first_come', 2: 'lottery', 3: 'lottery' }[row.entry_method] ?? 'unknown';
}

// masterdata event_status: 11 accepting, 21 accepted, 31 winner fixed, 51 running, 61 finished. The site still takes
// first-come applications in 21/31 and the list has no applicant count, so open/waitlist are never claimed.
function registrationStatus(row) {
  if (row.is_canceled === true || row.is_no_advance_application === true) return 'unknown';
  const s = row.status_id;
  if (s === 51 || s === 61) return 'closed';
  if ((s === 21 || s === 31) && (row.entry_method === 2 || row.entry_method === 3)) return 'closed';
  return 'unknown';
}

function eventStatus(row) {
  if (row.is_canceled === true) return 'cancelled';
  if (row.status_id === 61) return 'completed';
  if ([11, 21, 31, 51].includes(row.status_id)) return 'scheduled';
  return 'unknown';
}

// Series names carry the game tag and year: "[WS] 12月度ショップ大会(2026)". Ordered: the first match wins.
const SERIES_RULES = [
  [/サイン会/, 'other', 'signing'],
  [/体験会|ティーチング|講習|教室|はじめて|初めて|ビギナー|初心者/, 'teaching', 'teaching'],
  [/交流会|フリー対戦|フリープレイ|対戦会/, 'casual', 'meetup'],
  [/発売記念|パーティー/, 'other', 'release_event'],
  [/フェス|フェスタ|Fest/i, 'festival', null],
  [/WGP|グランプリ|ちほうかっぷ/i, 'tournament', 'grand_prix'],
  [/Championship|チャンピオンシップ/i, 'tournament', 'championship'],
  [/CXチャレンジ/, 'tournament', 'cx_challenge'],
  [/ブルームカップ/, 'tournament', 'bloom_cup'],
  [/限定構築/, 'tournament', 'limited_format'],
  [/公認店サポート/, 'tournament', 'shop_support'],
  [/ショップ大会|ショップファイト/, 'tournament', 'shop_tournament'],
];

/** category and event_type_code from the series title, else the series_type (公認 / 公式 / CS). */
export function classify(seriesTitle, seriesType) {
  const t = seriesTitle ?? '';
  for (const [re, cat, code] of SERIES_RULES) if (re.test(t)) return { category: cat, event_type_code: code };
  return { category: 'tournament', event_type_code: SERIES_TYPES[seriesType]?.code ?? null };
}

// Farther than this from the organizer's own place_geo, the event is held elsewhere (rented hall, another shop).
export const OFFSITE_METERS = 300;
function meters(a, b) {
  const lat = (Number(a.x) + Number(b.x)) / 2;
  const dy = (Number(a.x) - Number(b.x)) * 111_320;
  const dx = (Number(a.y) - Number(b.y)) * 111_320 * Math.cos((lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}
export function isOffsite(row) {
  const a = row.place_geo;
  const b = row.group.place_geo;
  if (!a || !b) return false;
  const d = meters(a, b);
  return Number.isFinite(d) && d >= OFFSITE_METERS;
}

const POSTCODE = /^〒?\s*(\d{3})[-－ー−‐]?(\d{4})\s*/;
/** `place` split into postal code and the rest; the rest without its prefecture is the name of an off-site venue. */
export function splitPlace(place, prefName) {
  const raw = text(place);
  if (raw === null) return { address: null, postal_code: null, label: null };
  const folded = raw.normalize('NFKC');
  const m = POSTCODE.exec(folded);
  const address = m ? text(raw.normalize('NFKC').slice(m[0].length)) : raw;
  const label = prefName && address?.startsWith(prefName) ? text(address.slice(prefName.length)) : address;
  return { address, postal_code: m ? `${m[1]}-${m[2]}` : null, label };
}

// The street number ends the address part: 3-11-1, 3番40号, 1丁目20−10, 193番地, 南1条西4丁目2, 3丁目 11-1,
// 9番地の1. What follows is the building.
const STREET_NUMBER = /^.*?\d+(?:(?:丁目\s?|番地|番|号|条|[-−‐‑ー]|の)+[東西南北]?\d+)*(?:丁目|番地|番|号|条)?\s*/;
const FLOORS = /B?\d+(?:[,，~〜-]\d+)*\s*(?:F|階)?/gi;
/** The building / hall part of an address (「東京ビッグサイト 南4ホール」), or null when there is none or only a floor. */
export function buildingOf(address) {
  const s = text(address?.normalize('NFKC'));
  if (s === null) return null;
  const m = STREET_NUMBER.exec(s);
  if (!m) return null;
  const rest = text(s.slice(m[0].length));
  if (rest === null || text(rest.replace(FLOORS, '')) === null) return null;
  return rest;
}

export function sourceUrl(row) {
  return `${SITE_ORIGIN}/series/${row.group.event_series_id}/organizer/${row.group.organizer_id}`;
}

export function normalizeEvent(row, gameCode, seenAt) {
  const g = row.group;
  const startsAt = toJst(row.start_datetime);
  if (!startsAt) throw new Error(`event ${row.id}: bad start_datetime ${row.start_datetime}`);
  const startsOn = startsAt.slice(0, 10);
  const timeHidden = g.is_event_info_hidden === true || g.is_start_datetime_hidden === true;
  const capHidden = g.is_event_info_hidden === true || g.is_max_join_count_hidden === true;
  const teams = Number(g.team_count) > 1;
  const series = SERIES_TYPES[g.series_type] ?? null;
  const seriesTitle = text(g.event_series_title);
  const format = text(row.game_format_name);
  const organizer = text(g.organizer_name);
  const reg = region(row.pref_code);
  const place = splitPlace(row.place, reg.region_name);
  const official = g.organizer_type === 2;
  // Official organizers ("ヴァンガード公式") are named by the building only (owner decision 2026-11-19), else by the
  // organizer; shops holding an event elsewhere by the building, else by the address.
  const building = buildingOf(place.label);
  const placeName = official ? building : isOffsite(row) ? building ?? place.label : null;
  const byPlace = placeName !== null;
  const advance = row.is_no_advance_application !== true;
  const url = sourceUrl(row);
  const cap = Number(row.max_join_count);
  const external = String(row.id);

  return {
    id: `bnavi:${external}`,
    game_code: gameCode,
    source_code: 'bushinavi',
    external_id: external,
    source_url: url,
    group: {
      source_id: g.event_series_id == null ? null : String(g.event_series_id),
      name: seriesTitle ?? series?.label ?? 'イベント',
      ...classify(seriesTitle, g.series_type),
    },
    name: seriesTitle ?? series?.label ?? 'イベント',
    attendance_mode: 'in_person',
    venue: organizer === null && place.label === null ? null : {
      name: byPlace ? placeName : organizer ?? place.label,
      source_id: byPlace || official || g.organizer_id == null ? null : String(g.organizer_id),
      country_code: 'JP',
      ...reg,
      city: null,
      address: place.address,
      postal_code: place.postal_code,
      geo: geoFrom(row.place_geo),
    },
    starts_on: startsOn,
    ends_on: null,
    starts_at: timeHidden ? null : startsAt,
    ends_at: null,
    timezone: 'Asia/Tokyo',
    time_precision: timeHidden ? 'date' : 'datetime',
    format_text: format,
    eligibility_text: teams ? `${g.team_count}人チーム戦${!capHidden && Number.isInteger(cap) && cap > 0 ? `（定員${cap}チーム）` : ''}` : null,
    capacity: !teams && !capHidden && Number.isInteger(cap) && cap > 0 ? cap : null,
    ...parseFee(row.requirement_type, row.entry_fee),
    registration_method: registrationMethod(row),
    registration_platform: advance ? 'bushinavi' : null,
    registration_url: advance ? url : null,
    registration_opens_at: null,
    registration_closes_at: null,
    registration_status: registrationStatus(row),
    event_status: eventStatus(row),
    source_status_text: [
      `status_id=${row.status_id}`, `canceled=${row.is_canceled ? 1 : 0}`, `series_type=${g.series_type}`,
      `organizer_type=${g.organizer_type}`, `entry_method=${row.entry_method}`,
      `no_advance=${row.is_no_advance_application ? 1 : 0}`, `requirement_type=${row.requirement_type}`,
      `team_count=${g.team_count}`, `hidden=${[g.is_event_info_hidden && 'info', g.is_start_datetime_hidden && 'time', g.is_max_join_count_hidden && 'cap'].filter(Boolean).join(',')}`,
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
