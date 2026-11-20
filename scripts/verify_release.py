"""Pre-merge checks: data diff against a base ref, a full build with a pinned date, and the built pages / JSON-LD.

.venv/bin/python -I scripts/verify_release.py [--base main] [--today YYYY-MM-DD] [--skip-build]
Exit code 1 if any FAIL. WARN lines are for the owner to review, not blockers.
"""
import argparse, collections, datetime, glob, hashlib, html.parser, json, os, re, subprocess, sys, unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
SITE = 'https://shindan-navi.app'
ALLOWED_TYPES = {'WebSite', 'BreadcrumbList', 'ItemList', 'ListItem'}
# sales claims a release calendar cannot back up
FORBIDDEN_KEYS = {'offers', 'aggregateRating', 'review', 'availability', 'price', 'priceCurrency',
                  'shippingDetails', 'hasMerchantReturnPolicy'}

fails, warns = [], []
def fail(msg): fails.append(msg)
def warn(msg): warns.append(msg)


def norm(name):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', name)).lower()


SHOWN = ('date', 'game', 'name', 'pack', 'box', 'per_box', 'per_pack', 'url', 'thumb', 'approx')  # = update_data.SHOWN


def yen(t):
    m = re.search(r'(\d[\d,]*)\s*円', t or '')
    return int(m[1].replace(',', '')) if m else None


def shown(x):
    return tuple(yen(x.get(k)) or (x.get(k) or '') if k in ('pack', 'box') else x.get(k) or '' for k in SHOWN)


def git_json(ref, path):
    out = subprocess.run(['git', '-C', ROOT, 'show', f'{ref}:{path}'], capture_output=True, text=True)
    if out.returncode:
        sys.exit(f'cannot read {path} at {ref}: {out.stderr.strip()}')
    return json.loads(out.stdout)


