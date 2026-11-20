"""Merge step of the release update (contracts/releases.md): the collectors' data/releases/ files plus
data/items.json and data/overrides.json → items.json, meta.json, update-report.md and public/thumbs/.

Normally run by scripts/refresh.py (collectors → this merge → build → verify, one TODAY). By hand: run the collectors
first with the same TODAY (tools/release-collectors/{cardlabo,torecamap,official}/collect.py). Nothing is written when
a required source is missing, stale, incomplete or looks broken.

  .venv/bin/python -I scripts/update_data.py              # merge + enrich, write data + report
  .venv/bin/python -I scripts/update_data.py --dry-run    # report only
  options: --no-official (skip the official files and enrich)  --no-enrich  --releases DIR  --data DIR  --thumbs DIR
  (--data other than data/ needs --thumbs unless --dry-run: the run prunes unreferenced thumbnails)

No network for カードラボ / トレカの地図. The official step may call Jev / the LLM to match; enrich (fill_box_info)
opens product pages with the LLM; thumbnails are downloaded unless --dry-run (to --thumbs DIR, default public/thumbs).
"""
import argparse
import datetime
import hashlib
import io
import json
import os
import re
import ssl
import sys
import time
import unicodedata
import urllib.error
import urllib.parse

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sourcekey import is_official, make_source, product_code, same_release  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools', 'release-collectors'))
from lib.common import fetch  # noqa: E402
from lib.output import RELEASES, Refused  # noqa: E402

# official-only entries of these kinds are added to the calendar; supplies are only counted
ADD_KINDS = {'BOOSTER_PACK', 'DECK', 'PRODUCT_SET_OR_BOX'}
PLACEHOLDER_IMG = re.compile(r'now[_-]?(printing|designing)|noimage|no[_-]image|dummy|comingsoon|coming[_-]soon', re.I)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
THUMBS = os.path.join(ROOT, 'public/thumbs')
KEEP_PAST_DAYS = 30
MIN_RATIO = 0.7
# fields the pages show (scripts/build.py `keep`); a change to any of them moves the item's `changed` date
SHOWN = ('date', 'game', 'name', 'pack', 'box', 'per_box', 'per_pack', 'url', 'thumb', 'approx')


def norm(name):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', name)).lower()


def sim(a, b):
    a, b = norm(a), norm(b)
    A = {a[i:i + 2] for i in range(len(a) - 1)}
    B = {b[i:i + 2] for i in range(len(b) - 1)}
    return len(A & B) / max(1, len(A | B))


def item_id(game, name):
    return 'i' + hashlib.sha1(f'{game}|{norm(name)}'.encode()).hexdigest()[:10]


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


NEW_THUMBS = []  # files save_thumb created this run; removed again if the run dies before items.json is written


def save_thumb(url):
    if not re.match(r'https?://', url or ''):
        raise ValueError(f'not an http(s) URL: {url!r}')
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
        part = path + '.part'
        try:
            im.save(part, 'JPEG', quality=78)
            os.replace(part, path)
        finally:
            if os.path.exists(part):
                os.remove(part)
        NEW_THUMBS.append(path)
    return 'thumbs/' + name


def try_thumb(url, dry):
    """(thumb path, None) or (None, why not). A dry run only checks the URL; nothing is fetched."""
    try:
        if dry:
            if not re.match(r'https?://', url):
                raise ValueError(f'not an http(s) URL: {url!r}')
            return '', None
        return save_thumb(url), None
    except Exception as ex:  # noqa: BLE001 — one bad image must not stop the update
        return None, f'{type(ex).__name__}: {ex}'


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


