"""Pilot: read release info from official TCG sites and compare it with data/items.json.

  .venv/bin/python -I scripts/official/run.py [--games pokemon,onepiece,mtg]

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
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import LEDGER, ROOT, fetch, jev_choice, llm_json, load_env, page_text  # noqa: E402

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
  "product_type": short Japanese label such as 拡張パック / 強化拡張パック / 構築デッキ / スターターデッキ / セット / サプライ,
  "editions": list of language editions this entry is sold in, e.g. ["日本語版"], ["英語版"], ["日本語版", "英語版"]; [] if the page does not say,
  "url": link to this product's own page if the page has one, else null,
  "image_url": URL of the product package image if shown, else null,
  "tentative": true when the name, date or price is provisional ((仮), 予定, 未定)
}}]}}

Rules: Japanese and English editions are separate products. Copy values from the page; never guess. Skip events, campaigns, card reveals and prizes that are not sold. Return {{"products": []}} if there are none.

Page text:
{text}"""

LINKS_PROMPT = """Card game: {full_name}
Today: {today}
Page: {url}
This page lists sets or products. Pick the links to pages of sets or products that are released on or after {since} or announced as upcoming (発売予定, 予約). Ignore older sets, events, articles and card galleries.

Reply as {{"links": [{{"title": link text, "url": absolute URL}}]}} with at most {limit} links, newest first.

Page text:
{text}"""


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
    m = re.search(r'(\d[\d,]*)\s*円', text or '')
    return int(m.group(1).replace(',', '')) if m else None


def clean_entry(e, game, source):
    date = e.get('release_date')
    if date and not parse_date(date):
        date = None
    date = date or parse_date(e.get('release_date_text'))
    return {'game': game, 'name': (e.get('name') or '').strip(), 'date': date, 'date_text': e.get('release_date_text'),
            'pack_yen': e.get('price_pack_yen') if isinstance(e.get('price_pack_yen'), int) else yen(e.get('price_text')),
            'box_yen': e.get('price_box_yen') if isinstance(e.get('price_box_yen'), int) else None,
            'type': e.get('product_type'), 'url': e.get('url'), 'image': e.get('image_url'),
            'tentative': bool(e.get('tentative')), 'source': source,
            'editions': [x for x in (e.get('editions') or []) if isinstance(x, str)]}


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
                        'tentative': False, 'source': 'pokemon_api'})
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
    """Pair official entries with existing items: name similarity shortlists, Jev decides SAME / DIFFERENT."""
    pairs = []
    for i, e in enumerate(entries):
        # names differ in script (スター・トレック vs Star Trek), so items released within 3 days all go to Jev;
        # undated or far-off entries fall back to the closest names
        near = [x for x in existing if e['date'] and abs((datetime.date.fromisoformat(x['date']) - datetime.date.fromisoformat(e['date'])).days) <= 3]
        cands = near or [x for x in sorted(existing, key=lambda x: -sim(x['name'], e['name']))[:3] if sim(x['name'], e['name']) >= 0.15]
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
    used = {}
    for i, (xid, p) in sorted(best.items(), key=lambda kv: -kv[1][1]):
        if xid not in used:
            used[xid] = i
            entries[i]['match'] = xid
    return used


def run_game(key, src, items, today, since, log):
    started = time.time()
    entries = []
    for page in src['pages']:
        try:
            if page['kind'] == 'pokemon_api':
                got = from_pokemon_api(src, page, since)
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
    existing = [x for x in items if x['game'] == src['game'] and x['date'] >= since]
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
        lines.append(f"| {r['game']} | {n} | {len(hit)} | {len(hit) / n:.0%} | {date_ok}/{len(hit)} | {price_ok}/{price_n} | {len(only)} | {r['seconds']:.0f}s |" if n else
                     f"| {r['game']} | 0 | 0 | – | – | – | {len(only)} | {r['seconds']:.0f}s |")
    lines.append('')
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
            lines.append(f"- {'⚠️' if diffs else '✅'} {x['date']} {x['name']}  ⇔  {e['name']}" + (f"（{'; '.join(diffs)}）" if diffs else ''))
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
    keys = sys.argv[sys.argv.index('--games') + 1].split(',') if '--games' in sys.argv else list(sources)
    today = datetime.date.today()
    since = today.isoformat()
    items = json.load(open(os.path.join(ROOT, 'data/items.json')))
    log, results = [], []
    for k in keys:
        results.append(run_game(k, sources[k], items, today.isoformat(), since, log))
    out = os.path.join(HERE, 'out')
    os.makedirs(out, exist_ok=True)
    md = report(results, today.isoformat(), since, log)
    open(os.path.join(out, f'report-{today}.md'), 'w').write(md)
    json.dump([{**{k: v for k, v in r.items() if k not in ('existing', 'used')}} for r in results],
              open(os.path.join(out, f'candidates-{today}.json'), 'w'), ensure_ascii=False, indent=1)
    print(md)


if __name__ == '__main__':
    main()
