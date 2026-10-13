"""Refresh data/items.json from カードラボ and トレカの地図.

Run locally with the project venv, review data/update-report.md and `git diff`, then commit and push
(the push is what publishes). Nothing is written when a source looks broken.

  .venv/bin/python -I scripts/update_data.py            # update data + report
  .venv/bin/python -I scripts/update_data.py --dry-run  # report only
"""
import datetime
import hashlib
import html
import io
import json
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sourcekey import canonical_url, is_official, make_source, product_code  # noqa: E402

OFFICIAL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'official')
# official-only entries of these kinds are added to the calendar; supplies are only counted
ADD_KINDS = {'BOOSTER_PACK', 'DECK', 'PRODUCT_SET_OR_BOX'}
PLACEHOLDER_IMG = re.compile(r'now[_-]?(printing|designing)|noimage|no[_-]image|dummy|comingsoon|coming[_-]soon', re.I)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
THUMBS = os.path.join(ROOT, 'public/thumbs')
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
CLABO_URL = 'https://www.c-labo.jp/special/2028/'
TORECAMAP_URL = 'https://torecamap.co.jp/release-schedule?year={y}&month={m}'
TORECAMAP_MONTHS = 6
KEEP_PAST_DAYS = 30
MIN_RATIO = 0.7

# Source labels → one display name per title (both sites abbreviate differently).
GAME = {'MTG': 'MTG', 'ヴァイス': 'ヴァイスシュヴァルツ', 'D-CROSS': 'DIVINE CROSS', 'ポケモン': 'ポケモンカード', 'ヴァンガ': 'ヴァンガード',
        'ヴァンガード': 'ヴァンガード', 'バトスピ': 'バトルスピリッツ', 'ユニアリ': 'UNION ARENA', 'ラブカ': 'ラブライブ！OCG', '遊戯王': '遊戯王OCG',
        '遊戯王OCG': '遊戯王OCG', '遊戯王RD': '遊戯王ラッシュデュエル', 'ラッシュデュエル': '遊戯王ラッシュデュエル', 'パルワールド TCG': 'パルワールド',
        'デジモン': 'デジモン', 'X Stars': 'Xross Stars', 'クロスタ': 'Xross Stars', 'ウルトラマン': 'ウルトラマン', 'ビルディバイド': 'ビルディバイド',
        '神椿TCG': 'KAMITSUBAKI', 'ゴジラ': 'ゴジラ', 'ホロビートカードゲーム': 'ホロビート', 'DBS FW': 'DBフュージョンワールド',
        'DBFW': 'DBフュージョンワールド', 'シャドバ': 'Shadowverse EVOLVE', 'FF': 'FFTCG', 'Z/X': 'Z/X', 'バボカ': 'バボカ!!', 'ワンピース': 'ONE PIECE',
        'OSICA': 'OSICA', 'ファンスターズ': 'ファンスターズリーグ', 'その他': 'その他', 'Reバース': 'Reバース', 'WSブラウ': 'ヴァイスシュヴァルツブラウ',
        'ロルカナ': 'ロルカナ', 'デュエマ': 'デュエル・マスターズ', 'ACG': 'アニマルカードゲーム', 'Harry Potter': 'Harry Potter', 'Lycee': 'リセ',
        '五等分の花嫁': '五等分の花嫁', 'WIXOSS': 'WIXOSS', 'コナン': '名探偵コナン', '名探偵コナン': '名探偵コナン', 'ガンダム': 'ガンダム',
        'FaB': 'Flesh and Blood'}


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()


def norm(name):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', name)).lower()


def sim(a, b):
    a, b = norm(a), norm(b)
    A = {a[i:i + 2] for i in range(len(a) - 1)}
    B = {b[i:i + 2] for i in range(len(b) - 1)}
    return len(A & B) / max(1, len(A | B))


def item_id(game, name):
    return 'i' + hashlib.sha1(f'{game}|{norm(name)}'.encode()).hexdigest()[:10]


def game_name(label, unknown):
    if label not in GAME:
        unknown.add(label)
    return GAME.get(label, label)


