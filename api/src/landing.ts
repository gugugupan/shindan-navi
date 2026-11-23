// Event landing pages /events/<slug>/<pref>/ and /events/sitemap.xml (docs/design/event-landing.md). Rendered from one
// landing_pages row (written by the events importer, migration 0007) into the shell dist/_landing.html.
import { GAMES, PREFECTURES, TYPE_LABELS } from './constants';
import { esc, name as displayName, renderer, safeUrl, venueLabel, type Ev, type Group, type RowGame } from './evrow';

export const SITE = 'https://shindan-navi.app';
export const TEMPLATE_PATH = '/_landing';
// Pages turn noindex once their game's data is older than this (days, Asia/Tokyo dates).
export const STALE_DAYS = 14;
const MAX_LD_EVENTS = 100;

// Display name (= GAME_ICON key and the /events/ chip name), common short name, palette (CLAUDE.md › Event game
// palette), icon (GAME_ICON in build.py) and whether build.py has a 新弾 page at /<slug>/. tests/evrow.test.ts checks
// these against src/events.html and scripts/build.py.
export const LANDING_GAMES: Record<string, { label: string; short: string; c: string; cd: string; icon: string; releases: boolean }> = {
  OPCG: { label: 'ONE PIECE', short: 'ワンピカード', c: '#be362d', cd: '#de837c', icon: 'opcg.png', releases: true },
  UATCG: { label: 'UNION ARENA', short: 'ユニアリ', c: '#7a2dbe', cd: '#b17cde', icon: 'ua.png', releases: true },
  CONAN: { label: '名探偵コナン', short: 'コナンカード', c: '#2d81be', cd: '#7cb6de', icon: 'conan.svg', releases: false },
  PTCG: { label: 'ポケモンカード', short: 'ポケカ', c: '#be972d', cd: '#dec47c', icon: 'ptcg.svg', releases: true },
  GCG: { label: 'ガンダム', short: 'ガンダムカード', c: '#1d357c', cd: '#3b60ce', icon: 'ガ', releases: true },
  DBFW: { label: 'DBフュージョンワールド', short: 'フュージョンワールド', c: '#8a2e0f', cd: '#e45525', icon: 'dbfw.png', releases: true },
  BS: { label: 'バトルスピリッツ', short: 'バトスピ', c: '#7c1d4d', cd: '#ce3b85', icon: 'バ', releases: false },
  DCG: { label: 'デジモン', short: 'デジカ', c: '#12a581', cd: '#40e7be', icon: 'dcg.png', releases: true },
  WS: { label: 'ヴァイスシュヴァルツ', short: 'ヴァイス', c: '#d31785', cd: '#ed6eb8', icon: 'ws.png', releases: true },
  VG: { label: 'ヴァンガード', short: 'ヴァンガード', c: '#808a0f', cd: '#d4e425', icon: 'vg.png', releases: false },
  SVE: { label: 'Shadowverse EVOLVE', short: 'シャドバエボルヴ', c: '#4d6f2a', cd: '#85b950', icon: 'シ', releases: false },
  HOCG: { label: 'ホロライブ', short: 'ホロカ', c: '#a96660', cd: '#cfadaa', icon: 'hocg.png', releases: false },
  LLOCG: { label: 'ラブライブ！OCG', short: 'ラブカ', c: '#366063', cd: '#62a1a7', icon: 'llocg.png', releases: false },
};

