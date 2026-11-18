const formatters = new Map();

function dateParts(epoch, zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }));
  return Object.fromEntries(formatters.get(zone).formatToParts(new Date(epoch)).map(part => [part.type, part.value]));
}

export function searchText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ja-JP');
}

export function jstStart(record) {
  const raw = record.start_datetime_source;
  const match = typeof raw === 'string' && raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!match) return { date: null, time: null, weekday: null, dateBasis: 'unknown' };
  const sourceDate = `${match[1]}-${match[2]}-${match[3]}`;
  const midnight = Date.parse(sourceDate + 'T00:00:00Z');
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0,10) !== sourceDate) return { date: null, time: null, weekday: null, dateBasis: 'unknown' };
  const fallback = { date: sourceDate, time: null, weekday: new Date(sourceDate + 'T00:00:00Z').getUTCDay(), dateBasis: 'source' };
  if (!match[4] || Number(record.start_datetime_hidden_type_source) === 2) return fallback;
  try {
    const naive = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
    if (new Date(naive).toISOString().slice(0, 10) !== sourceDate) return { date: null, time: null, weekday: null, dateBasis: 'unknown' };
    let epoch;
    if (match[7]) {
      epoch = Date.parse(raw.replace(' ', 'T'));
    } else {
      if (!record.timezone_source) return fallback;
      epoch = naive;
      for (let attempt = 0; attempt < 3; attempt++) {
        const local = dateParts(epoch, record.timezone_source);
        const localEpoch = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second));
        const next = epoch + naive - localEpoch;
        if (next === epoch) break;
        epoch = next;
      }
      const check = dateParts(epoch, record.timezone_source);
      if (`${check.year}-${check.month}-${check.day}` !== sourceDate || check.hour !== match[4] || check.minute !== match[5]) return fallback;
    }
    const jst = dateParts(epoch, 'Asia/Tokyo');
    const date = `${jst.year}-${jst.month}-${jst.day}`;
    return { date, time: `${jst.hour}:${jst.minute}`, weekday: new Date(date + 'T00:00:00Z').getUTCDay(), dateBasis: 'JST' };
  } catch { return fallback; }
}

export function normalizeEvent(record) {
  const id = String(record.external_id || '');
  let url = null;
  try {
    const parsed = new URL(record.canonical_url);
    if (parsed.origin === 'https://www.bandai-tcg-plus.com' && parsed.pathname === `/event/${id}` && /^\d+$/.test(id) && !parsed.username && !parsed.password) url = parsed.origin + parsed.pathname;
  } catch {}
  return {
    id, title: record.title || '名称未提供', venue: record.venue_name || '门店未提供',
    prefecture: record.pref_code_source || '', prefectureName: record.pref_name || record.pref_code_source || '地区未确认',
    address: [record.city_address, record.street_address].filter(Boolean).join(' '),
    sourceDateTime: record.start_datetime_source, sourceTimezone: record.timezone_source,
    canceled: record.is_canceled_source === true || record.is_canceled_source === 1 || record.is_canceled_source === '1',
    url, ...jstStart(record)
  };
}

export function filterEvents(events, filters) {
  const query = searchText(filters.venue).trim();
  const weekdays = new Set(filters.weekdays);
  return events.filter(event => {
    if (filters.prefecture && event.prefecture !== filters.prefecture) return false;
    if (query && !searchText(event.venue + ' ' + event.address + ' ' + event.prefectureName).includes(query)) return false;
    if (filters.from && (!event.date || event.date < filters.from)) return false;
    if (filters.until && (!event.date || event.date > filters.until)) return false;
    if (weekdays.size !== 7 && (!event.date || !weekdays.has(event.weekday))) return false;
    if (filters.timeFrom && (!event.time || event.time < filters.timeFrom)) return false;
    if (filters.timeUntil && (!event.time || event.time >= filters.timeUntil)) return false;
    return true;
  });
}
