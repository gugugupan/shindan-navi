"""Writing data/releases/<source>/latest.json + _run.json (contracts/releases.md)."""
import datetime
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
RELEASES = os.path.join(ROOT, 'data', 'releases')
SOURCES = ('cardlabo', 'torecamap', 'official')
AGGREGATOR_FIELDS = ('date', 'game', 'name', 'pack', 'box', 'url', 'img', 'src')
OFFICIAL_FIELDS = ('source_key', 'game', 'name', 'date', 'date_text', 'source_page', 'url', 'image', 'pack_yen', 'box_yen',
                   'per_box', 'per_pack', 'type', 'tentative', 'editions', 'kind', 'kind_p', 'via', 'source')


class Refused(Exception):
    """The run must not replace the last accepted files; the collector exits non-zero."""


def today_iso():
    return os.environ.get('TODAY') or datetime.date.today().isoformat()


def write_release_files(source, records, *, today, pages, unknown_labels=(), notes=(), usage=None,
                        collector_version='1', root=RELEASES):
    """Validate and write one source's files; raises Refused (writing nothing) on an empty or incomplete run.

    Records are written in the order given: the merge depends on page order, so never sort them here."""
    if source not in SOURCES:
        raise ValueError(f'unknown source {source!r}')
    if not records:
        raise Refused(f'{source}: no records (page layout changed?) — nothing written')
    fields = OFFICIAL_FIELDS if source == 'official' else AGGREGATOR_FIELDS
    for i, r in enumerate(records):
        if tuple(sorted(r)) != tuple(sorted(fields)):
            raise Refused(f'{source}: record {i} has fields {sorted(r)}, expected {sorted(fields)} — nothing written')
    errors = [f"{p['url']}: {p['error']}" for p in pages if p.get('error')]
    if errors and source != 'official':
        raise Refused(f'{source}: failed pages — nothing written: ' + '; '.join(errors))
    run = {'source': source, 'today': today,
           'fetched_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'record_count': len(records), 'complete': not errors, 'errors': errors, 'pages': list(pages),
           'unknown_labels': sorted(unknown_labels), 'notes': list(notes), 'usage': usage,
           'collector_version': collector_version}
    out = os.path.join(root, source)
    os.makedirs(out, exist_ok=True)
    # latest.json first, _run.json last: a _run.json always describes the latest.json next to it
    for name, value in (('latest.json', [{k: r[k] for k in fields} for r in records]), ('_run.json', run)):
        tmp = os.path.join(out, name + '.tmp')
        with open(tmp, 'w') as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write('\n')
        os.replace(tmp, os.path.join(out, name))
    return run