def parse_clabo(today, unknown):
    s = fetch(CLABO_URL).decode('utf-8')
    a, b = s.find('id="hatsubai_daily"'), s.find('id="hatsubai_cate"')
    if a < 0 or b < 0:
        raise RuntimeError('カードラボ: daily section not found (page layout changed?)')
    out = []
    for blk in re.split(r'<h3>', s[a:b])[1:]:
        m = re.match(r'(\d+)月(\d+)日\((.)\)', blk)
        if not m:
            continue
        mo, dy, dow = int(m.group(1)), int(m.group(2)), m.group(3)
        # headings carry no year; pick the one (this year or next) whose weekday matches
        year = next((y for y in (today.year, today.year + 1, today.year - 1)
                     if _valid(y, mo, dy) and '月火水木金土日'[datetime.date(y, mo, dy).weekday()] == dow), None)
        if year is None:
            continue
        date = datetime.date(year, mo, dy).isoformat()
        for tr in re.findall(r'<tr>(.*?)</tr>', blk, re.S):
            tds = [html.unescape(re.sub(r'<[^>]+>', '', x)).strip() for x in re.findall(r'<td[^>]*>(.*?)</td>', tr, re.S)]
            if len(tds) < 2 or not tds[1]:
                continue
            out.append(dict(date=date, game=game_name(tds[0], unknown), name=tds[1], pack=tds[2] if len(tds) > 2 else '',
                            box='', url='', img='', src='clabo'))
    return out


def _valid(y, m, d):
    try:
        datetime.date(y, m, d)
        return True
    except ValueError:
        return False


def parse_torecamap(today, unknown):
    out, seen = [], set()
    y, m = today.year, today.month
    for _ in range(TORECAMAP_MONTHS):
        s = fetch(TORECAMAP_URL.format(y=y, m=m)).decode('utf-8')
        for g in re.split(r'class="ReleaseScheduleDayGroup_release-schedule-day-group', s)[1:]:
            dm = re.search(r'ReleaseScheduleDayGroup_text__\w+">(\d+)/(\d+)/(\d+)', g)
            if not dm:
                continue
            date = '%04d-%02d-%02d' % tuple(map(int, dm.groups()))
            for it in re.split(r'ReleaseScheduleDayGroup_item__', g)[1:]:
                name = re.search(r'ProductInfo_name__\w+">(.*?)</div>', it, re.S)
                if not name:
                    continue  # RSC payload duplicate, not rendered HTML
                name = html.unescape(re.sub(r'<[^>]+>', '', name.group(1))).replace('​', '').strip()
                if (date, name) in seen:
                    continue
                seen.add((date, name))
                tag = re.search(r'Tag_tag__[^"]*">([^<]*)', it)
                href = re.search(r'<a href="([^"]*)"', it)
                img = re.search(r'src="/_next/image\?url=([^&"]*)', it)
                img = urllib.parse.unquote(img.group(1)) if img else ''
                prices = dict(re.findall(r'ProductInfo_label__\w+">([^<]*)</p><span class="ProductInfo_price__\w+">([^<]*)', it))
                out.append(dict(date=date, game=game_name(html.unescape(tag.group(1)) if tag else '', unknown), name=name,
                                pack=prices.get('1パック：', ''), box=prices.get('1BOX：', '').replace('値段設定なし', ''),
                                url=html.unescape(href.group(1)) if href else '', img='' if 'no-image' in img else img, src='torecamap'))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def combine(clabo, tm):
    """One record per product: カードラボ names/prices, トレカの地図 box price, link and image when they match."""
    rows = [dict(r, sources=['clabo']) for r in clabo]
    for t in tm:
        cands = [r for r in rows if r['date'] == t['date'] and r['game'] == t['game'] and 'torecamap' not in r['sources']]
        best = max(cands, key=lambda r: sim(r['name'], t['name']), default=None)
        if best and sim(best['name'], t['name']) > 0.05:
            best.update(box=t['box'], url=t['url'], img=t['img'])
            best['pack'] = best['pack'] or t['pack']
            best['sources'].append('torecamap')
        else:
            rows.append(dict(t, sources=['torecamap']))
    return rows


def save_thumb(url):
    name = hashlib.md5(url.encode()).hexdigest()[:12] + '.jpg'
    path = os.path.join(THUMBS, name)
    if not os.path.exists(path):
        im = Image.open(io.BytesIO(fetch(url)))
        if im.mode in ('RGBA', 'LA', 'P'):
            im = im.convert('RGBA')
            bg = Image.new('RGB', im.size, 'white')
            bg.paste(im, mask=im.split()[-1])
            im = bg
        im = im.convert('RGB')
        im.thumbnail((280, 280))
        im.save(path, 'JPEG', quality=78)
    return 'thumbs/' + name


