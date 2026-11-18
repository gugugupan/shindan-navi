// Pure mapping from one parsed /eventsearch row to contracts/event.schema.json.
import { createHash } from 'node:crypto';
import { searchUrl } from './parse.mjs';

// Series names as they appear before 【YYYY年M月】 in the eventtype option.
export const SERIES = {
  チャレンジ戦: { code: 'challenge', category: 'tournament' },
  ファンミーティング: { code: 'fan_meeting', category: 'casual' },
};

const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];
export const PREF_CODE = Object.fromEntries(PREFECTURES.map((n, i) => [n, `JP-${String(i + 1).padStart(2, '0')}`]));

const CONTACT = /[A-Za-z0-9._%+-]+[@＠][A-Za-z0-9-]+\.[A-Za-z]{2,}|(?<![A-Za-z])TEL(?![A-Za-z])|ＴＥＬ|電話|[0-9０-９]{2,5}[-－ー‐][0-9０-９]{2,4}[-－ー‐][0-9０-９]{3,4}|https?:/i;
export const containsContact = (s) => CONTACT.test(s);

const nfkc = (s) => s.normalize('NFKC');
const clean = (s) => (s === null || s === undefined || s.trim() === '' ? null : s.trim());
// Store-entered free text: dropped entirely when it carries contact details.
const safe = (s) => (s && containsContact(s) ? null : clean(s));

// The source has no event or store id. The fingerprint uses the source's own series key (the
// eventtype query value) plus the hosting store as listed (name + address) and the listed start.
// Any edit by the store to these fields yields a new id. Inputs are NFKC-normalised and whitespace
// is removed so cosmetic spacing changes do not split an event.
export function fingerprint(row) {
  const key = [row.series, row.shop_name, splitAddress(row.address).address ?? '', row.open_date]
    .map((s) => nfkc(s).replace(/\s+/g, ''))
    .join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

export function splitAddress(raw) {
  const s = clean(raw);
  if (!s) return { postal_code: null, address: null };
  const m = nfkc(s).match(/^〒?\s*(\d{3}-?\d{4})\s*(.*)$/);
  if (!m) return { postal_code: null, address: s };
  const zip = m[1].includes('-') ? m[1] : `${m[1].slice(0, 3)}-${m[1].slice(3)}`;
  return { postal_code: zip, address: clean(s.slice(s.length - m[2].length)) };
}

export function prefectureOf(address) {
  if (!address) return null;
  const a = nfkc(address).replace(/^\s+/, '');
  return PREFECTURES.find((p) => a.startsWith(p)) ?? null;
}

export function parseStart(text) {
  const m = nfkc(text).match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(?:(\d{1,2}):(\d{2}))?$/);
  if (!m) throw new Error(`unparsed open_date: ${text}`);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${m[1]}-${p(m[2])}-${p(m[3])}`;
  return { date, at: m[4] === undefined ? null : `${date}T${p(m[4])}:${m[5]}:00+09:00` };
}

export function parseCapacity(text) {
  const m = text && nfkc(text).match(/^定員(\d+)名$/);
  return m ? Number(m[1]) : null;
}

// 参加条件 carries the participation cost (purchase condition, table fee or 無料).
export function parseFee(text) {
  const t = clean(text);
  if (!t) return null;
  const s = nfkc(t).replace(/\s+/g, '');
  if (/^(参加費)?(無料|0円)$/.test(s)) return 0;
  const m = s.match(/^(?:参加費)?[¥￥]?([\d,]+)円?$/);
  if (m && (s.includes('円') || /[¥￥]/.test(s))) return Number(m[1].replace(/,/g, ''));
  return null;
}

// お知らせ "[外部会場]での開催となります" is followed by the venue name and address lines, or by
// the address alone (then the store stays the venue name, since the source names no other place).
export function externalVenue(notice, shopName) {
  if (!notice) return null;
  const lines = notice.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!/^\[外部会場\]/.test(lines[0] ?? '')) return null;
  const [name, addr] = lines.length === 2 ? [shopName, lines[1]] : [lines[1], lines[2]];
  const flag = lines.length === 2 ? 'address_only' : '1';
  if (!addr) return { flag: 'unparsed' };
  const { postal_code, address } = splitAddress(addr);
  if (!prefectureOf(address) || containsContact(name) || containsContact(address)) return { flag: 'unparsed' };
  return { flag, name, postal_code, address };
}

function venueFrom(name, postal, address) {
  const pref = prefectureOf(address);
  return {
    name,
    source_id: null,
    country_code: 'JP',
    region_code: pref ? PREF_CODE[pref] : null,
    region_name: pref,
    city: null,
    address,
    postal_code: postal,
  };
}

export function normalizeEvent(row, fetchedAt) {
  const seriesName = row.series.replace(/【[^】]*】\s*$/, '').trim();
  const series = SERIES[seriesName];
  const id = fingerprint(row);
  const start = parseStart(row.open_date);
  const shop = splitAddress(row.address);
  const ext = externalVenue(row.details['お知らせ'], row.shop_name);
  const venue = ext?.address
    ? venueFrom(ext.name, ext.postal_code, ext.address)
    : venueFrom(row.shop_name, shop.postal_code, shop.address);
  const feeText = safe(row.details['参加条件']);
  const fee = parseFee(feeText);
  const flags = [`series=${row.series}`];
  if (ext) flags.push(`external_venue=${ext.flag}`);
  return {
    id: `conan:${id}`,
    game_code: 'CONAN',
    source_code: 'conan_official',
    external_id: id,
    source_url: searchUrl({ eventtype: row.series, shop: row.shop_name, date_from: start.date, date_to: start.date }),
    group: {
      source_id: row.series,
      name: seriesName || row.series,
      category: series?.category ?? 'unknown',
      event_type_code: series?.code ?? null,
    },
    name: row.series,
    attendance_mode: 'in_person',
    venue,
    starts_on: start.date,
    ends_on: null,
    starts_at: start.at,
    ends_at: null,
    timezone: 'Asia/Tokyo',
    time_precision: start.at ? 'datetime' : 'date',
    format_text: safe(row.details['大会形式']),
    eligibility_text: null,
    capacity: parseCapacity(row.capacity),
    fee_amount: fee,
    fee_currency: fee === null ? null : 'JPY',
    fee_text: feeText,
    registration_method: 'unknown',
    registration_platform: null,
    registration_url: null,
    registration_opens_at: null,
    registration_closes_at: null,
    registration_status: 'unknown',
    event_status: 'scheduled',
    source_status_text: flags.join(';'),
    last_seen_at: fetchedAt,
  };
}

export function sortEvents(events) {
  return events.sort(
    (a, b) =>
      a.starts_on.localeCompare(b.starts_on) ||
      (a.starts_at ?? '￿').localeCompare(b.starts_at ?? '￿') ||
      a.id.localeCompare(b.id),
  );
}