def merge(existing, scraped, overrides, today, report, dry, checked=frozenset()):
    """checked: titles the official step checks this run (official_checked). For every other title what the last
    official run gave an item ("official" in sources) is kept: not checked is not gone."""
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
                    if e.get(k) and not (yen_int(s[k]) and yen_int(s[k]) == yen_int(e.get(k))):
                        report['price'].append(f"[{s['game']}] {s['name']}  {k}: {e.get(k)} → {s[k]}")
                    item[k] = s[k]
            # the official name wins over the aggregator's, whether or not the official step runs
            official_name = 'official' in (e.get('sources') or []) and e['name'] == e.get('official_name')
            item.update(date=s['date'], name=e['name'] if official_name else s['name'], game=s['game'])
            if not item.get('url') and s['url']:
                item['url'] = s['url']
            if (item.get('source') or {}).get('site') != 'official' and s['url'] and is_official(s['url']):
                item['source'] = make_source(s['url'], s['name'], 'official')
            if s['img'] and (not item.get('thumb') or item.get('approx')):
                thumb, err = try_thumb(s['img'], dry)
                if err:
                    report['image'].append(f"[{s['game']}] {s['name']} 画像の取得に失敗: {err}")
                else:
                    if thumb:
                        item['thumb'] = thumb
                    item['approx'] = False
                    report['image'].append(f"[{s['game']}] {s['name']}")
        else:
            item = dict(id=sid, date=s['date'], game=s['game'], name=s['name'], pack=s['pack'], box=s['box'],
                        url=s['url'], thumb='', approx=False,
                        source=make_source(s['url'], s['name']) if s['url'] and is_official(s['url']) else
                        {'url': '', 'key': make_source('', s['name'])['key'], 'site': 'aggregator'})
            if s['img']:
                thumb, err = try_thumb(s['img'], dry)
                if err:
                    report['image'].append(f"[{s['game']}] {s['name']} 画像の取得に失敗: {err}")
                elif thumb:
                    item['thumb'] = thumb
            report['new'].append(f"{s['date']}  [{s['game']}] {s['name']}")
        item['sources'] = s['sources']
        if e is not None and e['game'] not in checked and 'official' in (e.get('sources') or []):
            item['sources'] = sorted(set(s['sources']) | {'official'})
        out.append(item)
    for e in existing:
        if e['id'] in used:
            continue
        if e['date'] >= today.isoformat():
            report['missing'].append(f"{e['date']}  [{e['game']}] {e['name']}")
        out.append(dict(e, sources=['official'] if e['game'] not in checked and 'official' in (e.get('sources') or []) else []))
    out = apply_overrides(out, overrides)
    out.sort(key=lambda r: (r['date'], r['game'], r['name']))
    for i in out:
        if not i.get('thumb'):
            report['noimage'].append(f"{i['date']}  [{i['game']}] {i['name']}  ({i['id']})")
    return out


def shown(x):
    """What the item's pages show; prices by yen amount, so a change in writing only (6688円 / 6,688円) is no change."""
    return tuple(yen_int(x.get(k)) or (x.get(k) or '') if k in ('pack', 'box') else x.get(k) or '' for k in SHOWN)


def stamp_changed(items, existing, today, prev_updated):
    """`changed` (contracts/releases.md): TODAY for new items and items whose shown fields differ from the run's
    starting items.json, else kept. Items from before the field existed take the previous run's date (meta.json
    `updated`, what the sitemap gave them until then) instead of a guess."""
    old = {x['id']: x for x in existing}
    for x in items:
        e = old.get(x['id'])
        if e is None or shown(e) != shown(x):
            x['changed'] = today
        else:
            x['changed'] = e.get('changed') or prev_updated or today


def today_iso():
    return os.environ.get('TODAY') or datetime.date.today().isoformat()


def yen_text(n):
    return f'{n:,}円' if n else ''


def has_official_keys():
    from official.common import load_env
    load_env()
    return bool(os.environ.get('TYPESAFE_API_KEY') and os.environ.get('OPENROUTER_API_KEY'))


def official_checked(run):
    """Titles the official run checked: in its scope (`games`) and every page of the title read without error."""
    pages = {}
    for p in run.get('pages') or []:
        if p.get('game'):
            pages.setdefault(p['game'], []).append(p)
    return {g for g in run.get('games') or [] if pages.get(g) and all(p.get('error') is None for p in pages[g])}