def find_by_source(s, existing, used):
    """Same release by identity, before any name matching: official product code within the title,
    then the official page (url + key, or a page that only one existing item points at)."""
    free = [x for x in existing if x['id'] not in used and x['game'] == s['game']]
    code = product_code(s['name'])
    if code:
        for x in free:
            if product_code((x.get('source') or {}).get('key', '')) == code or product_code(x['name']) == code:
                return x
    if s['url'] and is_official(s['url']):
        src = make_source(s['url'], s['name'])
        same_page = [x for x in free if (x.get('source') or {}).get('url') == src['url']]
        for x in same_page:
            if x['source'].get('key') == src['key']:
                return x
        if len(same_page) == 1 and sum(1 for x in existing if (x.get('source') or {}).get('url') == src['url']) == 1:
            return same_page[0]
    return None


def apply_overrides(items, overrides):
    out = []
    for item in items:
        ov = overrides.get(item['id']) or {}
        if ov.get('hide'):
            continue
        item.update({k: v for k, v in ov.items() if k not in ('hide', 'note') and not k.startswith('_')})
        out.append(item)
    return out


def merge(existing, scraped, overrides, today, report, dry):
    cutoff = (today - datetime.timedelta(days=KEEP_PAST_DAYS)).isoformat()
    for e in existing:
        if e['date'] < cutoff:
            report['dropped'].append(f"{e['date']}  [{e['game']}] {e['name']}")
    existing = [e for e in existing if e['date'] >= cutoff]
    scraped = [s for s in scraped if s['date'] >= cutoff]
    by_id = {e['id']: e for e in existing}
    used = set()
    out = []
    for s in sorted(scraped, key=lambda r: (r['date'], r['game'], r['name'])):
        sid = item_id(s['game'], s['name'])
        e = find_by_source(s, existing, used)
        if e is None and sid not in used:
            e = by_id.get(sid)
        if e is None:
            # renamed or moved: same title, close name, within ~3 months
            cands = [x for x in existing if x['id'] not in used and x['game'] == s['game']
                     and abs((datetime.date.fromisoformat(x['date']) - datetime.date.fromisoformat(s['date'])).days) <= 90]
            best = max(cands, key=lambda x: sim(x['name'], s['name']), default=None)
            if best and (sim(best['name'], s['name']) >= 0.75 or (best['date'] == s['date'] and sim(best['name'], s['name']) >= 0.5)):
                e = best
        if e is not None:
            used.add(e['id'])
            item = dict(e)
            if e['date'] != s['date']:
                report['moved'].append(f"{e['date']} → {s['date']}  [{s['game']}] {s['name']}")
            for k in ('pack', 'box'):
                if s[k] and s[k] != e.get(k):
                    if e.get(k):
                        report['price'].append(f"[{s['game']}] {s['name']}  {k}: {e.get(k)} → {s[k]}")
                    item[k] = s[k]
            item.update(date=s['date'], name=s['name'], game=s['game'])
            if not item.get('url') and s['url']:
                item['url'] = s['url']
            if (item.get('source') or {}).get('site') != 'official' and s['url'] and is_official(s['url']):
                item['source'] = make_source(s['url'], s['name'], 'official')
            if s['img'] and (not item.get('thumb') or item.get('approx')):
                if not dry:
                    item['thumb'] = save_thumb(s['img'])
                item['approx'] = False
                report['image'].append(f"[{s['game']}] {s['name']}")
        else:
            item = dict(id=sid, date=s['date'], game=s['game'], name=s['name'], pack=s['pack'], box=s['box'],
                        url=s['url'], thumb='', approx=False,
                        source=make_source(s['url'], s['name']) if s['url'] and is_official(s['url']) else
                        {'url': '', 'key': make_source('', s['name'])['key'], 'site': 'aggregator'})
            if s['img'] and not dry:
                item['thumb'] = save_thumb(s['img'])
            report['new'].append(f"{s['date']}  [{s['game']}] {s['name']}")
        item['sources'] = s['sources']
        out.append(item)
    for e in existing:
        if e['id'] in used:
            continue
        if e['date'] >= today.isoformat():
            report['missing'].append(f"{e['date']}  [{e['game']}] {e['name']}")
        out.append(dict(e, sources=[]))
    out = apply_overrides(out, overrides)
    out.sort(key=lambda r: (r['date'], r['game'], r['name']))
    for i in out:
        if not i.get('thumb'):
            report['noimage'].append(f"{i['date']}  [{i['game']}] {i['name']}  ({i['id']})")
    return out


