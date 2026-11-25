// Server-side copy of the event row renderer in src/evrow.html (window.snEv: name, row, grp, group), for the
// Worker-rendered landing pages. tests/evrow.test.ts runs src/evrow.html in node:vm and requires the same HTML for
// the same events, so a change there must be mirrored here.

export type Ev = Record<string, any>;
export interface RowGame {
  name: string;
  c: string;
  cd: string;
  /** the game's hub slug: its tags link /<hub>/ */
  hub?: string;
}
export interface RowOpts {
  compact?: boolean;
  col?: string | null;
  member?: boolean;
  pref?: string;
  pin?: string;
  cls?: string;
  attrs?: string;
  started?: boolean;
  day?: string;
  more?: boolean;
  memberOpts?: (e: Ev) => RowOpts;
}
export interface Group {
  key: string;
  rows: Ev[];
}
export type Item = { e: Ev } | Group;

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const md = (s: string) => {
  const [, m, d] = s.split('-').map(Number);
  return `${m}/${d}(${DOW[new Date(s + 'T00:00:00Z').getUTCDay()]})`;
};
const fmts = new Map<string, Intl.DateTimeFormat>();
const timeFmt = (tz?: string): Intl.DateTimeFormat => {
  const k = tz || 'Asia/Tokyo';
  let f = fmts.get(k);
  if (!f) {
    // Unlike the page (which would throw), an unknown zone renders in Asia/Tokyo: one bad row must not fail the page.
    try {
      f = new Intl.DateTimeFormat('ja-JP', { timeZone: k, hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {
      f = timeFmt('Asia/Tokyo');
    }
    fmts.set(k, f);
  }
  return f;
};
const jstDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' });
const jstDay = (s: string) => jstDayFmt.format(new Date(s));
const CAT: Record<string, string> = { tournament: '大会', casual: '交流会', teaching: '体験会', festival: 'フェス' };
const REG_METHOD: Record<string, string> = { first_come: '先着', lottery: '抽選', walk_in: '当日参加OK', invitation: '招待制' };

const SEP = '[\\/_・〜~\\-－–]';
const okM = (...ms: (string | undefined)[]) => ms.every((m) => m == null || (+m >= 1 && +m <= 12));
const MARKS: [RegExp, (e: Ev, ...a: any[]) => boolean][] = [
  [new RegExp(`[（(]\\s*(?:\\d{2,4}年)?(\\d{1,2})(?:${SEP}(\\d{1,2}))?月(?:開催|度)?\\s*[）)]`, 'g'), (e, m, a, b) => okM(a, b)],
  [new RegExp(`【\\s*(?:\\d{2,4}年)?(\\d{1,2})(?:${SEP}(\\d{1,2}))?月(?:開催|度)?\\s*】`, 'g'), (e, m, a, b) => okM(a, b)],
  [new RegExp(`【\\s*(\\d{2})\\/(\\d{1,2})(?:${SEP}(\\d{1,2})月?)?\\s*】`, 'g'),
    (e, m, y, a, b) => okM(a, b) && /^\d{4}-/.test(e.starts_on || '') && +y === +e.starts_on.slice(2, 4)],
  [/^\s*(\d{1,2})月度[\s　]+/, (e, m, a) => okM(a)],
];

export function name(e: Ev): string {
  const raw = String((e && e.name) || '');
  let s = raw;
  for (const [re, ok] of MARKS) s = s.replace(re, (...a: any[]) => (ok(e, ...a) ? ' ' : a[0]));
  s = s.replace(/[\s　]+/g, (m) => (m.includes('　') ? '　' : ' ')).replace(/^[\s　]+|[\s　]+$/g, '');
  return s || raw;
}
const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
export const codesOf = (e: Ev): string[] => (Array.isArray(e.game_codes) && e.game_codes.length ? e.game_codes : [e.game_code]);
const isPostcode = (s: unknown) => /^〒?\s*\d{3}-?\d{4}$/.test(String(s || '').trim());
export const venueLabel = (v: Ev | null | undefined) => (!v ? '' : isPostcode(v.name) && v.address ? v.address : v.name);
const hasTime = (e: Ev) => e.time_precision === 'datetime' && !!e.starts_at;
const timeOf = (e: Ev) => (hasTime(e) ? timeFmt(e.timezone).format(new Date(e.starts_at)) : '');
function when(e: Ev) {
  const multi = e.ends_on && e.ends_on !== e.starts_on;
  const span = multi ? `${md(e.starts_on)}〜${md(e.ends_on)}` : '';
  if (!hasTime(e)) return { cls: 'tbd', text: span ? span + ' · 時刻未定' : '時刻未定' };
  const f = timeFmt(e.timezone);
  const t = f.format(new Date(e.starts_at)) + '〜' + (e.ends_at && !multi ? f.format(new Date(e.ends_at)) : '');
  return { cls: '', text: span ? `${span} · ${t}` : t };
}
function place(e: Ev, pref?: string) {
  const v = e.venue;
  if (e.attendance_mode === 'online') return 'オンライン開催';
  const ar = v ? v.city || (v.region_code && v.region_code !== pref ? v.region_name || '' : '') : '';
  const p = v ? `${esc(venueLabel(v))}${ar ? `<span class="ar">${esc(ar)}</span>` : ''}` : '';
  if (e.attendance_mode === 'hybrid') return p ? p + '<span class="ar">オンライン参加あり</span>' : 'オンライン参加あり';
  return p || '<span class="ar0">会場は公式で確認</span>';
}
function fee(e: Ev) {
  if (e.fee_amount === 0) return { cls: '', text: '参加費 無料' };
  if (typeof e.fee_amount === 'number' && e.fee_amount > 0) {
    return { cls: '', text: e.fee_currency && e.fee_currency !== 'JPY' ? `参加費 ${e.fee_amount.toLocaleString('ja-JP')} ${e.fee_currency}` : `参加費 ${e.fee_amount.toLocaleString('ja-JP')}円` };
  }
  return { cls: 'unk', text: '参加費未確認' };
}
function reg(e: Ev) {
  switch (e.registration_status) {
    case 'open': return { cls: 'open', text: '受付中' };
    case 'not_open': {
      const o = e.registration_opens_at;
      return { cls: '', text: o ? `受付前（${md(jstDay(o))} ${timeFmt('Asia/Tokyo').format(new Date(o))}〜）` : '受付前' };
    }
    case 'waitlist': return { cls: '', text: 'キャンセル待ち' };
    case 'closed': return { cls: 'closed', text: '受付終了' };
    default: return { cls: 'unk', text: '受付状況は公式で確認' };
  }
}
export const safeUrl = (u: unknown) => (/^https:\/\//i.test(String(u || '')) ? String(u) : '');
const stBadge = (e: Ev) => (e.event_status === 'cancelled' ? '<span class="st">中止</span>' : e.event_status === 'postponed' ? '<span class="st post">延期</span>' : '');
const catOf = (e: Ev, nm: string) => {
  const c = CAT[e.group && e.group.category];
  return c && !nm.includes(c) ? c : '';
};

/** Same as snEv after init({gi, games}). */
export function renderer(gi: (name: string) => string, GAMES: Record<string, RowGame>) {
  function tags(e: Ev, col?: string | null) {
    return codesOf(e).filter((c) => c !== col).map((c) => {
      const x = GAMES[c] || { name: c, c: '#8a8f9e', cd: '#8a8f9e' };
      const st = `--gl:${x.c};--gd:${x.cd}`, t = gi(x.name) + esc(x.name);
      return x.hub ? `<a class="tag gl" href="/${x.hub}/" style="${st}">${t}</a>` : `<span class="tag" style="${st}">${t}</span>`;
    }).join('');
  }
  const gvars = (c: string) => {
    const g = GAMES[c] || { c: '#8a8f9e', cd: '#8a8f9e' };
    return `--gl:${g.c};--gd:${g.cd}`;
  };

  function row(e: Ev, o: RowOpts = {}) {
    const nm = name(e), cancelled = e.event_status === 'cancelled', w = when(e), col = o.member ? e.game_code : o.col;
    const facts: { cls: string; text: string }[] = [];
    if (!o.compact) facts.push(fee(e));
    if (!o.compact && Number.isInteger(e.capacity)) facts.push({ cls: '', text: `定員 ${e.capacity.toLocaleString('ja-JP')}名` });
    if (!cancelled) {
      const r = reg(e);
      if (!o.compact || r.cls !== 'unk') facts.push(r);
      if (REG_METHOD[e.registration_method]) facts.push({ cls: '', text: REG_METHOD[e.registration_method] });
    }
    if (o.compact && o.started) facts.push({ cls: 'done', text: '開始済み' });
    const url = safeUrl(e.source_url), href = esc(url), ext = `<span class="sr">（${esc(nm)}・外部サイト）</span>`;
    const tg = o.member ? '' : tags(e, col);
    const gn = e.group && e.group.name ? name({ name: e.group.name, starts_on: e.starts_on }) : '';
    const grp = !o.compact && gn && gn !== nm && !nm.includes(gn) ? `<span class="grp">${esc(gn)}</span>` : '';
    const cat = o.compact ? '' : catOf(e, nm);
    const title = nm !== e.name ? ` title="${esc(e.name)}"` : '';
    let n = '';
    if (!o.member) {
      n = o.compact
        ? (url ? `<a class="ev-n" href="${href}" target="_blank" rel="noopener"${title}>${stBadge(e)}<span class="t">${esc(nm)}</span>${ext}</a>` : `<p class="ev-n"${title}>${stBadge(e)}<span class="t">${esc(nm)}</span></p>`)
        : `<h4 class="ev-n"${title}>${stBadge(e)}<span class="t">${esc(nm)}</span>${cat ? `<span class="cat">${cat}</span>` : ''}${grp}</h4>`;
    }
    const venue = o.member && o.compact && url ? `<a class="ev-venue" href="${href}" target="_blank" rel="noopener">${place(e, o.pref)}${ext}</a>` : `<span class="ev-venue">${place(e, o.pref)}</span>`;
    const m = `<p class="ev-m">${tg}${o.member ? stBadge(e) : ''}<span class="ev-time ${w.cls}">${w.text}</span>${venue}${o.pin || ''}</p>`;
    const link = o.compact || !url ? '' : `<a class="ev-link" href="${href}" target="_blank" rel="noopener" data-game="${esc(e.game_code)}">${cancelled ? '公式で確認' : '公式で詳細・申込'} ↗${ext}</a>`;
    const s = facts.length || link ? `<div class="ev-s">${facts.length ? `<ul class="ev-f">${facts.map((f) => `<li class="${f.cls}">${esc(f.text)}</li>`).join('')}</ul>` : ''}${link}</div>` : '';
    const tag = o.compact ? 'li' : 'article';
    return `<${tag} class="ev${cancelled ? ' off' : ''}${o.cls || ''}" style="${gvars(e.game_code)}" data-id="${esc(e.id)}"${o.attrs || ''}>${n}${m}${s}</${tag}>`;
  }

  function group(rows: Ev[], part: (e: Ev) => unknown = () => 0): Item[] {
    const out: ({ e: Ev } | Group)[] = [], by = new Map<string, Group>();
    for (const e of rows) {
      if (e.event_status === 'cancelled' || e.event_status === 'postponed') { out.push({ e }); continue; }
      const k = [part(e), codesOf(e).join('+'), (e.group && e.group.event_type_code) || '', norm(name(e))].join('|');
      let g = by.get(k);
      if (!g) { g = { key: k, rows: [] }; by.set(k, g); out.push(g); }
      g.rows.push(e);
    }
    return out.map((x) => ('rows' in x && x.rows.length === 1 ? { e: x.rows[0] } : x));
  }

  // DOM ids per renderer (one page), like the page's per-lifetime map
  const ids = new Map<string, string>();
  const gid = (k: string) => {
    let v = ids.get(k);
    if (!v) { v = `evg${ids.size + 1}`; ids.set(k, v); }
    return v;
  };
  function grp(g: Group, o: RowOpts = {}) {
    const e = g.rows[0], nm = name(e), id = gid(`${o.day || ''}|${g.key}`), isOpen = false;
    const na = (v: Ev) => [venueLabel(v), v.address || v.city || ''].join('|'), byNa = new Map<string, string>();
    g.rows.forEach((x) => {
      const v = x.venue;
      if (!v || !v.source_id) return;
      const k = na(v), vid = 'id:' + v.source_id;
      byNa.set(k, byNa.has(k) && byNa.get(k) !== vid ? '' : vid);
    });
    const vk = (v: Ev | null | undefined) => (!v ? '' : v.source_id ? 'id:' + v.source_id : byNa.get(na(v)) || 'na:' + na(v));
    const vks = g.rows.map((x) => vk(x.venue)), vs = new Set(vks), n = g.rows.length;
    const mixed = vks.some((k) => k.startsWith('id:')) && vks.some((k) => k.startsWith('na:'));
    const stores = vs.has('') || mixed ? 0 : vs.size;
    const cnt = o.more ? (stores === n ? `${n}店舗以上` : `${n}件以上`) : stores ? (stores === n ? `${stores}店舗` : `${stores}店舗・${n}件`) : `${n}件`;
    const ts = g.rows.filter(hasTime).map((x) => [Date.parse(x.starts_at), timeOf(x)] as [number, string]).sort((a, b) => a[0] - b[0]);
    const tbd = g.rows.length - ts.length;
    const rng = ts.length ? (ts[0][1] === ts[ts.length - 1][1] ? `${ts[0][1]}〜` : `${ts[0][1]}〜${ts[ts.length - 1][1]} 開始`) + (tbd ? '・時刻未定あり' : '') : '時刻未定';
    const st: Record<string, { cls: string; n: number }> = {};
    g.rows.forEach((x) => {
      const r = reg(x), k = r.text.replace(/（.*$/, '');
      if (r.cls !== 'unk') (st[k] = st[k] || { cls: r.cls, n: 0 }).n++;
    });
    const ks = Object.keys(st);
    const facts = ks.length === 1 && st[ks[0]].n === n ? [{ cls: st[ks[0]].cls, text: ks[0] }] : ks.map((k) => ({ cls: st[k].cls, text: `${k} ${st[k].n}` }));
    const ms = new Set(g.rows.map((x) => REG_METHOD[x.registration_method] || ''));
    if (ms.size === 1 && !ms.has('')) facts.push({ cls: '', text: [...ms][0] });
    if (o.compact && o.started) facts.push({ cls: 'done', text: '開始済み' });
    const cat = o.compact ? '' : catOf(e, nm), title = nm !== e.name ? ` title="${esc(e.name)}"` : '';
    const act = stores && !(o.more && stores !== n) ? '店舗を表示' : '一覧を表示', label = `${act}（${esc(nm)}・${cnt}）`;
    const n1 = o.compact
      ? `<p class="ev-n"${title}><span class="t">${esc(nm)}</span> <span class="evg-c">— <b>${cnt.replace(/(\d+)/, '$1</b>')}</span></p>`
      : `<h4 class="ev-n"${title}><span class="t">${esc(nm)}</span> <span class="evg-c">— <b>${cnt.replace(/(\d+)/, '$1</b>')}</span>${cat ? `<span class="cat">${cat}</span>` : ''}</h4>`;
    const m = `<p class="ev-m">${tags(e, o.col)}<span class="ev-time">${rng}</span></p>`;
    const tog = `<button type="button" class="evg-tog" aria-expanded="${isOpen}" aria-controls="${id}" aria-label="${label}">${act}</button>`;
    const s = `<div class="ev-s">${facts.length ? `<ul class="ev-f">${facts.map((f) => `<li class="${f.cls}">${esc(f.text)}</li>`).join('')}</ul>` : ''}${tog}</div>`;
    const tag = o.compact ? 'li' : 'article', lt = o.compact ? 'ul' : 'div';
    const mem = g.rows.map((x) => row(x, { ...o, ...(o.memberOpts ? o.memberOpts(x) : {}), member: true, compact: o.compact })).join('');
    return `<${tag} class="ev evg${o.cls || ''}" style="${gvars(e.game_code)}" data-g="${id}">${n1}${m}${s}<${lt} class="evg-l" id="${id}"${isOpen ? '' : ' hidden'}>${mem}</${lt}></${tag}>`;
  }
  return { row, grp, group, name };
}
