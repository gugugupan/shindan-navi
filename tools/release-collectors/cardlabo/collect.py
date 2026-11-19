"""カードラボ collector → data/releases/cardlabo/latest.json + _run.json (contracts/releases.md).

  .venv/bin/python -I tools/release-collectors/cardlabo/collect.py [--today YYYY-MM-DD] [--root DIR]
"""
import argparse
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cardlabo import parse  # noqa: E402
from lib import common, output  # noqa: E402

SOURCE = 'cardlabo'
MARKERS = ('id="hatsubai_daily"', 'id="hatsubai_cate"')
VERSION = '1'


def collect(today, root=output.RELEASES, fetch=None):
    """Fetch, guard, parse and write; returns the run dict or raises output.Refused (nothing written)."""
    fetch = fetch or common.fetch
    page = {'key': SOURCE, 'game': None, 'url': parse.CLABO_URL, 'records': 0, 'error': None}
    try:
        body = fetch(parse.CLABO_URL)
        text = body.decode('utf-8')
    except Exception as e:
        raise output.Refused(f'{SOURCE}: fetch failed — nothing written: {parse.CLABO_URL}: {e!r}')
    missing = [m for m in MARKERS if m not in text]
    if missing:
        raise output.Refused(f'{SOURCE}: layout marker missing ({", ".join(missing)}) — nothing written')
    unknown = set()
    # parse_clabo fetches by itself; hand it the page already fetched so the guard and the parse see the same body
    saved, parse.fetch = parse.fetch, lambda url: body
    try:
        records = parse.parse_clabo(datetime.date.fromisoformat(today), unknown)
    finally:
        parse.fetch = saved
    page['records'] = len(records)
    return output.write_release_files(SOURCE, records, today=today, pages=[page], unknown_labels=unknown,
                                      collector_version=VERSION, root=root)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--today', default=output.today_iso(), help='date the run parses for (default: TODAY env, else local date)')
    ap.add_argument('--root', default=output.RELEASES, help='output root (default: data/releases)')
    args = ap.parse_args(argv)
    try:
        datetime.date.fromisoformat(args.today)
    except ValueError:
        ap.error(f'--today must be YYYY-MM-DD, got {args.today!r}')
    try:
        run = collect(args.today, root=args.root)
    except output.Refused as e:
        print(f'refused: {e}', file=sys.stderr)
        return 1
    print(f"{SOURCE}: {run['record_count']} records for {run['today']} → {os.path.join(args.root, SOURCE)}"
          + (f"; unknown labels: {', '.join(run['unknown_labels'])}" if run['unknown_labels'] else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
