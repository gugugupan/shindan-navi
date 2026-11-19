"""Pre-merge checks: data diff against a base ref, a full build with a pinned date, and the built pages / JSON-LD.

.venv/bin/python -I scripts/verify_release.py [--base main] [--today YYYY-MM-DD] [--skip-build]
Exit code 1 if any FAIL. WARN lines are for the owner to review, not blockers.
"""
import argparse, collections, datetime, hashlib, html.parser, json, os, re, subprocess, sys, unicodedata

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
        self.list_names, self.list_dates = [], []
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
    print(f'  {"/":<12} home window {lo}..{hi} items={len(got)} events={events}')


def check_dist(today, head, ov):
    meta = json.load(open(os.path.join(ROOT, 'data/meta.json')))
    pages = json.load(open(os.path.join(ROOT, 'scripts/.pages.json')))
    paths = [p['path'] for p in pages]
    titles = [p for p in paths if re.fullmatch(r'/[a-z]+/', p) and p not in TOOL_PAGES and p != '/releases/']
    months = [p for p in paths if re.fullmatch(r'/\d{4}-\d{2}/', p)]
    if '/releases/' not in paths: fail('dist: release calendar /releases/ missing')
    if '/' in paths: fail('dist: / is built as a release calendar page')
    check_home(today, head, ov)
    if len(titles) != 10: fail(f'dist: expected 10 title pages, got {len(titles)} {titles}')
    if not months: fail('dist: no month pages')

    hidden = [k for k, v in ov.items() if v.get('hide')]
    sitemap = open(os.path.join(DIST, 'sitemap.xml')).read()
    paths = ['/'] + paths
    for p in paths:
        if f'<loc>{SITE}{p}</loc>' not in sitemap: fail(f'sitemap: {p} missing')
    for loc, lm in re.findall(r'<loc>(.*?)</loc><lastmod>(.*?)</lastmod>', sitemap):
        if loc == SITE + '/privacy/':  # dated by the policy's effective date in build.py, not by the data
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', lm) or lm > today: fail(f'sitemap: /privacy/ lastmod {lm}')
        elif lm != meta['updated']: fail(f'sitemap: {loc} lastmod {lm} != meta.updated {meta["updated"]}')

    for p in paths:
        f = os.path.join(DIST, p.strip('/'), 'index.html')
        if not os.path.exists(f): fail(f'{p}: index.html missing'); continue
        src = open(f).read()
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
        lists = [blk for blk in blocks if blk.get('@type') == 'ItemList']
        if len(lists) > 1: fail(f'{p}: {len(lists)} ItemList blocks')
        if pp.list_names:
            if not lists: fail(f'{p}: visible list has {len(pp.list_names)} items but no ItemList')
            else:
                el = lists[0].get('itemListElement', [])
                names = [x.get('name') or (x.get('item') or {}).get('name') for x in el]
                if lists[0].get('numberOfItems') not in (None, len(el)): fail(f'{p}: numberOfItems {lists[0]["numberOfItems"]} != {len(el)} elements')
                if [x.get('position') for x in el] != list(range(1, len(el) + 1)): fail(f'{p}: ItemList positions are not 1..n')
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
