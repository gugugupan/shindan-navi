"""Golden snapshot of the aggregator path of the release update (カードラボ + トレカの地図, no official).

  .venv/bin/python -I tools/release-collectors/golden.py capture [--today YYYY-MM-DD]   # fetch pages, write expected output
  .venv/bin/python -I tools/release-collectors/golden.py replay                         # rerun on the snapshot, compare

Everything goes to tools/release-collectors/.golden/ (git-ignored: full source pages, the repo is public):
raw/ pages by URL, input/ the items.json + overrides.json the run started from, expected/ items.json + report.md.
Replay runs the cardlabo and torecamap collectors with fetch answered from raw/ (an unknown URL fails, so nothing
reaches the network) into a temp releases root, then update_data.main() with --dry-run --no-official, TODAY pinned
and --data pointed at a temp copy of input/, so nothing under data/ is written.
"""
import contextlib
import datetime
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

sys.path.insert(0, HERE)
from cardlabo import collect as cardlabo_collect  # noqa: E402
from lib import common, output  # noqa: E402
from torecamap import collect as torecamap_collect  # noqa: E402


def _read(path, json=False):
    with open(path) as f:
        return __import__('json').load(f) if json else f.read()


def _load_updater():
    sys.path.insert(0, os.path.join(ROOT, 'scripts'))
    import update_data
    return update_data


def collect(today, root, fetch):
    """Both aggregator collectors for `today` (ISO) into `root`, pages from `fetch`."""
    cardlabo_collect.collect(today, root=root, fetch=fetch)
    records, pages, unknown = torecamap_collect.collect(datetime.date.fromisoformat(today), fetch=fetch)
    output.write_release_files('torecamap', records, today=today, pages=pages, unknown_labels=unknown,
                               collector_version=torecamap_collect.VERSION, root=root)


def capture(today):
    pages = {}

    def recording(url):
        body = common.fetch(url)
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
    tmp = tempfile.mkdtemp()
    try:
        collect(today, tmp, recording)
    finally:
        shutil.rmtree(tmp)
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
    """Replay collectors + merge on the snapshot; returns (items json text, stripped report)."""
    manifest = _read(MANIFEST, json=True)
    ud = _load_updater()

    def fake(url):
        if url not in manifest['pages']:
            raise RuntimeError(f'golden: no snapshot for {url}')
        with open(os.path.join(RAW, manifest['pages'][url]), 'rb') as f:
            return f.read()

    def no_network(url):
        raise RuntimeError(f'golden: merge tried to fetch {url}')

    tmp = tempfile.mkdtemp()
    data, releases = os.path.join(tmp, 'data'), os.path.join(tmp, 'releases')
    saved = (ud.THUMBS, ud.fetch, os.environ.get('TODAY'))
    try:
        os.makedirs(data)
        for f in ('items.json', 'overrides.json'):
            shutil.copy(os.path.join(INPUT, f), os.path.join(data, f))
        collect(manifest['today'], releases, fake)
        ud.THUMBS, ud.fetch = os.path.join(tmp, 'thumbs'), no_network
        os.environ['TODAY'] = manifest['today']
        with contextlib.redirect_stdout(io.StringIO()):
            items = ud.main(['--dry-run', '--no-official', '--releases', releases, '--data', data])
        report = _read(os.path.join(data, 'update-report.md'))
    finally:
        ud.THUMBS, ud.fetch = saved[:2]
        if saved[2] is None:
            os.environ.pop('TODAY', None)
        else:
            os.environ['TODAY'] = saved[2]
        shutil.rmtree(tmp)
    return json.dumps(items, ensure_ascii=False, indent=1), strip_report(report)


def replay():
    if not os.path.exists(MANIFEST):
        sys.exit('no golden snapshot (run capture first)')
    items, report = run()
    ok = items == _read(os.path.join(EXPECTED, 'items.json')) and report == _read(os.path.join(EXPECTED, 'report.md'))
    print(('identical' if ok else 'DIFFERENT') + f" ({len(json.loads(items))} items)")
    return ok


if __name__ == '__main__':
    if sys.argv[1:2] == ['capture']:
        capture(sys.argv[sys.argv.index('--today') + 1] if '--today' in sys.argv else output.today_iso())
    elif sys.argv[1:2] == ['replay']:
        sys.exit(0 if replay() else 1)
    else:
        sys.exit(__doc__)
