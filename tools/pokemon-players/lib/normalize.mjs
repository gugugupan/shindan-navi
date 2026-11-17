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

export function venueLabel(raw) {
  const first = (text(raw) ?? '').split(/\r?\n/)[0].trim();
  return first === '' || CONTACT.test(first) ? null : first;
}

export function eventKey(row) {
  return String(row.event_holding_id);
}

export function detailUrl(row) {
  const seg = (v) => (v === null || v === undefined || v === '' ? 0 : v);
  return `${SOURCE_ORIGIN}/event/detail/${row.event_holding_id}/${seg(row.trainers_flg)}/${seg(row.shop_id)}/${seg(row.event_date_params)}/${seg(row.date_id)}`;
}

export function parseFee(raw) {
  const t = text(raw);
  if (t === null) return { fee_amount: null, fee_currency: null, fee_text: null };
  if (/^(無料|0円|０円)$/.test(t)) return { fee_amount: 0, fee_currency: 'JPY', fee_text: t };
  const m = t.replace(/,/g, '').match(/^(?:([0-9]+)円|[¥￥]([0-9]+))$/);
  if (m) return { fee_amount: Number(m[1] ?? m[2]), fee_currency: 'JPY', fee_text: t };
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

export function normalizeEvent(row, seenAt) {
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
  const venueName = ownVenue ?? text(row.shop_name);
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
    venue: venueName === null ? null : {
      name: venueName,
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