def apply_official(items, today, report, dry, log, records, run):
    """Fold the official collector's records (data/releases/official) into the merged items (official wins).
    Matching (identity first, then Jev / LLM) happens here because it needs items.json; each record keeps the
    `source` the collector computed."""
    from official import run as official
    log.extend(run['notes'])
    since = today.isoformat()
    by_id = {x['id']: x for x in items}
    matched = set()
    covered = official_checked(run)
    groups = {}
    for r in records:
        groups.setdefault(r['source_key'], []).append(dict(r))
    for key, entries in groups.items():
        game = entries[0]['game']
        existing = [x for x in items if x['game'] == game and x['date'] >= since and x['id'] not in matched]
        official.match(entries, existing)
        result = {'entries': entries}
        supplies = 0
        for e in result['entries']:
            x = by_id.get(e.get('match'))
            if not x:
                # match() only sees upcoming items; an item already past its (aggregator) date can still be this product
                x = next((y for y in items if y['id'] not in matched and same_identity(y, e)), None)
                if x:
                    e['match'] = x['id']
                    log.append(f"official {key}: 「{e['name']}」 = 「{x['name']}」 ({x['date']}) by source identity")
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
            dup = next((y for y in items if y['game'] == e['game'] and y['date'] == e['date'] and same_product_name(y, e)), None)
            if dup:
                log.append(f"official {key}: skipped duplicate 「{e['name']}」 = 「{dup['name']}」")
                continue
            if any(o is not e and o['date'] == e['date'] and not o.get('match') and o['kind'] in ADD_KINDS
                   and plain(e['name']) != plain(o['name']) and plain(e['name']) in plain(o['name']) for o in result['entries']):
                continue  # a more specific listing of the same product (e.g. with its edition) is on the same page
            twin = next((y for y in items if same_identity(y, e)), None)
            if twin:
                log.append(f"official {key}: skipped 「{e['name']}」: same source as 「{twin['name']}」, matched by another listing")
                continue
            new = new_from_official(e, dry)
            if new['id'] in by_id:
                continue
            look = [y for y in items if y['game'] == e['game'] and y['date'] == e['date'] and y['id'] not in matched
                    and official.sim(y['name'], e['name']) >= 0.3]
            if look:
                # looks like an item we already list that the official run did not confirm: a person decides
                report['official_review'].append(f"{e['date']}  [{e['game']}] 公式「{e['name']}」 ≒ 既存「{look[0]['name']}」  {e.get('url') or e['source_page']}")
                continue
            report['official_new'].append(f"{e['date']}  [{e['game']}] {e['name']}{(' ' + new['pack']) if new['pack'] else ''}")
            items.append(new)
            by_id[new['id']] = new
            matched.add(new['id'])
        if supplies:
            log.append(f'official {key}: {supplies} supplies/accessories not added')
    for x in items:
        if x['game'] in covered and x['date'] >= since and x['id'] not in matched:
            report['official_unconfirmed'].append(f"{x['date']}  [{x['game']}] {x['name']}")
    for label, usage in (('collect', run.get('usage') or {}), ('match', official.LEDGER.rows)):
        log.append(f'official cost ({label}): ' + ', '.join(f"{p} {v['calls']} calls {v['prompt_tokens']}+{v['completion_tokens']} tok ${v['cost']:.4f}" for p, v in usage.items()))
    return items


def same_identity(item, entry):
    """Same release by source: page + key, or the official product code within the title (contracts/releases.md)."""
    if item['game'] != entry['game']:
        return False
    if same_release(item.get('source'), entry['source'], item['game'], entry['game']):
        return True
    code = product_code(entry['name'])
    return bool(code) and product_code(item['name']) == code


def plain(name):
    """Letters and digits only, for spotting the same product written two ways."""
    return re.sub(r'[^0-9a-z\u3040-\u30ff\u4e00-\u9fff]', '', unicodedata.normalize('NFKC', name or '').lower())


def same_product_name(item, entry):
    a, b = plain(item['name']), plain(entry['name'])
    code = product_code(entry['name'])
    if code and code == product_code(item['name']):
        return True
    if len(min(a, b, key=len)) >= 6 and (a in b or b in a):
        return True
    qa, qb = re.findall(r'「([^」]{2,})」', item['name']), re.findall(r'「([^」]{2,})」', entry['name'])
    return bool(qa and qb and plain(qa[0]) == plain(qb[0]))


