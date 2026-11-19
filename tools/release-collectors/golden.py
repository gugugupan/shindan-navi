"""Golden snapshot of the aggregator path of scripts/update_data.py (カードラボ + トレカの地図, no official).

  .venv/bin/python -I tools/release-collectors/golden.py capture [--today YYYY-MM-DD]   # fetch pages, write expected output
  .venv/bin/python -I tools/release-collectors/golden.py replay                         # rerun on the snapshot, compare

Everything goes to tools/release-collectors/.golden/ (git-ignored: full source pages, the repo is public):
raw/ pages by URL, input/ the items.json + overrides.json the run started from, expected/ items.json + report.md.
Replay runs update_data.main() with --dry-run --no-official, TODAY pinned, fetch answered from raw/ (an unknown URL
fails, so nothing reaches the network) and DATA pointed at a temp dir, so nothing under data/ is written.
"""
import contextlib
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
GOLDEN = os.path.join(HERE, '.golden')
RAW = os.path.join(GOLDEN, 'raw')
INPUT = os.path.join(GOLDEN, 'input')
EXPECTED = os.path.join(GOLDEN, 'expected')
MANIFEST = os.path.join(GOLDEN, 'manifest.json')


def _read(path, json=False):
    with open(path) as f:
        return __import__('json').load(f) if json else f.read()


def _load_updater():
    sys.path.insert(0, os.path.join(ROOT, 'scripts'))
    import update_data
    return update_data


def _patch_fetch(ud, fake):
    """Replace fetch wherever the updater (or a module it imported) bound it."""
    orig = ud.fetch
    for mod in list(sys.modules.values()):
        if getattr(mod, 'fetch', None) is orig:
            mod.fetch = fake


def capture(today):
    ud = _load_updater()
    real = ud.fetch
    pages = {}

    def recording(url):
        body = real(url)
        name = hashlib.sha1(url.encode()).hexdigest()[:16] + '.html'
        with open(os.path.join(RAW, name), 'wb') as f:
            f.write(body)
        pages[url] = name
        return body

    shutil.rmtree(GOLDEN, ignore_errors=True)
    for d in (RAW, INPUT, EXPECTED):
        os.makedirs(d)
    for f in ('items.json', 'overrides.json'):
        shutil.copy(os.path.join(ROOT, 'data', f), os.path.join(INPUT, f))
    _patch_fetch(ud, recording)
    import datetime
    day = datetime.date.fromisoformat(today)
    unknown = set()
    ud.parse_clabo(day, unknown)
    ud.parse_torecamap(day, unknown)
    with open(MANIFEST, 'w') as f:
        json.dump({'today': today, 'pages': pages}, f, ensure_ascii=False, indent=1)
    items, report = run()
    for name, text in (('items.json', items), ('report.md', report)):
        with open(os.path.join(EXPECTED, name), 'w') as f:
            f.write(text)
    print(f'captured {len(pages)} pages for {today} → {GOLDEN}')


def strip_report(text):
    """Drop the dated title and the 公式サイト取得ログ section (neither belongs to the aggregator merge)."""
    out, skip = [], False
    for line in text.split('\n'):
        if line.startswith('# データ更新レポート'):
            line = '# データ更新レポート <TODAY>'
        if line.startswith('## '):
            skip = line.startswith('## 公式サイト取得ログ')
        if not skip:
            out.append(line)
    return '\n'.join(out)


def run():
    """Replay update_data.main() on the snapshot; returns (items json text, stripped report)."""
    manifest = _read(MANIFEST, json=True)
    ud = _load_updater()

    def fake(url):
        if url not in manifest['pages']:
            raise RuntimeError(f'golden: no snapshot for {url}')
        with open(os.path.join(RAW, manifest['pages'][url]), 'rb') as f:
            return f.read()

    _patch_fetch(ud, fake)
    got = {}
    real_merge = ud.merge

    def merge(*a, **kw):
        got['items'] = real_merge(*a, **kw)
        return got['items']

    tmp = tempfile.mkdtemp()
    saved = (ud.DATA, ud.THUMBS, ud.merge, sys.argv, os.environ.get('TODAY'))
    try:
        for f in ('items.json', 'overrides.json'):
            shutil.copy(os.path.join(INPUT, f), os.path.join(tmp, f))
        ud.DATA, ud.THUMBS, ud.merge = tmp, os.path.join(tmp, 'thumbs'), merge
        sys.argv = ['update_data.py', '--dry-run', '--no-official']
        os.environ['TODAY'] = manifest['today']
        with contextlib.redirect_stdout(io.StringIO()):
            ud.main()
        report = _read(os.path.join(tmp, 'update-report.md'))
    finally:
        ud.DATA, ud.THUMBS, ud.merge, sys.argv = saved[:4]
        if saved[4] is None:
            os.environ.pop('TODAY', None)
        else:
            os.environ['TODAY'] = saved[4]
        shutil.rmtree(tmp)
    return json.dumps(got['items'], ensure_ascii=False, indent=1), strip_report(report)


def replay():
    if not os.path.exists(MANIFEST):
        sys.exit('no golden snapshot (run capture first)')
    items, report = run()
    ok = items == _read(os.path.join(EXPECTED, 'items.json')) and report == _read(os.path.join(EXPECTED, 'report.md'))
    print(('identical' if ok else 'DIFFERENT') + f" ({len(json.loads(items))} items)")
    return ok


if __name__ == '__main__':
    if sys.argv[1:2] == ['capture']:
        capture(sys.argv[sys.argv.index('--today') + 1] if '--today' in sys.argv else os.environ.get('TODAY') or __import__('datetime').date.today().isoformat())
    elif sys.argv[1:2] == ['replay']:
        sys.exit(0 if replay() else 1)
    else:
        sys.exit(__doc__)
