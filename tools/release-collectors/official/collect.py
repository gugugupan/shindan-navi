"""Official-site collector → data/releases/official/latest.json + _run.json (contracts/releases.md).

  .venv/bin/python -I tools/release-collectors/official/collect.py [--games pokemon,onepiece] [--today YYYY-MM-DD] [--root DIR]

Per sources.json key, in file order: fetch/extract → dedupe → split_editions → keep undated or >= today → classify
(Jev; NOT_A_PRODUCT dropped). No matching against items.json: that is the merge's job. Without TYPESAFE_API_KEY /
OPENROUTER_API_KEY it writes nothing and exits 0. Failed pages are recorded and the run is written as complete: false.
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import output  # noqa: E402
from official import common, run  # noqa: E402

SOURCE = 'official'
VERSION = '1'
SOURCES_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sources.json')
KINDS = tuple(k for k in run.KINDS if k != 'NOT_A_PRODUCT')


def load_sources(path=SOURCES_JSON):
    with open(path) as f:
        return {k: v for k, v in json.load(f).items() if not k.startswith('_')}


def has_keys():
    common.load_env()
    return bool(os.environ.get('TYPESAFE_API_KEY') and os.environ.get('OPENROUTER_API_KEY'))


def _yen(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else None


def _count(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 < v < 1000 else None


def _text(v):
    return v if isinstance(v, str) and v.strip() else None


def to_record(key, e):
    """One classified entry as a contract record; `source` uses redirects followed by this process (final_url)."""
    name = (e.get('name') or '').strip()
    return {'source_key': key, 'game': e['game'], 'name': name, 'date': e.get('date'), 'date_text': _text(e.get('date_text')),
            'source_page': e['source_page'], 'url': _text(e.get('url')), 'image': _text(e.get('image')),
            'pack_yen': _yen(e.get('pack_yen')), 'box_yen': _yen(e.get('box_yen')),
            'per_box': _count(e.get('per_box')), 'per_pack': _count(e.get('per_pack')), 'type': _text(e.get('type')),
            'tentative': bool(e.get('tentative')), 'editions': [x for x in e.get('editions') or [] if isinstance(x, str)],
            'kind': e['kind'], 'kind_p': float(e['kind_p']), 'via': e['via'],
            'source': run.make_source(common.final_url(e.get('url') or e['source_page']), e['name'], 'official')}


def collect(today, *, keys=None, sources=None, root=output.RELEASES):
    """Returns the written run dict, or None (nothing written) without API keys; raises output.Refused on zero records."""
    if not has_keys():
        return None
    sources = sources if sources is not None else load_sources()
    keys = keys or list(sources)
    unknown = [k for k in keys if k not in sources]
    if unknown:
        raise ValueError(f'unknown sources.json keys: {", ".join(unknown)}')
    records, pages, log = [], [], []
    for key in keys:
        src = sources[key]
        mine = []
        entries = run.read_pages(key, src, today, today, log, pages=mine)
        try:
            entries = run.classify(entries, src['full_name']) if entries else []
        except Exception as ex:
            log.append(f'{key} classify: FAILED {ex!r}')
            for p in mine:
                p['error'] = p['error'] or f'classify failed: {ex!r}'
            entries = []
        for e in entries:
            if e['kind'] not in KINDS:
                log.append(f"{key}: dropped 「{e['name']}」 with unexpected kind {e['kind']!r}")
                continue
            r = to_record(key, e)
            if r['name']:
                records.append(r)
        pages += mine
    usage = {p: dict(v) for p, v in common.LEDGER.rows.items()}
    return output.write_release_files(SOURCE, records, today=today, pages=pages, notes=log, usage=usage,
                                      collector_version=VERSION, root=root)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--games', help='comma-separated sources.json keys (default: all, in file order)')
    ap.add_argument('--today', default=output.today_iso(), help='date the run keeps releases from (default: TODAY env, else local date)')
    ap.add_argument('--root', default=output.RELEASES, help='output root (default: data/releases)')
    args = ap.parse_args(argv)
    try:
        datetime.date.fromisoformat(args.today)
    except ValueError:
        ap.error(f'--today must be YYYY-MM-DD, got {args.today!r}')
    try:
        result = collect(args.today, keys=args.games.split(',') if args.games else None, root=args.root)
    except ValueError as e:
        ap.error(str(e))
    except output.Refused as e:
        print(f'refused: {e}', file=sys.stderr)
        return 1
    if result is None:
        print(f'{SOURCE}: skipped (TYPESAFE_API_KEY / OPENROUTER_API_KEY not set in .env) — nothing written', file=sys.stderr)
        return 0
    print(f"{SOURCE}: {result['record_count']} records for {result['today']}"
          + ('' if result['complete'] else f" (incomplete: {len(result['errors'])} failed pages)")
          + f" → {os.path.join(args.root, SOURCE)}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