def fold_official(x, e, report, dry):
    x['source'] = e['source']
    x['official_name'] = e['name']
    x['sources'] = sorted(set(x.get('sources') or []) | {'official'})
    if e['date'] and e['date'] != x['date']:
        gap = abs((datetime.date.fromisoformat(e['date']) - datetime.date.fromisoformat(x['date'])).days)
        if gap > 60 or (e['date'] < today_iso() <= x['date']) or (x['date'] < today_iso() <= e['date']):
            # official pages sometimes carry a stale or copied date; a big jump needs a person to look
            report['date_conflict'].append(f"[{x['game']}] {x['name']}  既存 {x['date']} / 公式 {e['date']}  {e.get('url') or e['source_page']}")
        else:
            report['moved'].append(f"{x['date']} → {e['date']}  [{x['game']}] {x['name']}（公式）")
            x['date'] = e['date']
    if e.get('pack_yen') and e['pack_yen'] != yen_int(x.get('pack')):
        if x.get('pack'):
            report['price'].append(f"[{x['game']}] {x['name']}  pack: {x.get('pack')} → {yen_text(e['pack_yen'])}（公式）")
        x['pack'] = yen_text(e['pack_yen'])
    if e.get('box_yen') and not x.get('box'):
        x['box'] = yen_text(e['box_yen'])
    for k in ('per_box', 'per_pack'):
        if e.get(k) and not x.get(k):
            x[k] = e[k]
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
    item.update({k: e[k] for k in ('per_box', 'per_pack') if e.get(k)})
    img = e.get('image') or ''
    if img and not PLACEHOLDER_IMG.search(img) and not dry:
        try:
            item['thumb'] = save_thumb(img)
        except Exception:
            pass
    return item


def sold_by_box(x, pack_yen=None):
    """Packs under 1,000円 are sold by the box; decks and sets are sold one by one."""
    price = yen_int(x.get('pack')) or pack_yen
    return price < 1000 if price else not re.search(r'デッキ|セット|deck|set', x['name'], re.I)


def needs_box_info(x):
    return not x.get('per_pack') or (sold_by_box(x) and not (x.get('box') and x.get('per_box')))


def product_page(x):
    if x.get('url') and is_official(x['url']):
        return x['url']
    src = x.get('source') or {}
    return src['url'] if src.get('site') == 'official' and src.get('url') else ''


def with_www(url):
    """The `www.` address of a canonical source URL (canonical_url drops `www.`; some official hosts only answer on it), or None."""
    p = urllib.parse.urlsplit(url or '')
    if not p.netloc or p.netloc.startswith('www.') or p.netloc.count('.') != 1:
        return None
    return urllib.parse.urlunsplit(p._replace(netloc='www.' + p.netloc))


def hostname_mismatch(ex):
    reason = getattr(ex, 'reason', ex)
    return isinstance(reason, ssl.SSLCertVerificationError) and 'match' in str(reason)


def fill_box_info(items, today, report, log):
    """Open each upcoming item's own official page for what the listings left out: box price, packs per box, cards per pack."""
    from official import run as official
    from official.collect import load_sources
    from official.common import load_env
    load_env()
    if not os.environ.get('OPENROUTER_API_KEY'):
        log.append('box info: skipped (OPENROUTER_API_KEY not set in .env)')
        return
    full_name = {v['game']: v['full_name'] for v in load_sources().values()}
    todo = [x for x in items if x['date'] >= today.isoformat() and needs_box_info(x) and product_page(x)]
    failed = 0
    for x in todo:
        got, page, waits = None, product_page(x), [10]
        while True:
            try:
                got = official.product_details(full_name.get(x['game'], x['game']), x.get('official_name') or x['name'], page)
                break
            except urllib.error.HTTPError as ex:
                err = ex
                if ex.code not in (429, 503) or not waits:
                    break
                time.sleep(waits.pop())
            except Exception as ex:
                err = ex
                if not (hostname_mismatch(ex) and with_www(page)):
                    break
                page = with_www(page)
        if got is None:
            failed += 1
            log.append(f"box info: {x['name']} {page} FAILED {err!r}")
            continue
        added = []
        if got['per_pack'] and not x.get('per_pack'):
            x['per_pack'] = got['per_pack']
            added.append(f"{got['per_pack']}枚入り")
        if not x.get('pack') and got['pack_yen']:
            x['pack'] = yen_text(got['pack_yen'])
            added.append(f"価格 {x['pack']}")
        if sold_by_box(x, got['pack_yen']):
            if got['per_box'] and not x.get('per_box'):
                x['per_box'] = got['per_box']
                added.append(f"{got['per_box']}パック入り")
            if not x.get('box') and got['box_yen']:
                x['box'] = yen_text(got['box_yen'])
                added.append(f"BOX {x['box']}")
            elif not x.get('box') and x.get('per_box') and yen_int(x.get('pack')):
                x['box'] = yen_text(yen_int(x['pack']) * x['per_box'])
                added.append(f"BOX {x['box']}（{yen_text(yen_int(x['pack']))}×{x['per_box']}）")
        if added:
            report['box'].append(f"{x['date']}  [{x['game']}] {x['name']}: {' / '.join(added)}")
    log.append(f'box info: {len(todo)} product pages read, {len(report["box"])} items filled, {failed} failed')