// URL segment per location, JIS order (JP-01..JP-47), then online.
export const PREF_SLUGS = [
  'hokkaido', 'aomori', 'iwate', 'miyagi', 'akita', 'yamagata', 'fukushima', 'ibaraki', 'tochigi', 'gunma', 'saitama', 'chiba',
  'tokyo', 'kanagawa', 'niigata', 'toyama', 'ishikawa', 'fukui', 'yamanashi', 'nagano', 'gifu', 'shizuoka', 'aichi', 'mie',
  'shiga', 'kyoto', 'osaka', 'hyogo', 'nara', 'wakayama', 'tottori', 'shimane', 'okayama', 'hiroshima', 'yamaguchi',
  'tokushima', 'kagawa', 'ehime', 'kochi', 'fukuoka', 'saga', 'nagasaki', 'kumamoto', 'oita', 'miyazaki', 'kagoshima', 'okinawa',
];
export const LOCS: ReadonlyArray<{ loc: string; slug: string; name: string }> = [
  ...PREFECTURES.map(([loc, nm], i) => ({ loc, slug: PREF_SLUGS[i], name: nm })),
  { loc: 'online', slug: 'online', name: 'オンライン' },
];
const LOC_BY_SLUG = new Map(LOCS.map((l) => [l.slug, l]));
const GAME_BY_SLUG = new Map(GAMES.map((g) => [g.slug as string, g]));

export type LandingRoute =
  | { kind: 'page'; code: string; loc: string; path: string }
  | { kind: 'redirect'; to: string }
  | { kind: 'sitemap' };

export const landingPath = (code: string, loc: string) =>
  `/events/${GAMES.find((g) => g.code === code)!.slug}/${LOCS.find((l) => l.loc === loc)!.slug}/`;

/** The landing route of a path, or null (anything else falls through to the assets). */
export function landingRoute(pathname: string): LandingRoute | null {
  if (pathname === '/events/sitemap.xml') return { kind: 'sitemap' };
  const m = /^\/events\/([a-z0-9-]+)\/([a-z]+)(\/?)$/.exec(pathname);
  if (!m) return null;
  const g = GAME_BY_SLUG.get(m[1]);
  const l = LOC_BY_SLUG.get(m[2]);
  if (!g || !l) return null;
  const path = `/events/${m[1]}/${m[2]}/`;
  return m[3] ? { kind: 'page', code: g.code, loc: l.loc, path } : { kind: 'redirect', to: path };
}

export interface LandingRow {
  fetched_at: string;
  built_on: string;
  days_json: string;
  events_json: string;
}

const missingTable = (e: unknown) => e instanceof Error && /no such table/.test(e.message);