def yen_text(n):
    return f'{n:,}円' if n else ''


def apply_official(items, today, report, dry, log):
    """Read the official sites in scripts/official/sources.json and fold them into the merged items (official wins)."""
    sys.path.insert(0, OFFICIAL_DIR)
    import run as official  # noqa: E402
    from common import load_env  # noqa: E402
    load_env()
    if not (os.environ.get('TYPESAFE_API_KEY') and os.environ.get('OPENROUTER_API_KEY')):
        log.append('official: skipped (TYPESAFE_API_KEY / OPENROUTER_API_KEY not set in .env)')
        return items
    sources = json.load(open(os.path.join(OFFICIAL_DIR, 'sources.json')))
    since = today.isoformat()
    by_id = {x['id']: x for x in items}
    matched = set()
    covered = set()
    for key, src in sources.items():
        if key.startswith('_'):
            continue
        covered.add(src['game'])
        result = official.run_game(key, src, items, since, since, log, skip_ids=matched)
        supplies = 0
        for e in result['entries']:
            x = by_id.get(e.get('match'))
            if x:
                matched.add(x['id'])
                fold_official(x, e, report, dry)
                continue
            if e['kind'] not in ADD_KINDS:
                supplies += 1
                continue
            if not e['date'] or e['date'] < since:
                if e['date'] is None:
                    report['official_undated'].append(f"[{e['game']}] {e['name']} — {e.get('date_text') or '日付未定'}  {e.get('url') or e['source_page']}")
                continue
            new = new_from_official(e, dry)
            if new['id'] in by_id:
                continue
            look = [y for y in items if y['game'] == e['game'] and y['date'] == e['date'] and y['id'] not in matched
                    and official.sim(y['name'], e['name']) >= 0.3]
            flag = f"  ⚠️ 既存と似ています: {look[0]['name']}（重複なら overrides で hide）" if look else ''
            report['official_new'].append(f"{e['date']}  [{e['game']}] {e['name']}{(' ' + new['pack']) if new['pack'] else ''}{flag}")
            items.append(new)
            by_id[new['id']] = new
            matched.add(new['id'])
        if supplies:
            log.append(f'official {key}: {supplies} supplies/accessories not added')
    for x in items:
        if x['game'] in covered and x['date'] >= since and x['id'] not in matched:
            report['official_unconfirmed'].append(f"{x['date']}  [{x['game']}] {x['name']}")
    usage = official.LEDGER.rows
    log.append('official cost: ' + ', '.join(f"{p} {v['calls']} calls {v['prompt_tokens']}+{v['completion_tokens']} tok ${v['cost']:.4f}" for p, v in usage.items()))
    return items


def fold_official(x, e, report, dry):
    x['source'] = e['source']
    x['official_name'] = e['name']
    x['sources'] = sorted(set(x.get('sources') or []) | {'official'})
    if e['date'] and e['date'] != x['date']:
        report['moved'].append(f"{x['date']} → {e['date']}  [{x['game']}] {x['name']}（公式）")
        x['date'] = e['date']
    if e.get('pack_yen') and e['pack_yen'] != yen_int(x.get('pack')):
        if x.get('pack'):
            report['price'].append(f"[{x['game']}] {x['name']}  pack: {x.get('pack')} → {yen_text(e['pack_yen'])}（公式）")
        x['pack'] = yen_text(e['pack_yen'])
    if e.get('box_yen') and not x.get('box'):
        x['box'] = yen_text(e['box_yen'])
    if e.get('url') and is_official(e['url']) and not is_official(x.get('url') or ''):
        x['url'] = e['url']
    img = e.get('image') or ''
    if img and not PLACEHOLDER_IMG.search(img) and (not x.get('thumb') or x.get('approx')):
        try:
            if not dry:
                x['thumb'] = save_thumb(img)
            x['approx'] = False
            report['image'].append(f"[{x['game']}] {x['name']}（公式）")
        except Exception as ex:
            report['image'].append(f"[{x['game']}] {x['name']} 公式画像の取得に失敗: {ex}")


def new_from_official(e, dry):
    item = dict(id=item_id(e['game'], e['name']), date=e['date'], game=e['game'], name=e['name'],
                pack=yen_text(e.get('pack_yen')), box=yen_text(e.get('box_yen')),
                url=e['url'] if e.get('url') and is_official(e['url']) else '', thumb='', approx=False,
                sources=['official'], source=e['source'], official_name=e['name'])
    img = e.get('image') or ''
    if img and not PLACEHOLDER_IMG.search(img) and not dry:
        try:
            item['thumb'] = save_thumb(img)
        except Exception:
            pass
    return item