def check_data(base, today):
    head = json.load(open(os.path.join(ROOT, 'data/items.json')))
    ov = json.load(open(os.path.join(ROOT, 'data/overrides.json')))
    old = git_json(base, 'data/items.json')
    old_ov = git_json(base, 'data/overrides.json')

    ids = collections.Counter(i['id'] for i in head)
    for k, n in ids.items():
        if n > 1: fail(f'data: id {k} appears {n} times')
    a = {i['id']: i for i in old}
    b = {i['id']: i for i in head}

    old_by_name = {(i['game'], norm(i['name'])): i['id'] for i in old}
    for i in head:
        was = old_by_name.get((i['game'], norm(i['name'])))
        if was and was != i['id']:
            fail(f'data: id changed for {i["game"]} {i["name"]}: {was} -> {i["id"]}')
        if i['id'] not in a:
            want = 'i' + hashlib.sha1(f'{i["game"]}|{norm(i["name"])}'.encode()).hexdigest()[:10]
            if i['id'] != want: fail(f'data: new item {i["id"]} does not match item_id(game, name) {want}')

    for k, v in old_ov.items():
        if k not in ov: fail(f'overrides: entry {k} ({v.get("_name", "")}) was removed')
        elif ov[k] != v: warn(f'overrides: entry {k} ({v.get("_name", "")}) changed — review')
    for k in ov:
        if k not in old_ov: warn(f'overrides: new entry {k} ({ov[k].get("_name", "")})')

    visible = [i for i in head if not ov.get(i['id'], {}).get('hide')]
    for label, key in (('name', lambda i: (i['game'], norm(ov.get(i['id'], {}).get('name', i['name'])))),
                       ('source key', lambda i: (i['game'], (i.get('source') or {}).get('key')))):
        groups = collections.defaultdict(list)
        for i in visible:
            k = key(i)
            if k[1]: groups[k].append(i)
        for k, v in groups.items():
            if len(v) > 1:
                fail(f'data: duplicate {label} in {k[0]}: ' + ' / '.join(f'{x["id"]} {x["date"]} {x["name"]}' for x in v))

    added = [b[k] for k in b if k not in a]
    removed = [a[k] for k in a if k not in b]
    cutoff = (datetime.date.fromisoformat(today) - datetime.timedelta(days=30)).isoformat()
    for i in removed:
        if i['date'] >= cutoff:
            warn(f'data: removed item that is recent or upcoming — check it was cancelled: {i["date"]} {i["game"]} {i["name"]}')
    changed = []
    for k in set(a) & set(b):
        d = {f: (a[k].get(f), b[k].get(f)) for f in ('date', 'name', 'pack', 'box') if a[k].get(f) != b[k].get(f)}
        if d: changed.append((b[k], d))

    # `changed` (contracts/releases.md): a date no later than the data update; a merge run moves it for every new item
    # and every item whose shown fields changed
    meta = json.load(open(os.path.join(ROOT, 'data/meta.json')))
    old_meta = git_json(base, 'data/meta.json')
    stale = []
    for i in head:
        c = i.get('changed')
        if c is not None and not (isinstance(c, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', c) and c <= meta['updated']):
            fail(f'data: {i["id"]} changed {c!r} is not a date on or before meta.updated {meta["updated"]}')
        if (i['id'] not in a or shown(a[i['id']]) != shown(i)) and i.get('changed', meta['updated']) != meta['updated']:
            stale.append(i)
    for i in stale:
        msg = f'data: {i["id"]} {i["name"]} is new or changed but its changed date is {i.get("changed")}'
        if meta['updated'] != old_meta['updated']: fail(msg + f' (merge ran on {meta["updated"]})')
        else: warn(msg + ' (items.json edited without a merge run: its sitemap lastmod stays old)')

    print(f'## data vs {base}: {len(old)} -> {len(head)} items, +{len(added)} / -{len(removed)} / ~{len(changed)}')
    for i in sorted(added, key=lambda x: x['date']):
        print(f'  + {i["date"]} [{i["game"]}] {i["name"]} ({(i.get("source") or {}).get("site", "-")})')
    for i, d in sorted(changed, key=lambda x: x[0]['date']):
        print(f'  ~ {i["id"]} [{i["game"]}] {i["name"]}: ' + ', '.join(f'{f} {x!r} -> {y!r}' for f, (x, y) in d.items()))
    print(f'  - {len(removed)} removed ({sum(i["date"] < cutoff for i in removed)} released over 30 days ago)')
    return head, ov


class PageParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.ld, self.canonical = [], None
        self.list_names, self.list_dates, self.list_links = [], [], []
        self._stack, self._buf, self._in = [], [], None
        self._seo_depth = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self._stack.append(tag)
        if tag == 'script' and a.get('type') == 'application/ld+json': self._in, self._buf = 'ld', []
        elif tag == 'link' and a.get('rel') == 'canonical': self.canonical = a.get('href')
        elif tag == 'section' and 'seo' in (a.get('class') or '').split() and 'about' not in (a.get('class') or ''):
            self._seo_depth = len(self._stack)
        elif self._seo_depth and tag == 'time': self.list_dates.append(a.get('datetime'))
        elif self._seo_depth and tag == 'li': self._in, self._buf = 'li', []
        elif self._in == 'li' and tag == 'a' and (a.get('href') or '').startswith('/item/'): self.list_links.append(a['href'])
        elif self._in == 'li' and tag == 'a' and (a.get('class') == 'sg'): self._in = 'li-skip'
        elif self._in == 'li' and tag == 'span' and a.get('class') in ('sg', 'sp'): self._in = 'li-skip'
        if tag in ('link', 'meta', 'img', 'br', 'input'): self._stack.pop()

    def handle_endtag(self, tag):
        if self._in == 'ld' and tag == 'script': self.ld.append(''.join(self._buf)); self._in = None
        elif self._in == 'li-skip' and tag in ('a', 'span'): self._in = 'li'
        elif self._in == 'li' and tag == 'li': self.list_names.append(''.join(self._buf).strip()); self._in = None
        if self._stack and self._stack[-1] == tag:
            self._stack.pop()
            if self._seo_depth and len(self._stack) < self._seo_depth: self._seo_depth = None

    def handle_data(self, data):
        if self._in in ('ld', 'li'): self._buf.append(data)


def walk(node, path, out):
    if isinstance(node, dict):
        t = node.get('@type')
        bad = [x for x in (t if isinstance(t, list) else [t]) if x and x not in ALLOWED_TYPES]
        bad += [k for k in node if k in FORBIDDEN_KEYS]
        if bad:
            out.append(f'{path}: {", ".join(bad)}')
            return
        for k, v in node.items(): walk(v, f'{path}.{k}', out)
    elif isinstance(node, list):
        for i, v in enumerate(node): walk(v, f'{path}[{i}]', out)


# Tool pages (not release calendars) have no release list or breadcrumbs; /events/ needs the Worker API and is
# checked by api/scripts/preview-check.mjs.
TOOL_PAGES = {'/events/'}


def check_home(today, head, ov):
    """/ is the today page: indexable, and the releases it embeds cover build day -1 .. +14 exactly."""
    f = os.path.join(DIST, 'index.html')
    if not os.path.exists(f): fail('dist: /index.html missing'); return
    src = open(f).read()
    if re.search(r'<meta name="robots"[^>]*noindex', src): fail('/: noindex')
    if 'location.replace(' in src or 'http-equiv="refresh"' in src: fail('/: still forwards')
    m = re.search(r'const H = (\{.*?\});\n', src)
    if not m: fail('/: embedded HOME data missing'); return
    h = json.loads(m[1])
    t = datetime.date.fromisoformat(today)
    lo, hi = (t - datetime.timedelta(days=1)).isoformat(), (t + datetime.timedelta(days=14)).isoformat()
    if (h.get('from'), h.get('until')) != (lo, hi): fail(f'/: HOME window {h.get("from")}..{h.get("until")}, expected {lo}..{hi}')
    hidden = {k for k, v in ov.items() if v.get('hide')}
    want = {i['id'] for i in head if lo <= ov.get(i['id'], {}).get('date', i['date']) <= hi and i['id'] not in hidden}
    got = [i.get('id') for i in h.get('items', [])]
    if set(got) != want or len(got) != len(want):
        fail(f'/: HOME items ({len(got)}) != releases {lo}..{hi} ({len(want)}); missing {sorted(want - set(got))[:3]} extra {sorted(set(got) - want)[:3]}')
    if any(k not in h.get('counts', {}) for k in {i.get('game') for i in h.get('items', [])}): fail('/: HOME counts lack a title')
    events = os.path.exists(os.path.join(DIST, 'events/index.html'))
    if events != ('id="evBody"' in src): fail(f'/: event block {"missing" if events else "present without /events/"}')
    # no static release list or about block (owner decision 2026-11-19): the h1 heads the page, the old name stays findable
    if 'class="seo' in src: fail('/: static release list / about block is back')
    h1 = re.findall(r'<h1 class="hbar"><b id="hDate"></b><span>([^<]+)</span></h1>', src)
    if len(h1) != 1 or len(re.findall(r'<h1[ >]', src)) != 1: fail(f'/: expected one h1 with the page heading, got {h1}')
    desc = re.search(r'<meta name="description" content="([^"]+)"', src)
    if not desc or '旧・新弾ナビ' not in desc[1]: fail('/: meta description lacks 旧・新弾ナビ')
    if '<small>（旧・新弾ナビ）</small>' not in src: fail('/: footer brand lacks （旧・新弾ナビ）')
    site = [json.loads(x) for x in re.findall(r'<script type="application/ld\+json">(.*?)</script>', src)]
    if [(x.get('@type'), x.get('name'), x.get('alternateName')) for x in site] != [('WebSite', 'トレカカレンダー', '新弾ナビ')]:
        fail(f'/: JSON-LD should be only WebSite トレカカレンダー / 新弾ナビ, got {[x.get("@type") for x in site]}')
    # the location picker is one shared partial (src/locpick.html) on / and /events/
    for f2, want in ((src, events), (open(os.path.join(DIST, 'events/index.html')).read() if events else '', events)):
        if (f2.count('<dialog id="prefDlg"'), f2.count('window.snLoc=')) != ((1, 1) if want else (0, 0)): fail('location picker missing or duplicated on / or /events/')
    # いま話題: with VOICES_ENABLED=1 the latest real snapshot's topics, only the fields the block shows
    von = os.environ.get('VOICES_ENABLED', '') == '1'
    real = sorted((json.load(open(x)) for x in glob.glob(os.path.join(ROOT, 'data/voices/*.json'))), key=lambda x: x['date'])
    real = [x for x in real if not x.get('sample')] if von else []
    hv = h.get('voices')
    if ('id="vtr"' in src) != von: fail(f'/: いま話題 block {"missing" if von else "present while VOICES is off"}')
    if not von or not real:
        if hv: fail('/: HOME voices data embedded without a real snapshot / VOICES_ENABLED')
    elif not hv: fail('/: HOME voices data missing')
    else:
        last = real[-1]
        if hv.get('date') != last['date']: fail(f'/: HOME voices date {hv.get("date")} != latest snapshot {last["date"]}')
        if [t.get('id') for t in hv.get('topics', [])] != [t['id'] for t in last['topics']]: fail('/: HOME voices topics differ from the latest snapshot')
        keys = {'id', 'game', 'title', 'summary', 'attitude', 'volume', 'first_seen'}
        if any(set(t) != keys for t in hv.get('topics', [])): fail('/: HOME voices topics carry other fields than the block needs')
        if {g.get('code') for g in hv.get('games', [])} != {t['game'] for t in last['topics']}: fail('/: HOME voices games differ from the topics\' games')
    print(f'  {"/":<12} home window {lo}..{hi} items={len(got)} events={events} voices={len(hv["topics"]) if hv else 0}')


def check_voices():
    """/voices/ (contracts/voices.md) exists only with VOICES_ENABLED=1: then it embeds every snapshot in data/voices/
    (samples only while no real one exists), is noindex and out of the sitemap while sample-only, and every page's tool
    tabs link it. Off, nothing may mention it."""
    import glob
    on = os.environ.get('VOICES_ENABLED', '') == '1'
    f = os.path.join(DIST, 'voices/index.html')
    pages = glob.glob(os.path.join(DIST, '**/*.html'), recursive=True)
    sitemap = open(os.path.join(DIST, 'sitemap.xml')).read()
    privacy = open(os.path.join(DIST, 'privacy/index.html')).read()
    if not on:
        if os.path.exists(f): fail('/voices/ built without VOICES_ENABLED=1')
        for x in pages:
            if 'href="/voices/' in open(x).read(): fail(f'{os.path.relpath(x, DIST)}: links /voices/ while it is off')
        if '/voices/' in sitemap: fail('sitemap: /voices/ listed while it is off')
        if 'tcg.voices' in privacy or '話題カレンダー' in privacy: fail('/privacy/: voices section while it is off')
        print('  /voices/     off')
        return
    if not os.path.exists(f): fail('/voices/ missing with VOICES_ENABLED=1'); return
    src = open(f).read()
    snaps = []
    for x in sorted(glob.glob(os.path.join(ROOT, 'data/voices/*.json'))):
        d = json.load(open(x))
        snaps.append({'date': d['date'], 'sample': bool(d.get('sample')), 'ids': [t['id'] for t in d['topics']]})
    if any(not x['sample'] for x in snaps): snaps = [x for x in snaps if not x['sample']]
    m = re.search(r'const V = (\{.*?\});\n', src)
    if not m: fail('/voices/: embedded data missing'); return
    v = json.loads(m[1])
    got = [{'date': x['date'], 'sample': x['sample'], 'ids': [t['id'] for t in x['topics']]} for x in v['snapshots']]
    if got != snaps: fail(f'/voices/: embedded snapshots {[x["date"] for x in got]} != data/voices {[x["date"] for x in snaps]}')
    sample_only = not snaps or all(x['sample'] for x in snaps)
    noindex = bool(re.search(r'<meta name="robots" content="noindex">', src))
    listed = f'<loc>{SITE}/voices/</loc>' in sitemap
    if noindex != sample_only or listed == sample_only:
        fail(f'/voices/: sample_only={sample_only} but noindex={noindex} sitemap={listed}')
    pp = PageParser(); pp.feed(src)
    if pp.canonical != SITE + '/voices/': fail(f'/voices/: canonical {pp.canonical}')
    if len(re.findall(r'<h1[ >]', src)) != 1: fail('/voices/: expected one h1')
    og = re.search(r'<meta property="og:image" content="([^"]+)"', src)
    ogf = og and os.path.join(DIST, og[1].replace(SITE + '/', '', 1))
    if not og or og[1] != SITE + '/og/voices.png' or not os.path.exists(ogf): fail(f'/voices/: og:image {og and og[1]} missing')
    elif open(ogf, 'rb').read(24)[16:24] != (1200).to_bytes(4, 'big') + (630).to_bytes(4, 'big'): fail('/voices/: og image is not 1200x630')
    # topic text lives in the embedded data (rendered by the page); the static HTML has only the latest real snapshot's
    # titles in the list below the calendar (owner decision 2026-11-20), linking its archive page
    static = src.replace(m[0], '') if m else src
    vl = re.search(r'<section class="vlatest".*?</section>', static, re.S)
    rest = static.replace(vl[0], '') if vl else static
    leaked = [t[k] for x in v['snapshots'] for t in x['topics'] for k in ('title', 'summary') if html.escape(t[k]) in rest or t[k] in rest]
    leaked += [y for x in v['snapshots'] for t in x['topics'] for y in t['voices'] if html.escape(y) in static or y in static]
    if leaked: fail(f'/voices/: topic text in the static HTML outside the latest list: {leaked[:2]}')
    if sample_only:
        if vl: fail('/voices/: latest-topics list while only samples exist')
    elif not vl: fail('/voices/: latest-topics list missing')
    else:
        last = [x for x in v['snapshots'] if x['topics']][-1]
        order = [c for c in voice_games() if any(t['game'] == c for t in last['topics'])]
        want = [(f'/voices/{last["date"]}/#topic-{t["id"]}', t['title']) for c in order for t in last['topics'] if t['game'] == c]
        rows = [(h, html.unescape(re.sub(r'<span class="vlg"[^>]*>.*?</span>', '', a))) for h, a in re.findall(r'<li><a href="([^"]+)">(.*?)</a></li>', vl[0])]
        if rows != want: fail(f'/voices/: latest list {len(rows)} rows != latest snapshot {len(want)} topics in GAMES order')
        if f'<a href="/voices/{last["date"]}/">' not in vl[0]: fail('/voices/: latest list heading does not link the archive page')
    if not re.search(r'<nav class="tooltabs"[^>]*>(?:(?!</nav>).)*<a href="/voices/"[^>]*aria-current="true"', src, re.S):
        fail('/voices/: its tool tab is not current')
    for x in pages:
        t = open(x).read()
        if '<nav class="tooltabs"' in t and 'href="/voices/"' not in t: fail(f'{os.path.relpath(x, DIST)}: tool tabs lack /voices/')
    if 'tcg.voices' not in privacy or '話題カレンダー' not in privacy: fail('/privacy/: voices section missing')
    for u in re.findall(r'https://x\.com/[^"\s]+', m[1]):
        if not re.fullmatch(r'https://x\.com/[A-Za-z0-9_]{1,15}/status/[0-9]{1,20}', u): fail(f'/voices/: odd post URL {u}')
    print(f'  /voices/     snapshots={len(got)} topics={sum(len(x["ids"]) for x in got)} sample_only={sample_only}')
    check_voice_days(sitemap)


def voice_games():
    src = open(os.path.join(ROOT, 'src/voices.html')).read()
    return re.findall(r"\{code:'([A-Z]+)'", src.split('const GAMES = [', 1)[1].split('];', 1)[0])


def check_voice_days(sitemap):
    """/voices/<date>/ (owner decision 2026-11-20): one indexable archive page per real snapshot and none for samples;
    the snapshot's topics in GAMES order with our own text only (no post text, no embeds), X links nofollow, canonical,
    BreadcrumbList as the only JSON-LD, prev/next between snapshots, in the sitemap dated by the snapshot."""
    files = sorted(glob.glob(os.path.join(ROOT, 'data/voices/*.json')))
    snaps = [json.load(open(x)) for x in files]
    real = sorted((x for x in snaps if not x.get('sample') and x['topics']), key=lambda x: x['date'])
    built = sorted(os.path.basename(os.path.dirname(x)) for x in glob.glob(os.path.join(DIST, 'voices/*/index.html')))
    if built != [x['date'] for x in real]: fail(f'/voices/<date>/: pages {built} != real snapshots with topics {[x["date"] for x in real]}')
    for loc in re.findall(re.escape(SITE) + r'/voices/(\d{4}-\d{2}-\d{2})/</loc>', sitemap):
        if loc not in built: fail(f'sitemap: /voices/{loc}/ listed without a page')
    for x in snaps:
        if x.get('sample') and os.path.exists(os.path.join(DIST, 'voices', x['date'])): fail(f'/voices/{x["date"]}/: archive page for a sample snapshot')
    games = voice_games()
    titles = collections.Counter()
    for f in glob.glob(os.path.join(DIST, '**/*.html'), recursive=True):
        t = re.search(r'<title>(.*?)</title>', open(f).read())
        if t: titles[t[1]] += 1
    for i, s in enumerate(real):
        d = s['date']; p = f'/voices/{d}/'; url = SITE + p
        f = os.path.join(DIST, 'voices', d, 'index.html')
        if not os.path.exists(f): continue
        src = open(f).read()
        pp = PageParser(); pp.feed(src)
        if pp.canonical != url: fail(f'{p}: canonical {pp.canonical}')
        if re.search(r'<meta name="robots"[^>]*noindex', src): fail(f'{p}: noindex')
        if f'<url><loc>{url}</loc><lastmod>{d}</lastmod></url>' not in sitemap: fail(f'sitemap: {p} missing or not dated {d}')
        title = re.search(r'<title>(.*?)</title>', src)
        if not title or titles[title[1]] != 1: fail(f'{p}: <title> missing or not unique: {title and title[1]}')
        desc = re.search(r'<meta name="description" content="([^"]+)"', src)
        if not desc or not any(html.escape(t['title']) in desc[1] for t in s['topics']): fail(f'{p}: description lacks a topic title')
        og = re.search(r'<meta property="og:image" content="([^"]+)"', src)
        if not og or og[1] != SITE + '/og/voices.png': fail(f'{p}: og:image {og and og[1]}')
        if len(re.findall(r'<h1[ >]', src)) != 1: fail(f'{p}: expected one h1')
        blocks = []
        for raw in pp.ld:
            try: blocks.append(json.loads(raw))
            except ValueError as e: fail(f'{p}: JSON-LD does not parse: {e}')
        bad = []
        for k, blk in enumerate(blocks): walk(blk, f'ld[{k}]', bad)
        if bad: fail(f'{p}: forbidden structured data {bad[0]}')
        if [b.get('@type') for b in blocks] != ['BreadcrumbList']: fail(f'{p}: JSON-LD should be one BreadcrumbList, got {[b.get("@type") for b in blocks]}')
        else:
            el = blocks[0]['itemListElement']
            if [e.get('position') for e in el] != list(range(1, len(el) + 1)) or [e.get('item') for e in el] != [SITE + '/', SITE + '/voices/', url]:
                fail(f'{p}: BreadcrumbList {[e.get("item") for e in el]}')
            crumbs = re.search(r'<nav class="crumbs"[^>]*>(.*?)</nav>', src, re.S)
            if not crumbs or [html.unescape(re.sub(r'<[^>]+>', '', c)).strip() for c in crumbs[1].split(' › ')] != [e.get('name') for e in el]:
                fail(f'{p}: visible breadcrumbs differ from the BreadcrumbList')
        # topics: every one of the snapshot, grouped by game in GAMES order, snapshot order inside a game
        want = [t['id'] for c in games for t in s['topics'] if t['game'] == c]
        got = re.findall(r'<article class="tc"[^>]* id="topic-([a-z0-9-]+)"', src)
        if got != want: fail(f'{p}: {len(got)} topic cards != {len(want)} in GAMES order')
        secs = re.findall(r'<section class="vgsec" id="g-([A-Z]+)"', src)
        if secs != [c for c in games if any(t['game'] == c for t in s['topics'])]: fail(f'{p}: game sections {secs}')
        # no post text: no quotes or embeds, every X link is one of the topic's posts / reacting_to, labelled by us
        if re.search(r'<blockquote|twitter-tweet|platform\.twitter\.com|publish\.twitter\.com|<iframe', src): fail(f'{p}: quote or X embed')
        allowed = {u for t in s['topics'] for u in t['posts'] + ([t['reacting_to']] if t['reacting_to'] else [])}
        for a, h, body in re.findall(r'(<a [^>]*href="(https://(?:x|twitter)\.com/[^"]*)"[^>]*>)(.*?)</a>', src):
            rel = (re.search(r'rel="([^"]*)"', a) or [None, ''])[1].split()
            if h not in allowed: fail(f'{p}: X link not from the data {h}'); break
            if not {'nofollow', 'noopener'} <= set(rel) or 'target="_blank"' not in a: fail(f'{p}: X link rel {rel}'); break
            if re.sub(r'<[^>]+>', '', body).strip() not in [str(n) for n in range(1, 4)] + ['反応元の公式投稿 ↗（外部サイト・X）']: fail(f'{p}: X link text {body[:40]!r}'); break
        for t in s['topics']:
            card = re.search(rf'<article class="tc"[^>]* id="topic-{t["id"]}".*?</article>', src, re.S)
            if not card: continue
            c = card[0]
            texts = [html.unescape(x) for x in re.findall(r'<li><span aria-hidden="true">💬 </span>(.*?)</li>', c)]
            if texts != t['voices']: fail(f'{p}: {t["id"]} voices differ from the data'); continue
            if html.escape(t['summary']) not in c or html.escape(t['title']) not in c: fail(f'{p}: {t["id"]} title / summary missing')
            if f'href="/voices/#t={t["id"]}"' not in c: fail(f'{p}: {t["id"]} lacks its /voices/#t= link')
            # the tag is what card() in src/voices.html emits: the shared game icon (gi), then the name
            tag = re.search(r'<span class="tag">(<img class="gi" src="/gi/[a-z0-9]+\.png" width="16" height="16" alt="" aria-hidden="true">|<span class="gi" aria-hidden="true">[^<]+</span>)([^<]+)</span>', c)
            if not tag: fail(f'{p}: {t["id"]} tag without the game icon')
            n = sum(t['share'].values())
            pct = [int(x) for x in re.findall(r'約(\d+)%', re.search(r'<span class="alg"[^>]*>(.*?)</span></div>', c, re.S)[1])] if 'class="alg"' in c else []
            if (n < 5) != ('data-small' in c) or (n < 5 and ('%' in c or 'class="abar"' in c)): fail(f'{p}: {t["id"]} small-sample rule (n={n})')
            if n >= 5 and sum(pct) != 100: fail(f'{p}: {t["id"]} shares add up to {sum(pct)}%')
            if n >= 5 and any(x % 10 for x in pct): fail(f'{p}: {t["id"]} shares not in 10% steps')
            if re.search(r'"(positive|negative|neutral)":\s*\d', c) or re.search(r'\b\d+\s*件の投稿', c): fail(f'{p}: {t["id"]} shows post counts')
        if f'href="/voices/#d={d}"' not in src: fail(f'{p}: no link to the day on /voices/')
        prev = real[i - 1]['date'] if i else None
        nxt = real[i + 1]['date'] if i + 1 < len(real) else None
        for rel, other in (('prev', prev), ('next', nxt)):
            has = re.findall(rf'<a (?:class="[^"]*" )?href="(/voices/[\d-]+/)" rel="{rel}">', src)
            if has != ([f'/voices/{other}/'] * 2 if other else []): fail(f'{p}: {rel} links {has}, expected {other}')
        if 'href="/voices/"' not in src: fail(f'{p}: no link back to /voices/')
        print(f'  {p:<22} topics={len(got)} games={len(secs)} prev={prev} next={nxt}')


def check_items(head, ov):
    """/item/<id>/: exactly one page per visible item (none for hidden ones), self-canonical, h1 = the shown name,
    a unique title, only BreadcrumbList JSON-LD ending at the page, internal links that resolve, in the sitemap."""
    visible = {i['id']: {**i, **{k: v for k, v in ov.get(i['id'], {}).items() if k in ('name', 'date', 'thumb')}}
               for i in head if not ov.get(i['id'], {}).get('hide')}
    built = {os.path.basename(os.path.dirname(f)) for f in glob.glob(os.path.join(DIST, 'item/*/index.html'))}
    for k in sorted(set(visible) - built): fail(f'/item/{k}/: missing ({visible[k]["name"]})')
    for k in sorted(built - set(visible)):
        fail(f'/item/{k}/: built for a {"hidden" if k in ov and ov[k].get("hide") else "unknown"} item')
    sitemap = open(os.path.join(DIST, 'sitemap.xml')).read()
    titles, n_links = {}, 0
    for k in sorted(built & set(visible)):
        it = visible[k]
        p = f'/item/{k}/'
        src = open(os.path.join(DIST, 'item', k, 'index.html')).read()
        pp = PageParser(); pp.feed(src)
        if pp.canonical != SITE + p: fail(f'{p}: canonical {pp.canonical}')
        if re.search(r'<meta name="robots"[^>]*noindex', src): fail(f'{p}: noindex')
        if f'<loc>{SITE}{p}</loc>' not in sitemap: fail(f'sitemap: {p} missing')
        h1 = re.findall(r'<h1(?:\s[^>]*)?>(.*?)</h1>', src, re.S)
        if len(h1) != 1 or html.unescape(re.sub(r'<[^>]+>', '', h1[0])) != it['name']:
            fail(f'{p}: h1 {h1} != {it["name"]!r}')
        title = html.unescape(re.search(r'<title>(.*?)</title>', src)[1])
        if it['name'] not in title or not re.search(r' 発売日・価格(｜トレカカレンダー)?$', title): fail(f'{p}: title {title!r}')
        titles.setdefault(title, []).append(k)
        if not re.search(r'<meta name="description" content="[^"]{20,}">', src): fail(f'{p}: meta description missing')
        if f'<time datetime="{it["date"]}">' not in src: fail(f'{p}: release date {it["date"]} not shown')
        if 'class="seo' in src: fail(f'{p}: has a calendar-page static list')
        blocks = []
        for raw in pp.ld:
            try: blocks.append(json.loads(raw))
            except ValueError as e: fail(f'{p}: JSON-LD does not parse: {e}')
        bad = []
        for i, blk in enumerate(blocks): walk(blk, f'ld[{i}]', bad)
        if bad: fail(f'{p}: forbidden structured data, e.g. {bad[0]}')
        if [b.get('@type') for b in blocks] != ['BreadcrumbList']: fail(f'{p}: JSON-LD should be only BreadcrumbList, got {[b.get("@type") for b in blocks]}')
        else:
            el = blocks[0].get('itemListElement', [])
            if [x.get('position') for x in el] != list(range(1, len(el) + 1)) or not el or el[0].get('item') != SITE + '/' \
                    or el[-1].get('item') != SITE + p or el[-1].get('name') != it['name']:
                fail(f'{p}: breadcrumbs should run from / to the page itself')
        og = re.search(r'<meta property="og:image" content="([^"]+)"', src)
        if not og or not os.path.exists(os.path.join(DIST, og[1].replace(SITE + '/', '', 1))): fail(f'{p}: og:image {og and og[1]} is not a built file')
        hrefs = set(re.findall(r'href="(/[^"#?]*)', src))
        for h in hrefs:
            if not os.path.exists(os.path.join(DIST, h.strip('/'), 'index.html') if h.endswith('/') else os.path.join(DIST, h.strip('/'))):
                fail(f'{p}: link {h} does not resolve')
        if f'href="/releases/#i={k}"' not in src: fail(f'{p}: no 新弾カレンダーで見る link')
        if f'href="/{it["date"][:7]}/"' not in src: fail(f'{p}: no month page link')
        n_links += sum(h.startswith('/item/') for h in hrefs)
    for t, ks in titles.items():
        if len(ks) > 1: fail(f'/item/: title {t!r} shared by {ks}')
    print(f'  /item/       pages={len(built)} visible={len(visible)} cross-links={n_links}')


def check_index(sitemap, today):
    """Search basics over every built page: the sitemap lists exactly the indexable pages (no noindex), each
    self-canonical with a trailing slash and og:url = canonical; <title>s unique (FAIL) and at most 60 characters (WARN);
    descriptions unique (WARN); robots.txt allows crawling and names the sitemap."""
    locs = re.findall(r'<loc>(.*?)</loc>', sitemap)
    if len(locs) != len(set(locs)): fail('sitemap: duplicate <loc>')
    titles, descs, long_items, indexable = collections.defaultdict(list), collections.defaultdict(list), [], set()
    for f in sorted(glob.glob(os.path.join(DIST, '**/index.html'), recursive=True)):
        rel = os.path.relpath(os.path.dirname(f), DIST)
        p = '/' if rel == '.' else f'/{rel}/'
        src = open(f).read()
        noindex = bool(re.search(r'<meta name="robots"[^>]*noindex', src))
        canon = re.search(r'<link rel="canonical" href="([^"]+)"', src)
        if not noindex:
            indexable.add(SITE + p)
            if not canon or canon[1] != SITE + p: fail(f'{p}: canonical {canon and canon[1]} != {SITE + p}')
            ogu = re.search(r'<meta property="og:url" content="([^"]+)"', src)
            if ogu and canon and ogu[1] != canon[1]: fail(f'{p}: og:url {ogu[1]} != canonical')
        t = re.search(r'<title>(.*?)</title>', src)
        if not t: fail(f'{p}: no <title>'); continue
        title = html.unescape(t[1])
        titles[title].append(p)
        if len(title) > 60:
            if p.startswith('/item/'): long_items.append((len(title), p))
            else: warn(f'{p}: <title> is {len(title)} characters (over 60): {title}')
        d = re.search(r'<meta name="description" content="([^"]*)"', src)
        if d and not noindex: descs[d[1]].append(p)
    for t, ps in titles.items():
        if len(ps) > 1: fail(f'<title> {t!r} shared by {ps[:4]}')
    for d, ps in descs.items():
        if len(ps) > 1: warn(f'meta description shared by {ps[:4]}')
    if long_items:
        warn(f'/item/: {len(long_items)} <title>s over 60 characters even without the game / brand (product names), longest {max(long_items)[0]}: {max(long_items)[1]}')
    if set(locs) != indexable:
        for x in sorted(indexable - set(locs)): fail(f'sitemap: indexable page {x} missing')
        for x in sorted(set(locs) - indexable): fail(f'sitemap: {x} is not an indexable built page')
    robots = open(os.path.join(DIST, 'robots.txt')).read()
    if f'Sitemap: {SITE}/sitemap.xml' not in robots or re.search(r'^Disallow:\s*/\s*$', robots, re.M): fail(f'robots.txt: {robots!r}')
    print(f'  index        sitemap={len(locs)} indexable={len(indexable)} titles={len(titles)} long item titles={len(long_items)}')


def check_dist(today, head, ov):
    meta = json.load(open(os.path.join(ROOT, 'data/meta.json')))
    pages = json.load(open(os.path.join(ROOT, 'scripts/.pages.json')))
    paths = [p['path'] for p in pages]
    titles = [p for p in paths if re.fullmatch(r'/[a-z]+/', p) and p not in TOOL_PAGES and p != '/releases/']
    months = [p for p in paths if re.fullmatch(r'/\d{4}-\d{2}/', p)]
    if '/releases/' not in paths: fail('dist: release calendar /releases/ missing')
    if '/' in paths: fail('dist: / is built as a release calendar page')
    check_home(today, head, ov)
    check_voices()
    check_items(head, ov)
    if len(titles) != 10: fail(f'dist: expected 10 title pages, got {len(titles)} {titles}')
    if not months: fail('dist: no month pages')

    hidden = [k for k, v in ov.items() if v.get('hide')]
    sitemap = open(os.path.join(DIST, 'sitemap.xml')).read()
    paths = ['/'] + paths
    for p in paths:
        if f'<loc>{SITE}{p}</loc>' not in sitemap: fail(f'sitemap: {p} missing')
    # lastmod: item pages their item's `changed` (meta.updated until the updater stamps one), calendar pages the newest
    # of their items', / meta.updated
    vis = [{**i, **{k: v for k, v in ov.get(i['id'], {}).items() if k in ('date',)}} for i in head if not ov.get(i['id'], {}).get('hide')]
    ch = lambda xs: max((x.get('changed') or meta['updated'] for x in xs), default=meta['updated'])
    want_lastmod = {f'{SITE}/item/{i["id"]}/': i.get('changed') or meta['updated'] for i in vis}
    for pg in pages:
        js = pg.get('js') or {}
        sel = [i for i in vis if (js.get('game') in (None, i['game'])) and i['date'].startswith(js.get('month', ''))]
        if pg['path'] != '/events/': want_lastmod[SITE + pg['path']] = ch(sel)
    check_index(sitemap, today)
    for loc, lm in re.findall(r'<loc>(.*?)</loc><lastmod>(.*?)</lastmod>', sitemap):
        if loc == SITE + '/privacy/':  # dated by the policy's effective date in build.py, not by the data
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', lm) or lm > today: fail(f'sitemap: /privacy/ lastmod {lm}')
        elif loc == SITE + '/voices/':  # dated by the newest real snapshot, not by the release data
            real = [json.load(open(x))['date'] for x in glob.glob(os.path.join(ROOT, 'data/voices/*.json')) if not json.load(open(x)).get('sample')]
            if lm != max(real, default=None): fail(f'sitemap: /voices/ lastmod {lm} != newest snapshot {max(real, default=None)}')
        elif re.fullmatch(re.escape(SITE) + r'/voices/\d{4}-\d{2}-\d{2}/', loc):  # archive pages: checked in check_voice_days
            pass
        elif lm != want_lastmod.get(loc, meta['updated']):
            fail(f'sitemap: {loc} lastmod {lm} != {want_lastmod.get(loc, meta["updated"])} ({"newest changed of its items" if loc in want_lastmod else "meta.updated"})')
        if lm > today: fail(f'sitemap: {loc} lastmod {lm} is after {today}')

    # /feedback/ exists only with FEEDBACK_ENABLED=1: then noindex, out of the sitemap and linked from every footer;
    # otherwise nothing may link to it.
    fb = os.path.join(DIST, 'feedback/index.html')
    has_fb = os.path.exists(fb)
    if has_fb:
        fsrc = open(fb).read()
        if '<meta name="robots" content="noindex">' not in fsrc: fail('/feedback/: noindex missing')
        if f'{SITE}/feedback/' in sitemap: fail('sitemap: /feedback/ must not be listed')
        if not re.search(r"const SITE_KEY=\"[0-9A-Za-z_-]{10,}\";", fsrc): fail('/feedback/: Turnstile site key missing')
    for f in [os.path.join(DIST, '404.html'), os.path.join(DIST, 'privacy/index.html')] + [os.path.join(DIST, p.strip('/'), 'index.html') for p in paths]:
        if not os.path.exists(f): continue
        linked = 'href="/feedback/' in open(f).read()
        if linked != has_fb: fail(f'{os.path.relpath(f, DIST)}: feedback link {"present without" if linked else "missing with"} /feedback/')

    for p in paths:
        f = os.path.join(DIST, p.strip('/'), 'index.html')
        if not os.path.exists(f): fail(f'{p}: index.html missing'); continue
        src = open(f).read()
        if has_fb and f'href="/feedback/?from={p}"' not in src: fail(f'{p}: footer feedback link without ?from={p}')
        pp = PageParser(); pp.feed(src)
        if pp.canonical != SITE + p: fail(f'{p}: canonical {pp.canonical}')
        for k in hidden:
            if f'"id": "{k}"' in src: fail(f'{p}: hidden item {k} is in page data')

        blocks = []
        for raw in pp.ld:
            try: blocks.append(json.loads(raw))
            except ValueError as e: fail(f'{p}: JSON-LD does not parse: {e}')
        bad = []
        for i, blk in enumerate(blocks): walk(blk, f'ld[{i}]', bad)
        if bad: fail(f'{p}: forbidden structured data in {len(bad)} objects, e.g. {bad[0]}')
        types = [blk.get('@type') for blk in blocks]
        if p == '/':
            if 'WebSite' not in types: fail('/: WebSite JSON-LD missing')
        elif p not in TOOL_PAGES:
            bc = [blk for blk in blocks if blk.get('@type') == 'BreadcrumbList']
            if not bc: fail(f'{p}: BreadcrumbList missing')
            elif bc[0]['itemListElement'][-1].get('item') != SITE + p: fail(f'{p}: last breadcrumb is not the page itself')
        # every static list entry links its own /item/<id>/ page
        if len(pp.list_links) != len(pp.list_names): fail(f'{p}: {len(pp.list_names)} static list entries but {len(pp.list_links)} item links')
        for h in pp.list_links:
            if not os.path.exists(os.path.join(DIST, h.strip('/'), 'index.html')): fail(f'{p}: static list links missing page {h}')
        lists = [blk for blk in blocks if blk.get('@type') == 'ItemList']
        if len(lists) > 1: fail(f'{p}: {len(lists)} ItemList blocks')
        if pp.list_names:
            if not lists: fail(f'{p}: visible list has {len(pp.list_names)} items but no ItemList')
            else:
                el = lists[0].get('itemListElement', [])
                names = [x.get('name') or (x.get('item') or {}).get('name') for x in el]
                if lists[0].get('numberOfItems') not in (None, len(el)): fail(f'{p}: numberOfItems {lists[0]["numberOfItems"]} != {len(el)} elements')
                if [x.get('position') for x in el] != list(range(1, len(el) + 1)): fail(f'{p}: ItemList positions are not 1..n')
                if any(not str(x.get('url', '')).startswith(SITE + '/item/') for x in el): fail(f'{p}: ItemList entries should point at /item/<id>/ pages')
                if names != pp.list_names:
                    miss = [n for n in pp.list_names if n not in names][:3]
                    extra = [n for n in names if n not in pp.list_names][:3]
                    fail(f'{p}: ItemList ({len(names)}) != visible list ({len(pp.list_names)}); missing {miss} extra {extra}')
        elif lists: fail(f'{p}: ItemList present but no visible list')

        lead = re.search(r'<div class="ptitle"><h1>.*?</h1><p>(.*?)</p>', src)
        lead = lead[1] if lead else ''
        none_upcoming = p in titles and '発売予定の新弾はありません' in lead
        if none_upcoming:
            if any(d >= today for d in pp.list_dates): fail(f'{p}: says nothing is upcoming but lists {max(pp.list_dates)}')
            if '次の発売は' in src: fail(f'{p}: says nothing is upcoming but still has 次の発売 text')
        elif p in ('/', '/releases/') or p in titles:
            past = [d for d in pp.list_dates if d < today]
            if past: fail(f'{p}: upcoming list shows past dates {sorted(set(past))[:3]}')
        if p in titles and not none_upcoming:
            m = re.search(r'次の発売は(\d+)/(\d+)', lead)
            if not m: fail(f'{p}: lead has neither 次の発売 nor 発売予定なし: {lead!r}')
            else:
                nxt = min(pp.list_dates) if pp.list_dates else None
                if not nxt or nxt < today or (int(nxt[5:7]), int(nxt[8:10])) != (int(m[1]), int(m[2])):
                    fail(f'{p}: 次の発売 {m[1]}/{m[2]} is not the first upcoming date ({nxt}, today {today})')
        print(f'  {p:<12} ld={",".join(t for t in types)} list={len(pp.list_names)}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='main')
    ap.add_argument('--today', default=datetime.date.today().isoformat())
    ap.add_argument('--skip-build', action='store_true')
    args = ap.parse_args()

    head, ov = check_data(args.base, args.today)
    if not args.skip_build:
        env = dict(os.environ, BUILD_TODAY=args.today)
        r = subprocess.run([sys.executable, '-I', os.path.join(ROOT, 'scripts/build.py')], env=env, capture_output=True, text=True)
        if r.returncode:
            fail(f'build failed: {r.stderr.strip()[-500:]}')
        else:
            print('## build:', r.stdout.strip().splitlines()[-1])
    if os.path.isdir(DIST):
        print(f'## dist (today {args.today})')
        check_dist(args.today, head, ov)
    else:
        fail('dist/ missing')

    for w in warns: print('WARN', w)
    for f in fails: print('FAIL', f)
    print('RESULT', 'FAIL' if fails else 'PASS', f'({len(fails)} fail, {len(warns)} warn)')
    sys.exit(1 if fails else 0)


main()