/** The row of one page; null without one (also while migration 0007 is not applied). */
export async function readLandingRow(db: D1Database, code: string, loc: string): Promise<LandingRow | null> {
  try {
    return await db.prepare('SELECT fetched_at, built_on, days_json, events_json FROM landing_pages WHERE game_code = ? AND loc = ?')
      .bind(code, loc).first<LandingRow>();
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

export const jstToday = (nowMs = Date.now()) => new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
const jstDate = (iso: string) => jstToday(Date.parse(iso));
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const md = (s: string) => `${+s.slice(5, 7)}/${+s.slice(8, 10)}(${DOW[new Date(`${s}T00:00:00Z`).getUTCDay()]})`;
const jpDate = (s: string) => `${+s.slice(0, 4)}年${+s.slice(5, 7)}月${+s.slice(8, 10)}日`;

/** Days from today on with their totals, and whether the page may be indexed (docs/design/event-landing.md › SEO). */
export function landingStatus(row: LandingRow | null, today: string) {
  const days: [string, number][] = row ? Object.entries(JSON.parse(row.days_json) as Record<string, number>).filter(([d]) => d >= today).sort() : [];
  const total = days.reduce((n, [, c]) => n + c, 0);
  const fresh = !!row && dayDiff(jstDate(row.fetched_at), today) <= STALE_DAYS;
  return { days, total, fresh, indexable: !!row && total > 0 && fresh };
}

const gi = (n: string) => {
  const g = Object.values(LANDING_GAMES).find((x) => x.label === n);
  const v = g ? g.icon : [...String(n || '?')][0].toUpperCase();
  return /\.(png|svg)$/.test(v) ? `<img class="gi" src="/gi/${esc(v)}" width="16" height="16" alt="" aria-hidden="true">` : `<span class="gi" aria-hidden="true">${esc(v)}</span>`;
};
const ROW_GAMES: Record<string, RowGame> = Object.fromEntries(Object.entries(LANDING_GAMES).map(([k, g]) => [k, { name: g.label, c: g.c, cd: g.cd }]));
const jsonLd = (x: unknown) => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, '\\u003c')}</script>`;
const eventsUrl = (q: Record<string, string>) => `/events/?${new URLSearchParams(q).toString().replace(/%2C/g, ',')}`;

const ATTENDANCE: Record<string, string> = { online: 'OnlineEventAttendanceMode', hybrid: 'MixedEventAttendanceMode' };
const STATUS: Record<string, string> = { cancelled: 'EventCancelled', postponed: 'EventPostponed' };

/** schema.org Event for one stored event; null when an in-person event has no venue (Event needs a location). */
export function eventLd(e: Ev, pageUrl: string): Record<string, unknown> | null {
  const url = safeUrl(e.source_url);
  const v = e.venue;
  const place = v ? {
    '@type': 'Place',
    name: venueLabel(v),
    address: Object.fromEntries(Object.entries({ '@type': 'PostalAddress', addressCountry: 'JP', addressRegion: v.region_name, addressLocality: v.city, streetAddress: v.address })
      .filter(([, x]) => x)),
  } : null;
  const virtual = { '@type': 'VirtualLocation', url: url || pageUrl };
  const mode = e.attendance_mode as string;
  const location = mode === 'online' ? virtual : mode === 'hybrid' ? (place ? [place, virtual] : virtual) : place;
  if (!location) return null;
  const timed = e.time_precision === 'datetime' && e.starts_at;
  const end = timed && e.ends_at ? e.ends_at : e.ends_on && e.ends_on !== e.starts_on ? e.ends_on : null;
  return {
    '@type': 'Event',
    name: displayName(e),
    startDate: timed ? e.starts_at : e.starts_on,
    ...(end ? { endDate: end } : {}),
    eventStatus: `https://schema.org/${STATUS[e.event_status] ?? 'EventScheduled'}`,
    eventAttendanceMode: `https://schema.org/${ATTENDANCE[mode] ?? 'OfflineEventAttendanceMode'}`,
    location,
    ...(url ? { url } : {}),
  };
}

/** A stored event as the row renderer expects it (importer.mjs landingEvent leaves out what the row implies). */
export function hydrate(e: Ev, code: string, loc: string): Ev {
  const out: Ev = { ...e, game_code: code };
  if (e.group && e.group.name === undefined) out.group = { ...e.group, name: e.name };
  if (e.venue && e.venue.region_code === undefined && loc !== 'online') {
    out.venue = { ...e.venue, region_code: loc, region_name: PREFECTURES.find(([c]) => c === loc)![1] };
  }
  return out;
}

export interface RenderedPage {
  status: number;
  indexable: boolean;
  html: string;
}

