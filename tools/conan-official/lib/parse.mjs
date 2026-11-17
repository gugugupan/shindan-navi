// Parses the server-rendered /eventsearch page (公認店イベント 開催日程検索) into raw rows.
// The page has no event or store ids: each <li> of ul.event_table is one store-hosted event.

export const ORIGIN = 'https://www.takaratomy.co.jp';
export const SEARCH_PATH = '/products/conan-cardgame/eventsearch';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
export function decode(s) {
  return s
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, k) => ENTITIES[k])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Inner HTML → text with <br> kept as newlines.
export function htmlText(s) {
  return decode(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const div = (li, cls) => {
  const m = li.match(new RegExp(`<div class="${cls}">([\\s\\S]*?)</div>`));
  return m ? m[1] : null;
};

export function searchUrl(params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const qs = q.toString();
  return `${ORIGIN}${SEARCH_PATH}${qs ? `?${qs}` : ''}`;
}

// <select name="eventtype"> options = the series currently searchable (e.g. チャレンジ戦【2026年11月】).
export function parseSeriesOptions(html) {
  const sel = html.match(/<select name="eventtype">([\s\S]*?)<\/select>/);
  if (!sel) throw new Error('eventsearch: eventtype select not found (page layout changed?)');
  return [...sel[1].matchAll(/<option value="([^"]+)"/g)].map((m) => decode(m[1]));
}

export function parseRows(html) {
  const start = html.indexOf('<ul class="event_table">');
  if (start < 0) {
    // An empty result has no list; anything else means the layout changed.
    if (/<div class="eventSearch">/.test(html)) return [];
    throw new Error('eventsearch: result container not found (page layout changed?)');
  }
  const end = html.indexOf('</ul>', start);
  const body = html.slice(start, end);
  const rows = [];
  for (const li of body.split(/<li>/).slice(1)) {
    const series = div(li, 'event_type_name');
    if (series === null) continue;
    const shopName = li.match(/<span class="shop_name">([\s\S]*?)<\/span>/);
    const address = div(li, 'address');
    const openDate = div(li, 'open_date');
    if (!shopName || address === null || openDate === null) throw new Error(`eventsearch: incomplete row for ${series}`);
    const details = {};
    for (const m of li.matchAll(/<tr><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g)) {
      details[htmlText(m[1])] = htmlText(m[2]);
    }
    const capacity = div(li, 'capacity');
    rows.push({
      series: htmlText(series),
      shop_name: htmlText(shopName[1]),
      address: htmlText(address.replace(/<a [\s\S]*?<\/a>/g, '')),
      open_date: htmlText(openDate),
      capacity: capacity === null ? null : htmlText(capacity),
      details,
    });
  }
  return rows;
}
