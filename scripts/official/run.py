"""Pilot: read release info from official TCG sites and compare it with data/items.json.

  .venv/bin/python -I scripts/official/run.py [--games pokemon,onepiece,mtg] [--adopt-sources]

--adopt-sources writes the official source (page + key) of every matched item back into data/items.json,
so the next run pairs them by identity instead of asking Jev. Only the `source` field changes.

Jev answers the choice questions (is this news about a new product, what kind of product is this,
is this the same product as one we already list); the light LLM extracts fields from pages;
plain rules parse dates and prices. Writes scripts/official/out/report-YYYY-MM-DD.md and candidates-YYYY-MM-DD.json.
Read-only with respect to the site data.
"""
import datetime
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import LEDGER, ROOT, fetch, final_url, jev_choice, llm_json, load_env, page_text  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sourcekey import make_source, product_code  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
KINDS = {
    'BOOSTER_PACK': 'Booster / expansion packs (拡張パック, ブースターパック), including boxes of them.',
    'DECK': 'Starter, constructed or pre-built decks (スターターデッキ, 構築デッキ, スタートデッキ).',
    'PRODUCT_SET_OR_BOX': 'Gift sets, premium or special boxes, collections, bundles, card sets.',
    'SUPPLY_OR_ACCESSORY': 'Sleeves, deck cases, playmats, binders, card holders and other supplies.',
    'NOT_A_PRODUCT': 'Not an item for sale (event, campaign, news, prize, card list).',
}
NEWS_KINDS = {
    'NEW_PRODUCT_ANNOUNCEMENT': 'Announces a new product that will be sold (new set, deck, box, supply).',
    'PRODUCT_INFO_UPDATE': 'Changes or adds details of a product: release date, delay, price, contents, sales method.',
    'OTHER': 'Events, tournaments, rules, card reveals for an already announced set, campaigns, apps, apologies.',
}
SAME = {
    'SAME': 'The same sellable product: same set, same edition and language, same deck variant.',
    'DIFFERENT': 'Different products (pack vs deck of one set, Japanese vs English edition when both are stated, other deck colour or character), or not enough evidence. An edition that is "not stated" is unknown, not a difference by itself.',
}
EXTRACT_SYSTEM = 'You extract trading card game product release information from Japanese official web pages. Reply with JSON only.'
EXTRACT_PROMPT = """Card game: {full_name}
Today: {today}
Page: {url}
{context}
List every separately sold product on this page whose release date is on or after {since}, or whose release is announced without a fixed day (e.g. 「12月発売予定」).

Reply as {{"products": [{{
  "name": official product name exactly as written,
  "release_date": "YYYY-MM-DD" or null when no exact day is given,
  "release_date_text": the date as written, or null,
  "price_text": the price as written, or null,
  "price_pack_yen": integer price (tax included) of one pack or one item, or null,
  "price_box_yen": integer price (tax included) of one box, or null,
  "packs_per_box": integer number of packs in one box, or null,
  "cards_per_pack": integer number of cards in one pack (or in the deck / set), or null,
  "product_type": short Japanese label such as 拡張パック / 強化拡張パック / 構築デッキ / スターターデッキ / セット / サプライ,
  "editions": list of language editions this entry is sold in, e.g. ["日本語版"], ["英語版"], ["日本語版", "英語版"]; [] if the page does not say,
  "url": link to this product's own page if the page has one, else null,
  "image_url": URL of the product package image if shown, else null,
  "tentative": true when the name, date or price is provisional ((仮), 予定, 未定)
}}]}}

Rules: Japanese and English editions are separate products. "name" is the full product name including the set name (e.g. "Marvel: Darkhold Destiny Bundle", not just "Bundle"). A set or expansion by itself is not a product — list its packs, decks, boxes and bundles instead, and skip sets whose products are not named yet. Copy values from the page; never guess. Skip events, campaigns, card reveals and prizes that are not sold. Return {{"products": []}} if there are none.

Page text:
{text}"""