def yen_int(text):
    m = re.search(r'(\d[\d,]*)\s*円', text or '')
    return int(m.group(1).replace(',', '')) if m else None


def write_report(path, report, counts, unknown, today, log=()):
    titles = [('new', '新規'), ('official_new', '公式サイトから追加'),
              ('official_review', '公式にあるが既存と似ている（未追加・要確認：別商品なら手動で追加、同じなら対応不要）'), ('moved', '発売日の変更'),
              ('date_conflict', '公式と既存で発売日が大きく違う（未適用・要確認）'), ('price', '価格の変更'), ('box', 'BOX情報の追加'), ('image', '画像を取得/差し替え'),
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


def read_source(root, source):
    """(records, run) from data/releases/<source>/, or None when either file is missing."""
    d = os.path.join(root, source)
    paths = [os.path.join(d, f) for f in ('latest.json', '_run.json')]
    if not all(os.path.exists(p) for p in paths):
        return None
    try:
        records, run = (json.load(open(p)) for p in paths)
    except ValueError as e:
        raise Refused(f'{source}: unreadable release files in {d} ({e})')
    if run.get('record_count') != len(records):
        raise Refused(f"{source}: _run.json record_count {run.get('record_count')} != {len(records)} records in latest.json")
    return records, run


def load_required(root, source, today):
    """The guards of contracts/releases.md › Merge for カードラボ / トレカの地図; raises Refused."""
    got = read_source(root, source)
    if got is None:
        raise Refused(f'{source}: {os.path.join(root, source)}/latest.json + _run.json missing (run its collector first)')
    records, run = got
    if run.get('today') != today:
        raise Refused(f"{source}: stale run (today {run.get('today')}, merge TODAY {today}; rerun the collector)")
    if not run.get('complete'):
        raise Refused(f"{source}: incomplete run ({'; '.join(run.get('errors') or []) or 'complete: false'})")
    if not records:
        raise Refused(f'{source}: empty source')
    return records, run


def load_official(root, today):
    """(records, run, None) or (None, None, why it is skipped). Missing or stale is a skip, not a refusal."""
    got = read_source(root, 'official')
    if got is None:
        return None, None, f"official: skipped (no {os.path.join(root, 'official')} files; run the official collector)"
    records, run = got
    if run.get('today') != today:
        return None, None, f"official: skipped (stale run from {run.get('today')}, merge TODAY {today})"
    return records, run, None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--dry-run', action='store_true', help='write only the report (no items.json, meta.json, thumbs)')
    ap.add_argument('--no-official', action='store_true', help='skip the official files and enrich (aggregators only)')
    ap.add_argument('--no-enrich', action='store_true', help='skip fill_box_info')
    ap.add_argument('--releases', default=RELEASES, help='collector output root (default: data/releases)')
    ap.add_argument('--data', default=DATA, help='directory with items.json / overrides.json, where the outputs go (default: data)')
    ap.add_argument('--thumbs', help='thumbnail directory (default: public/thumbs; required with --data DIR unless --dry-run)')
    args = ap.parse_args(argv)
    if not args.thumbs and not args.dry_run and os.path.realpath(args.data) != os.path.realpath(DATA):
        # the run deletes every public/thumbs/*.jpg the other items.json does not reference
        ap.error('--data DIR needs --thumbs DIR (or --dry-run): refusing to download into and prune public/thumbs')
    global THUMBS
    if args.thumbs:
        THUMBS = args.thumbs
    dry, data = args.dry_run, args.data
    del NEW_THUMBS[:]
    try:
        return update(args, dry, data)
    except BaseException:
        for path in NEW_THUMBS:
            if os.path.exists(path):
                os.remove(path)
        raise


def update(args, dry, data):
    today = datetime.date.fromisoformat(os.environ['TODAY']) if os.environ.get('TODAY') else datetime.date.today()
    try:
        clabo, clabo_run = load_required(args.releases, 'cardlabo', today.isoformat())
        tm, tm_run = load_required(args.releases, 'torecamap', today.isoformat())
        official, official_run, official_skip = (None, None, None) if args.no_official else load_official(args.releases, today.isoformat())
    except Refused as e:
        sys.exit(f'abort: {e} — nothing written')
    unknown = set(clabo_run['unknown_labels']) | set(tm_run['unknown_labels'])
    existing = json.load(open(os.path.join(data, 'items.json')))
    upcoming_before = sum(1 for e in existing if e['date'] >= today.replace(day=1).isoformat())
    scraped = combine(clabo, tm)
    if len(scraped) < MIN_RATIO * upcoming_before:
        sys.exit(f'abort: only {len(scraped)} releases scraped vs {upcoming_before} known for this month onward — nothing written')
    overrides = json.load(open(os.path.join(data, 'overrides.json')))
    report = {k: [] for k in ('new', 'official_new', 'official_review', 'moved', 'date_conflict', 'price', 'box', 'image', 'official_unconfirmed', 'official_undated',
                              'missing', 'dropped', 'noimage')}
    if official is not None and not has_official_keys():
        official, official_skip = None, 'official: skipped (TYPESAFE_API_KEY / OPENROUTER_API_KEY not set in .env)'
    items = merge(existing, scraped, overrides, today, report, dry, checked=official_checked(official_run) if official else set())
    log = []
    if not args.no_official:
        if official is None:
            log.append(official_skip)
        else:
            items = apply_official(items, today, report, dry, log, official, official_run)
        if args.no_enrich:
            log.append('box info: skipped (--no-enrich)')
        else:
            fill_box_info(items, today, report, log)
        items = apply_overrides(items, overrides)
        items.sort(key=lambda r: (r['date'], r['game'], r['name']))
        report['noimage'] = [f"{i['date']}  [{i['game']}] {i['name']}  ({i['id']})" for i in items if not i.get('thumb')]
    counts = dict(clabo=clabo_run['record_count'], torecamap=tm_run['record_count'], combined=len(scraped), before=len(existing), after=len(items))
    report_path = os.path.join(data, 'update-report.md')
    write_report(report_path, report, counts, unknown, today, log)
    if not dry:
        meta_path = os.path.join(data, 'meta.json')
        prev_updated = json.load(open(meta_path)).get('updated') if os.path.exists(meta_path) else None
        stamp_changed(items, existing, today.isoformat(), prev_updated)
        tmp = os.path.join(data, 'items.json.part')
        with open(tmp, 'w') as f:
            json.dump(items, f, ensure_ascii=False, indent=1)
        os.replace(tmp, os.path.join(data, 'items.json'))
        del NEW_THUMBS[:]
        tmp = os.path.join(data, 'meta.json.part')
        with open(tmp, 'w') as f:
            json.dump({'updated': today.isoformat()}, f, indent=2)
        os.replace(tmp, os.path.join(data, 'meta.json'))
        referenced = {i['thumb'].split('/')[-1] for i in items if i.get('thumb')}
        for f in os.listdir(THUMBS):
            if f.endswith('.jpg') and f not in referenced:
                os.remove(os.path.join(THUMBS, f))
    print(open(report_path).read())
    print('(dry run: nothing written)' if dry else f'wrote {os.path.join(data, "items.json")} ({len(items)} items) and update-report.md')
    return items


if __name__ == '__main__':
    main()