def yen_int(text):
    m = re.search(r'(\d[\d,]*)\s*円', text or '')
    return int(m.group(1).replace(',', '')) if m else None


def write_report(path, report, counts, unknown, today, log=()):
    titles = [('new', '新規'), ('official_new', '公式サイトから追加'), ('moved', '発売日の変更'), ('price', '価格の変更'), ('image', '画像を取得/差し替え'),
              ('official_unconfirmed', '公式サイトで確認できなかった今後の商品（公式を設定済みのタイトルのみ）'),
              ('official_undated', '公式で発表済み・発売日未定（未掲載）'),
              ('missing', 'ソースから消えた今後の商品（残しています。不要なら overrides で hide）'),
              ('dropped', f'発売から{KEEP_PAST_DAYS}日を過ぎて削除'), ('noimage', '画像なし（プレースホルダー表示）')]
    lines = [f'# データ更新レポート {today}', '',
             f"- カードラボ {counts['clabo']}件 / トレカの地図 {counts['torecamap']}件 → 統合 {counts['combined']}件",
             f"- items.json: {counts['before']}件 → {counts['after']}件", '']
    if unknown:
        lines += ['## 未対応のタイトル名（GAME に追加してください）', ''] + [f'- {u}' for u in sorted(unknown)] + ['']
    for key, title in titles:
        rows = report[key]
        lines += [f'## {title}（{len(rows)}）', ''] + ([f'- {r}' for r in rows] or ['- なし']) + ['']
    if log:
        lines += ['## 公式サイト取得ログ', ''] + [f'- {x}' for x in log] + ['']
    open(path, 'w').write('\n'.join(lines))


def main():
    dry = '--dry-run' in sys.argv
    today = datetime.date.fromisoformat(os.environ['TODAY']) if os.environ.get('TODAY') else datetime.date.today()
    unknown = set()
    clabo = parse_clabo(today, unknown)
    tm = parse_torecamap(today, unknown)
    if not clabo or not tm:
        sys.exit(f'abort: empty source (カードラボ {len(clabo)} / トレカの地図 {len(tm)}) — nothing written')
    existing = json.load(open(os.path.join(DATA, 'items.json')))
    upcoming_before = sum(1 for e in existing if e['date'] >= today.replace(day=1).isoformat())
    scraped = combine(clabo, tm)
    if len(scraped) < MIN_RATIO * upcoming_before:
        sys.exit(f'abort: only {len(scraped)} releases scraped vs {upcoming_before} known for this month onward — nothing written')
    overrides = json.load(open(os.path.join(DATA, 'overrides.json')))
    report = {k: [] for k in ('new', 'official_new', 'moved', 'price', 'image', 'official_unconfirmed', 'official_undated',
                              'missing', 'dropped', 'noimage')}
    items = merge(existing, scraped, overrides, today, report, dry)
    log = []
    if '--no-official' not in sys.argv:
        items = apply_official(items, today, report, dry, log)
        items = apply_overrides(items, overrides)
        items.sort(key=lambda r: (r['date'], r['game'], r['name']))
        report['noimage'] = [f"{i['date']}  [{i['game']}] {i['name']}  ({i['id']})" for i in items if not i.get('thumb')]
    counts = dict(clabo=len(clabo), torecamap=len(tm), combined=len(scraped), before=len(existing), after=len(items))
    report_path = os.path.join(DATA, 'update-report.md')
    write_report(report_path, report, counts, unknown, today, log)
    if not dry:
        json.dump(items, open(os.path.join(DATA, 'items.json'), 'w'), ensure_ascii=False, indent=1)
        json.dump({'updated': today.isoformat()}, open(os.path.join(DATA, 'meta.json'), 'w'), indent=2)
        referenced = {i['thumb'].split('/')[-1] for i in items if i.get('thumb')}
        for f in os.listdir(THUMBS):
            if f.endswith('.jpg') and f not in referenced:
                os.remove(os.path.join(THUMBS, f))
    print(open(report_path).read())
    print('(dry run: nothing written)' if dry else f'wrote data/items.json ({len(items)} items) and data/update-report.md')


if __name__ == '__main__':
    main()