DETAIL_PROMPT = """Card game: {full_name}
Product: {name}
Page: {url}
This is the official page of the product above, or a page that lists it. Read the box and contents details of THIS product only.

Reply as {{
  "price_pack_yen": integer price (tax included) of one pack or one item, or null,
  "price_box_yen": integer price (tax included) of one box, or null,
  "packs_per_box": integer number of packs in one box, or null,
  "cards_per_pack": integer number of cards in one pack (or in the deck / set), or null
}}

Rules: copy values from the page; never guess or compute. Use null for anything the page does not state for this product. 「1パック5枚入り」 → cards_per_pack 5; 「1BOX 10パック入り」 → packs_per_box 10.

Page text:
{text}"""

LINKS_PROMPT = """Card game: {full_name}
Today: {today}
Page: {url}
This page lists sets or products. Pick the links to pages of sets or products that are released on or after {since} or announced as upcoming (発売予定, 予約). Ignore older sets, events, articles and card galleries.

Reply as {{"links": [{{"title": link text, "url": absolute URL}}]}} with at most {limit} links, newest first.

Page text:
{text}"""

PAIR_PROMPT = """Card game: {full_name}, release date {date}.
Official listings (from the publisher's site):
{official}

Calendar items (from shop aggregators; set names may be translated, e.g. スター・トレック = Star Trek, and editions are written as 日本語版 / 英語版 / EN):
{items}

Pair each official listing with the calendar item that is the same sellable product. Products sold only in English (bundles, scene boxes, collector's editions) match the English / EN calendar item. One calendar item may stand for several official variants (e.g. "統率者デッキ 日本語版" for four named decks): pair it with only the first such variant. Leave a listing unpaired when nothing matches. Each calendar item is used at most once.

Reply as {{"pairs": [{{"official": <listing number>, "item": "<calendar item id>"}}]}}"""


def norm(s):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', s or '')).lower()


def sim(a, b):
    a, b = norm(a), norm(b)
    A = {a[i:i + 2] for i in range(len(a) - 1)}
    B = {b[i:i + 2] for i in range(len(b) - 1)}
    return len(A & B) / max(1, len(A | B))


def parse_date(text):
    m = re.search(r'(20\d\d)\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})', text or '')
    if not m:
        return None
    try:
        return datetime.date(*map(int, m.groups())).isoformat()
    except ValueError:
        return None


def yen(text):
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        return int(text) or None
    m = re.search(r'[¥￥]\s*(\d[\d,]*)|(\d[\d,]*)\s*円', str(text or ''))
    return int((m.group(1) or m.group(2)).replace(',', '')) if m else None


def infer_year(text, since, name='', announced=None):
    """'11月14日（土）' without a year. With the announcement date, the first such day on or after it;
    otherwise a year written in the product name, else the occurrence closest to `since`."""
    m = re.search(r'(\d{1,2})\s*月\s*(\d{1,2})\s*日', text or '')
    if not m:
        return None
    if announced and parse_date(announced):
        a = datetime.date.fromisoformat(parse_date(announced))
        for y in (a.year, a.year + 1):
            try:
                d = datetime.date(y, int(m.group(1)), int(m.group(2)))
            except ValueError:
                continue
            if d >= a:
                return d.isoformat()
    ref = datetime.date.fromisoformat(since)
    hinted = re.search(r'(20\d\d)', name or '')
    years = [int(hinted.group(1))] if hinted else [ref.year - 1, ref.year, ref.year + 1]
    best = None
    for y in years:
        try:
            d = datetime.date(y, int(m.group(1)), int(m.group(2)))
        except ValueError:
            continue
        if best is None or abs((d - ref).days) < abs((best - ref).days):
            best = d
    return best.isoformat() if best else None


