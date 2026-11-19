"""トレカの地図 collector → data/releases/torecamap/latest.json + _run.json (contracts/releases.md).

  .venv/bin/python -I tools/release-collectors/torecamap/collect.py [--today YYYY-MM-DD] [--root DIR]
"""
import argparse
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import common, output  # noqa: E402
from torecamap import parse  # noqa: E402

MARKER = 'NewReleaseScheduleSection_days'
VERSION = '1'


def month_urls(today):
    y, m, urls = today.year, today.month, []
    for _ in range(parse.TORECAMAP_MONTHS):
        urls.append(parse.TORECAMAP_URL.format(y=y, m=m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return urls


def _parse_served(today, served):
    """parse_torecamap with fetch answered from `served` (url → bytes); unchanged parser, no network."""
    def fake(url):
        return served[url]
    saved, parse.fetch = parse.fetch, fake
    try:
        unknown = set()
        return parse.parse_torecamap(today, unknown), unknown
    finally:
        parse.fetch = saved


def collect(today, fetch=None):
    """Returns (records, pages, unknown); raises output.Refused when a page fails or lacks the layout marker."""
    fetch = fetch or common.fetch
    urls = month_urls(today)
    bodies, pages = {}, []
    for url in urls:
        error = None
        try:
            body = fetch(url)
            if MARKER not in body.decode('utf-8'):
                error = f'layout marker {MARKER} missing'
        except Exception as e:  # noqa: BLE001 — any failed fetch refuses the run
            error = f'{type(e).__name__}: {e}'
            body = b''
        bodies[url] = body
        pages.append({'key': 'torecamap', 'game': None, 'url': url, 'records': 0, 'error': error})
    errors = [f"{p['url']}: {p['error']}" for p in pages if p['error']]
    if errors:
        raise output.Refused('torecamap: failed pages — nothing written: ' + '; '.join(errors))
    records, unknown = _parse_served(today, bodies)
    # Per-page counts: the parser dedupes across months, so count what each page adds to the pages before it.
    prev = 0
    for i, p in enumerate(pages):
        served = {u: (bodies[u] if j <= i else b'') for j, u in enumerate(urls)}
        n = len(_parse_served(today, served)[0])
        p['records'], prev = n - prev, n
    return records, pages, unknown


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().split('\n')[0])
    ap.add_argument('--today', help='YYYY-MM-DD (default: TODAY env, else the local date)')
    ap.add_argument('--root', default=output.RELEASES, help='releases root (default: data/releases)')
    args = ap.parse_args(argv)
    today = args.today or output.today_iso()
    try:
        records, pages, unknown = collect(datetime.date.fromisoformat(today))
        run = output.write_release_files('torecamap', records, today=today, pages=pages, unknown_labels=unknown,
                                         collector_version=VERSION, root=args.root)
    except output.Refused as e:
        print(f'refused: {e}', file=sys.stderr)
        return 1
    print(f"torecamap: {run['record_count']} records from {len(pages)} pages for {today}"
          + (f"; unknown labels: {', '.join(run['unknown_labels'])}" if run['unknown_labels'] else '')
          + f" → {os.path.join(args.root, 'torecamap')}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