/** Fills the shell's LP_HEAD and LP_MAIN regions for one page. row null = no data (404, noindex). */
export function renderLanding(template: string, code: string, loc: string, row: LandingRow | null, today: string): RenderedPage {
  const game = LANDING_GAMES[code];
  const g = GAMES.find((x) => x.code === code)!;
  const place = LOCS.find((l) => l.loc === loc)!;
  const path = landingPath(code, loc);
  const url = SITE + path;
  const st = landingStatus(row, today);
  const where = loc === 'online' ? 'オンライン' : place.name;
  const h1 = loc === 'online' ? `${game.short} オンライン大会・イベント一覧` : `${place.name}の${game.short} 大会・イベント一覧`;
  const title = loc === 'online' ? `${game.short}のオンライン大会・イベント｜トレカカレンダー` : `${game.short}の大会・イベント（${place.name}）｜トレカカレンダー`;

  const stored: Ev[] = row ? (JSON.parse(row.events_json) as Ev[]).filter((e) => e.starts_on >= today).map((e) => hydrate(e, code, loc)) : [];
  const byDay = new Map<string, Ev[]>();
  for (const e of stored) byDay.set(e.starts_on, [...(byDay.get(e.starts_on) ?? []), e]);
  const shownDays = st.days.filter(([d]) => byDay.has(d));
  const lastShown = shownDays.length ? shownDays[shownDays.length - 1][0] : '';
  const later = st.days.filter(([d]) => d > lastShown && !byDay.has(d));
  const laterCount = later.reduce((n, [, c]) => n + c, 0);

  const first = stored[0];
  const lead = row
    ? st.total
      ? `${where}で開催される${g.name}（${game.short}）の店舗大会・交流会・体験会を日付順に掲載。${md(st.days[0][0])}から${st.days.length}日間で${st.total.toLocaleString('ja-JP')}件（データ取得 ${jpDate(jstDate(row.fetched_at))}）。`
      : `${where}で開催予定の${game.short}のイベントは、いま掲載していません（データ取得 ${jpDate(jstDate(row.fetched_at))}）。`
    : `${where}の${game.short}のイベント情報は準備中です。`;
  const desc = st.total && first
    ? `${where}の${g.name}（${game.short}）の大会・イベント${st.total.toLocaleString('ja-JP')}件。次は${md(first.starts_on)}「${displayName(first).slice(0, 40)}」。開催日・会場・参加費・受付状況を一覧でチェックできます。`
    : `${where}の${g.name}（${game.short}）の店舗大会・交流会・体験会をトレカカレンダーで探せます。`;

  const r = renderer(gi, ROW_GAMES);
  const rank = (e: Ev) => (e.event_status === 'cancelled' ? 1 : 0);
  const sections = shownDays.map(([day, total]) => {
    const evs = [...byDay.get(day)!].sort((a, b) => rank(a) - rank(b));
    const more = total > evs.length;
    const rows = r.group(evs).map((x) => ('rows' in x ? r.grp(x as Group, { day, col: code, pref: loc, more }) : r.row((x as { e: Ev }).e, { col: code, pref: loc }))).join('');
    const all = more ? `<a class="lp-more" href="${esc(eventsUrl({ game: code, pref: loc, range: 'custom', from: day, to: day }))}" rel="nofollow">この日の${total}件をすべて見る →</a>` : '';
    return `<section class="lp-day" aria-labelledby="d-${day}"><h2 id="d-${day}"><time datetime="${day}">${md(day)}</time><small>${total}件${more ? `（${evs.length}件を表示）` : ''}</small></h2><div class="lp-rows">${rows}</div>${all}</section>`;
  });
  if (laterCount) {
    sections.push(`<p class="lp-empty">${md(later[0][0])}以降にもう${laterCount.toLocaleString('ja-JP')}件あります。<a href="${esc(eventsUrl({ game: code, pref: loc }))}" rel="nofollow">イベントカレンダーで見る →</a></p>`);
  }
  if (!sections.length) {
    sections.push(`<p class="lp-empty">${row ? `${where}で開催予定の${esc(game.short)}のイベントは、いま掲載していません。` : `${where}の${esc(game.short)}のイベント情報は準備中です。`}<a href="${esc(eventsUrl({ game: code, pref: loc }))}" rel="nofollow">イベントカレンダーで探す →</a></p>`);
  }

  const crumbs: [string, string | null][] = [['トップ', '/'], ['イベントカレンダー', '/events/'], [loc === 'online' ? `${game.short}のオンラインイベント` : `${place.name}の${game.short}イベント`, null]];
  const crumbHtml = '<nav class="crumbs" aria-label="パンくず">' + crumbs.map(([n, h]) => (h ? `<a href="${h}">${esc(n)}</a>` : `<span aria-current="page">${esc(n)}</span>`)).join(' › ') + '</nav>';
  const go = [`<a href="${esc(eventsUrl({ game: code, pref: loc }))}" rel="nofollow">地図・カレンダーで探す →</a>`];
  if (game.releases) go.push(`<a href="/${g.slug}/">${esc(game.short)}の新弾発売日 →</a>`);
  const prefLinks = LOCS.map((l) => (l.loc === loc ? `<a href="${landingPath(code, l.loc)}" aria-current="page">${esc(l.name)}</a>` : `<a href="${landingPath(code, l.loc)}">${esc(l.name)}</a>`)).join('');
  const gameLinks = GAMES.filter((x) => x.code !== code).map((x) => `<a href="${landingPath(x.code, loc)}">${esc(LANDING_GAMES[x.code].short)}</a>`).join('');
  const main = `${crumbHtml}<div class="lp-head"><h1>${esc(h1)}</h1><p>${esc(lead)}</p></div><p class="lp-go">${go.join('')}</p>`
    + `<main class="lp-list" id="results">${sections.join('')}</main>`
    + `<section class="lp-links" aria-label="ほかのイベント一覧"><div><h2>ほかの地域の${esc(game.short)}イベント</h2><p>${prefLinks}</p></div>`
    + `<div><h2>${esc(where)}のほかのタイトルのイベント</h2><p>${gameLinks}</p></div></section>`;

  const ld: unknown[] = [{
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: crumbs.map(([n, h], i) => ({ '@type': 'ListItem', position: i + 1, name: n, item: h ? SITE + h : url })),
  }];
  const shown = shownDays.flatMap(([d]) => byDay.get(d)!);
  for (const e of shown.slice(0, MAX_LD_EVENTS)) {
    const x = eventLd(e, url);
    if (x) ld.push({ '@context': 'https://schema.org', ...x });
  }
  const types = [...new Set(stored.map((e) => e.group?.event_type_code).filter((t): t is string => !!t && !!TYPE_LABELS[t]))].slice(0, 5).map((t) => TYPE_LABELS[t]);
  const kw = [`${game.short} 大会`, `${game.short} イベント`, `${where} ${game.short}`, `${where} TCG 大会`, ...types.map((t) => `${game.short} ${t}`), 'トレカ 大会', '店舗大会'];
  const head = `<title>${esc(title)}</title>\n<meta name="description" content="${esc(desc)}">\n`
    + (st.indexable ? '' : '<meta name="robots" content="noindex">\n')
    + `<link rel="canonical" href="${url}">\n<meta property="og:title" content="${esc(title)}">\n<meta property="og:description" content="${esc(desc)}">\n`
    + `<meta property="og:url" content="${url}">\n<meta property="og:image:alt" content="${esc(h1)}｜トレカカレンダー">\n`
    + `<meta name="twitter:title" content="${esc(title)}">\n<meta name="twitter:description" content="${esc(desc)}">\n`
    + `<meta name="keywords" content="${esc([...new Set(kw)].join(','))}">\n${ld.map(jsonLd).join('')}`;
  const html = template
    .replace(/<!--LP_HEAD-->[\s\S]*?<!--\/LP_HEAD-->/, () => head)
    .replace(/<!--LP_MAIN-->[\s\S]*?<!--\/LP_MAIN-->/, () => main);
  return { status: row ? 200 : 404, indexable: st.indexable, html };
}

/** The indexable landing pages as a sitemap (lastmod = the data's fetch day). */
export async function landingSitemap(db: D1Database, today: string): Promise<string> {
  let rows: (LandingRow & { game_code: string; loc: string })[] = [];
  try {
    rows = (await db.prepare('SELECT game_code, loc, fetched_at, built_on, days_json FROM landing_pages').all<LandingRow & { game_code: string; loc: string }>()).results;
  } catch (e) {
    if (!missingTable(e)) throw e;
  }
  const known = new Set(GAMES.map((g) => g.code as string));
  const locs = new Set(LOCS.map((l) => l.loc));
  const urls = rows
    .filter((r) => known.has(r.game_code) && locs.has(r.loc) && landingStatus(r, today).indexable)
    .map((r) => landingPath(r.game_code, r.loc) + '\t' + jstDate(r.fetched_at))
    .sort()
    .map((x) => {
      const [p, lm] = x.split('\t');
      return `<url><loc>${SITE}${p}</loc><lastmod>${lm}</lastmod></url>`;
    });
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}