def clean_entry(e, game, source):
    date = e.get('release_date')
    if date and not parse_date(date):
        date = None
    date = date or parse_date(e.get('release_date_text'))
    return {'game': game, 'name': (e.get('name') or '').strip(), 'date': date, 'date_text': e.get('release_date_text'), 'source_page': source,
            'pack_yen': e.get('price_pack_yen') if isinstance(e.get('price_pack_yen'), int) else yen(e.get('price_text')),
            'box_yen': e.get('price_box_yen') if isinstance(e.get('price_box_yen'), int) else None,
            'per_box': count(e.get('packs_per_box')), 'per_pack': count(e.get('cards_per_pack')),
            'type': e.get('product_type'), 'url': e.get('url'), 'image': e.get('image_url'),
            'tentative': bool(e.get('tentative')), 'source': source,
            'editions': [x for x in (e.get('editions') or []) if isinstance(x, str)]}


def count(v):
    return v if isinstance(v, int) and 0 < v < 1000 else None


def product_details(full_name, name, url):
    """Box price and contents of one product read from its own page: {pack_yen, box_yen, per_box, per_pack}."""
    html = fetch(url, max_age=14 * 24 * 3600)
    data = llm_json(EXTRACT_SYSTEM, DETAIL_PROMPT.format(full_name=full_name, name=name, url=url, text=page_text(html, url)), max_tokens=300)
    yen_or_none = lambda v: v if isinstance(v, int) and v > 0 else None
    return {'pack_yen': yen_or_none(data.get('price_pack_yen')), 'box_yen': yen_or_none(data.get('price_box_yen')),
            'per_box': count(data.get('packs_per_box')), 'per_pack': count(data.get('cards_per_pack'))}


def split_editions(entries):
    """One entry per language edition, the way the calendar lists them (〜 日本語版 / 〜 英語版)."""
    out = []
    for e in entries:
        eds = e.get('editions') or []
        if len(eds) > 1:
            out += [{**e, 'editions': [ed], 'name': f"{e['name']} {ed}"} for ed in eds]
        else:
            out.append(e)
    return out


def extract(src, url, html, since, today, context=''):
    text = page_text(html, url)
    data = llm_json(EXTRACT_SYSTEM, EXTRACT_PROMPT.format(full_name=src['full_name'], today=today, url=url, since=since,
                                                          context=context, text=text))
    return [clean_entry(e, src['game'], url) for e in data.get('products') or [] if e.get('name')]


def from_pokemon_api(src, page, since):
    out = []
    for n in range(1, page.get('pages', 1) + 1):
        d = json.loads(fetch(page['url'].format(page=n), headers={'Referer': 'https://www.pokemon-card.com/products/'}))
        for p in d.get('products') or []:
            date = parse_date(p.get('releaseDate'))
            if not date or date < since:
                continue
            out.append({'game': src['game'], 'name': p['productTitle'], 'date': date, 'date_text': p.get('releaseDate'),
                        'pack_yen': yen(p.get('priceTxt')), 'box_yen': None, 'type': p.get('productType'),
                        'url': urllib.parse.urljoin('https://www.pokemon-card.com/', p.get('link_detailPage') or ''),
                        'image': urllib.parse.urljoin('https://www.pokemon-card.com/', p.get('tumbsImg') or ''),
                        'tentative': False, 'source': 'pokemon_api', 'source_page': page['url'].format(page=n)})
    return out


def _get(rec, path):
    for part in path.split('.'):
        rec = rec.get(part) if isinstance(rec, dict) else None
    return rec


def from_records(src, page, since):
    """Structured product records, no LLM: a JSON endpoint ("json_path") or objects embedded in the page ("regex").
    "fields" maps name / date / price / box / type / code / image / url to record keys;
    "url_template" / "image_template" are str.format templates over the record (keys with - become _)."""
    records = []
    for url in page.get('urls') or [page['url']]:
        try:
            body = fetch(url, headers=page.get('headers')).decode('utf-8', 'ignore')
        except urllib.error.HTTPError as ex:
            if ex.code == 404 and page.get('urls'):
                continue  # paged endpoints end with 404
            raise
        if page.get('regex'):
            for m in re.finditer(page['regex'], body, re.S):
                raw = m.group(1)
                if page.get('single_quotes'):
                    raw = re.sub(r"'([^'\\]*)'", r'"\1"', raw)
                try:
                    records.append(json.loads(raw))
                except ValueError:
                    continue
        else:
            data = json.loads(body)
            records += (_get(data, page['json_path']) if page.get('json_path') else data) or []
    f = page['fields']
    out = []
    for rec in records or []:
        flat = {k.replace('-', '_'): v for k, v in rec.items()} if isinstance(rec, dict) else {}
        date_text = str(_get(rec, f['date']) or '') if f.get('date') else ''
        date = parse_date(date_text) or (infer_year(date_text, since, str(_get(rec, f['name']) or ''),
                                                    str(_get(rec, f['announced']) or '') if f.get('announced') else None)
                                         if page.get('infer_year') else None)
        if date and date < since:
            continue
        if not date:
            ym = re.search(r'(20\d\d)\s*年\s*(\d{1,2})\s*月', date_text)
            if not ym or f'{int(ym.group(1)):04d}-{int(ym.group(2)):02d}' < since[:7]:
                continue
        link = ''
        if page.get('url_template') and all(flat.get(k) in v for k, v in (page.get('url_when') or {}).items()):
            link = page['url_template'].format(**flat)
        elif f.get('url') and _get(rec, f['url']):
            link = urllib.parse.urljoin(page.get('site') or page['url'], str(_get(rec, f['url'])))
        image = ''
        if page.get('image_template'):
            image = page['image_template'].format(**flat)
        elif f.get('image') and _get(rec, f['image']):
            raw = str(_get(rec, f['image']))
            base = page.get('image_base') if page.get('image_base') and not raw.startswith(('/', 'http')) else page.get('site') or page['url']
            image = urllib.parse.urljoin(base, raw)
        name = str(_get(rec, f['name']) or '').strip()
        if not name:
            continue
        out.append({'game': src['game'], 'name': name, 'date': date, 'date_text': date_text,
                    'pack_yen': yen(_get(rec, f['price'])) if f.get('price') else None,
                    'box_yen': yen(_get(rec, f['box'])) if f.get('box') else None,
                    'type': str(_get(rec, f['type']) or '') if f.get('type') else '', 'url': link or None, 'image': image or None,
                    'tentative': not date, 'source': 'records', 'source_page': page['url'], 'editions': []})
    return out


def from_news(src, page, since, today, log):
    html = fetch(page['url']).decode('utf-8', 'ignore')
    links, seen = [], set()
    for m in re.finditer(r'<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, re.S):
        href = urllib.parse.urljoin(page['url'], m.group(1))
        title = ' '.join(re.sub(r'<[^>]+>', ' ', m.group(2)).split())
        if href.startswith(page['link_prefix']) and title and href not in seen:
            seen.add(href)
            links.append((href, title))
    links = links[:page.get('max_links', 40)]
    answers = jev_choice(f'Triage {src["full_name"]} official news titles for a release calendar.', {
        f'n{i}': {'criteria': NEWS_KINDS, 'instructions': {
            'question': 'What is this official news item about?', 'news_title': t}}
        for i, (_, t) in enumerate(links)})
    picked = [(u, t) for i, (u, t) in enumerate(links) if answers.get(f'n{i}', ('OTHER', 0))[0] != 'OTHER'][:page.get('max_articles', 10)]
    log.append(f"news {page['url']}: {len(links)} titles → Jev picked {len(picked)}: " + ' / '.join(t[:40] for _, t in picked))
    with ThreadPoolExecutor(4) as pool:
        results = pool.map(lambda ut: extract(src, ut[0], fetch(ut[0]).decode('utf-8', 'ignore'), since, today,
                                              context=f'This is a news article titled: {ut[1]}'), picked)
    return [e for r in results for e in r]


def from_listing(src, page, since, today, log):
    html = fetch(page['url']).decode('utf-8', 'ignore')
    entries = extract(src, page['url'], html, since, today)
    if page.get('follow') == 'links':
        # the list only names sets; ask for the pages worth opening, then read each one
        data = llm_json(EXTRACT_SYSTEM, LINKS_PROMPT.format(full_name=src['full_name'], today=today, url=page['url'], since=since,
                                                            limit=page.get('max_follow', 5), text=page_text(html, page['url'])))
        links = [(l['url'], l.get('title') or '') for l in data.get('links') or [] if str(l.get('url', '')).startswith('http')]
        links = links[:page.get('max_follow', 5)]
        log.append(f"listing {page['url']}: {len(entries)} entries, opening {len(links)} set pages: " + ' / '.join(t for _, t in links))
        with ThreadPoolExecutor(4) as pool:
            results = pool.map(lambda ut: extract(src, ut[0], fetch(ut[0]).decode('utf-8', 'ignore'), since, today,
                                                  context=f'This is the page of: {ut[1]}'), links)
        return entries + [e for r in results for e in r]
    return entries


def dedupe(entries):
    out = {}
    for e in entries:
        k = (norm(e['name']), e['date'])
        if k not in out:
            out[k] = dict(e)
            continue
        for f, v in e.items():
            if out[k].get(f) in (None, '') and v not in (None, ''):
                out[k][f] = v
    return list(out.values())


def classify(entries, full_name):
    answers = jev_choice(f'Classify {full_name} items for a TCG release calendar.', {
        f'k{i}': {'criteria': KINDS, 'instructions': {
            'question': 'What kind of item is this?', 'item': f"{e['name']} / {e.get('type') or ''}"}}
        for i, e in enumerate(entries)})
    for i, e in enumerate(entries):
        e['kind'], e['kind_p'] = answers.get(f'k{i}', ('NOT_A_PRODUCT', 0))
    return [e for e in entries if e['kind'] != 'NOT_A_PRODUCT']


def match(entries, existing):
    """Pair official entries with existing items. Identity first (product code, official page + key), so most
    pairs need no model; what is left goes to Jev, shortlisted by shared official page, then by release date."""
    used, method = {}, {}
    for i, e in enumerate(entries):
        e['source'] = make_source(final_url(e.get('url') or e['source_page']), e['name'], 'official')
        code = product_code(e['name'])
        for x in existing:
            if x['id'] in used:
                continue
            xs = x.get('source') or {}
            if (code and (product_code(xs.get('key', '')) == code or product_code(x['name']) == code)) or \
                    (xs.get('url') == e['source']['url'] and xs.get('key') == e['source']['key']):
                used[x['id']] = i
                e['match'], method[i] = x['id'], 'code' if code else 'source'
                break
    pairs = []
    for i, e in enumerate(entries):
        if i in method:
            continue
        free = [x for x in existing if x['id'] not in used]
        same_page = [x for x in free if (x.get('source') or {}).get('url') == e['source']['url']]
        near = [x for x in free if e['date'] and abs((datetime.date.fromisoformat(x['date']) - datetime.date.fromisoformat(e['date'])).days) <= 3]
        cands = same_page or near or [x for x in sorted(free, key=lambda x: -sim(x['name'], e['name']))[:3] if sim(x['name'], e['name']) >= 0.15]
        pairs += [(i, x['id']) for x in cands]
    by_id = {x['id']: x for x in existing}
    answers = jev_choice('Decide whether two TCG product listings refer to the same product.', {
        f'm{j}': {'criteria': SAME, 'instructions': {
            'question': 'Do these two listings refer to the same product?',
            'listing_a': f"{entries[i]['name']} (release {entries[i]['date'] or entries[i]['date_text']}, {entries[i].get('type') or ''}, edition {'/'.join(entries[i].get('editions') or []) or 'not stated'})",
            'listing_b': f"{by_id[xid]['name']} (release {by_id[xid]['date']})"}}
        for j, (i, xid) in enumerate(pairs)}) if pairs else {}
    best = {}
    for j, (i, xid) in enumerate(pairs):
        label, p = answers.get(f'm{j}', ('DIFFERENT', 0))
        if label == 'SAME' and p > best.get(i, (None, 0.5))[1]:
            best[i] = (xid, p)
    for i, (xid, p) in sorted(best.items(), key=lambda kv: -kv[1][1]):
        if xid not in used:
            used[xid] = i
            entries[i]['match'], method[i] = xid, 'jev'
    # what is still unpaired on the same day is usually a translation / edition question: let the LLM pair the group
    for date in sorted({e['date'] for i, e in enumerate(entries) if i not in method and e['date']}):
        left = [i for i, e in enumerate(entries) if i not in method and e['date'] == date]
        free = [x for x in existing if x['id'] not in used and x['date'] == date]
        if not left or not free:
            continue
        data = llm_json(EXTRACT_SYSTEM, PAIR_PROMPT.format(
            full_name=entries[left[0]]['game'], date=date,
            official='\n'.join(f"{n}. {entries[i]['name']} ({entries[i].get('type') or ''})" for n, i in enumerate(left)),
            items='\n'.join(f"- {x['id']}: {x['name']}" for x in free)))
        ok = {x['id'] for x in free}
        for pr in data.get('pairs') or []:
            n, xid = pr.get('official'), pr.get('item')
            if isinstance(n, int) and 0 <= n < len(left) and xid in ok and xid not in used and left[n] not in method:
                used[xid] = left[n]
                entries[left[n]]['match'], method[left[n]] = xid, 'llm'
    for i, m in method.items():
        entries[i]['match_method'] = m
    return used


def run_game(key, src, items, today, since, log, skip_ids=()):
    started = time.time()
    entries = []
    for page in src['pages']:
        try:
            if page['kind'] == 'pokemon_api':
                got = from_pokemon_api(src, page, since)
            elif page['kind'] == 'records':
                got = from_records(src, page, since)
            elif page['kind'] == 'news':
                got = from_news(src, page, since, today, log)
            else:
                got = from_listing(src, page, since, today, log)
            log.append(f"{key} {page['kind']} {page['url']}: {len(got)} entries")
            entries += got
        except Exception as ex:
            log.append(f"{key} {page['kind']} {page['url']}: FAILED {ex!r}")
    entries = [e for e in split_editions(dedupe(entries)) if e['date'] is None or e['date'] >= since]
    entries = classify(entries, src['full_name']) if entries else []
    existing = [x for x in items if x['game'] == src['game'] and x['date'] >= since and x['id'] not in skip_ids]
    used = match(entries, existing) if entries else {}
    return {'key': key, 'game': src['game'], 'entries': entries, 'existing': existing, 'used': used, 'seconds': time.time() - started}


def report(results, today, since, log):
    lines = [f'# 公式サイト取得パイロット {today}', '', f'対象期間: {since} 以降に発売（または日付未定）', '']
    lines += ['| タイトル | 既存 | 公式で確認 | 再現率 | 日付一致 | 価格一致 | 公式のみ | 時間 |', '|---|---|---|---|---|---|---|---|']
    for r in results:
        by = {e.get('match'): e for e in r['entries'] if e.get('match')}
        hit = [x for x in r['existing'] if x['id'] in r['used']]
        date_ok = sum(1 for x in hit if by[x['id']]['date'] == x['date'])
        price_ok = sum(1 for x in hit if by[x['id']]['pack_yen'] and by[x['id']]['pack_yen'] == yen(x.get('pack')))
        price_n = sum(1 for x in hit if by[x['id']]['pack_yen'] and yen(x.get('pack')))
        only = [e for e in r['entries'] if not e.get('match')]
        n = len(r['existing'])
        how = {m: sum(1 for e in r['entries'] if e.get('match_method') == m) for m in ('code', 'source', 'jev', 'llm')}
        r['how'] = how
        lines.append(f"| {r['game']} | {n} | {len(hit)} | {len(hit) / n:.0%} | {date_ok}/{len(hit)} | {price_ok}/{price_n} | {len(only)} | {r['seconds']:.0f}s |" if n else
                     f"| {r['game']} | 0 | 0 | – | – | – | {len(only)} | {r['seconds']:.0f}s |")
    lines.append('')
    lines += ['照合方法（件数）: ' + ' / '.join(f"{r['game']} 商品番号 {r['how']['code']}・公式ページ {r['how']['source']}・Jev {r['how']['jev']}・LLM {r['how']['llm']}" for r in results), '']
    lines += ['## コスト', '', '| provider | calls | prompt tok | completion tok | cost (USD) | API time |', '|---|---|---|---|---|---|']
    for p, v in LEDGER.rows.items():
        lines.append(f"| {p} | {v['calls']} | {v['prompt_tokens']} | {v['completion_tokens']} | {v['cost']:.4f} | {v['seconds']:.0f}s |")
    lines.append('')
    for r in results:
        by = {e.get('match'): e for e in r['entries'] if e.get('match')}
        lines += [f"## {r['game']}", '', '### 既存データとの照合', '']
        for x in r['existing']:
            e = by.get(x['id'])
            if not e:
                lines.append(f"- ❌ 公式で見つからず: {x['date']} {x['name']}")
                continue
            diffs = []
            if e['date'] != x['date']:
                diffs.append(f"日付 公式={e['date'] or e['date_text']} / 既存={x['date']}")
            if e['pack_yen'] and yen(x.get('pack')) and e['pack_yen'] != yen(x.get('pack')):
                diffs.append(f"価格 公式={e['pack_yen']}円 / 既存={x.get('pack')}")
            lines.append(f"- {'⚠️' if diffs else '✅'} {x['date']} {x['name']}  ⇔  {e['name']} [{e.get('match_method')}]" + (f"（{'; '.join(diffs)}）" if diffs else ''))
        only = [e for e in r['entries'] if not e.get('match')]
        lines += ['', f'### 公式にあって既存データにないもの（{len(only)}）', '']
        for e in sorted(only, key=lambda e: (e['date'] or '9999', e['name'])):
            price = f" {e['pack_yen']}円" if e['pack_yen'] else ''
            lines.append(f"- {e['date'] or e['date_text'] or '日付未定'} [{e['kind']}] {e['name']}{price}{' （仮）' if e['tentative'] else ''}  — {e['url'] or e['source']}")
        lines.append('')
    lines += ['## ログ', ''] + [f'- {x}' for x in log]
    return '\n'.join(lines) + '\n'


def main():
    load_env()
    sources = json.load(open(os.path.join(HERE, 'sources.json')))
    keys = sys.argv[sys.argv.index('--games') + 1].split(',') if '--games' in sys.argv else [k for k in sources if not k.startswith('_')]
    today = datetime.date.today()
    since = today.isoformat()
    items = json.load(open(os.path.join(ROOT, 'data/items.json')))
    log, results = [], []
    for k in keys:
        results.append(run_game(k, sources[k], items, today.isoformat(), since, log))
    out = os.path.join(HERE, 'out')
    os.makedirs(out, exist_ok=True)
    if '--adopt-sources' in sys.argv:
        by_id = {x['id']: x for x in items}
        changed = 0
        for r in results:
            for e in r['entries']:
                x = by_id.get(e.get('match'))
                if x and x.get('source') != e['source']:
                    x['source'] = e['source']
                    changed += 1
        json.dump(items, open(os.path.join(ROOT, 'data/items.json'), 'w'), ensure_ascii=False, indent=1)
        log.append(f'adopted official sources for {changed} items')
    md = report(results, today.isoformat(), since, log)
    open(os.path.join(out, f'report-{today}.md'), 'w').write(md)
    json.dump([{**{k: v for k, v in r.items() if k not in ('existing', 'used')}} for r in results],
              open(os.path.join(out, f'candidates-{today}.json'), 'w'), ensure_ascii=False, indent=1)
    print(md)


if __name__ == '__main__':
    main()
