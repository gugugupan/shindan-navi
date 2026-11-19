"""  .venv/bin/python -I tools/release-collectors/lib/test_output.py"""
import datetime
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import cardlabo.parse  # noqa: E402
import torecamap.parse  # noqa: E402
from lib import output  # noqa: E402

CONTRACTS = os.path.join(output.ROOT, 'contracts')
FIXTURES = {'cardlabo': os.path.join(output.ROOT, 'tools/release-collectors/cardlabo/test/fixtures/hatsubai-trimmed.html'),
            'torecamap': os.path.join(output.ROOT, 'tools/release-collectors/torecamap/test/fixtures/release-schedule-trimmed.html')}


class WriteReleaseFiles(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)

    def parsed(self, source):
        mod = cardlabo.parse if source == 'cardlabo' else torecamap.parse
        fn = mod.parse_clabo if source == 'cardlabo' else mod.parse_torecamap

        def fake(url):
            with open(FIXTURES[source], 'rb') as f:
                return f.read()
        saved, mod.fetch = mod.fetch, fake
        try:
            unknown = set()
            return fn(datetime.date(2026, 11, 19), unknown), unknown
        finally:
            mod.fetch = saved

    def test_fields_match_the_schema(self):
        with open(os.path.join(CONTRACTS, 'release.schema.json')) as f:
            defs = json.load(f)['definitions']
        self.assertEqual(sorted(defs['aggregator']['required']), sorted(output.AGGREGATOR_FIELDS))
        self.assertEqual(sorted(defs['official']['required']), sorted(output.OFFICIAL_FIELDS))
        with open(os.path.join(CONTRACTS, 'release-run.schema.json')) as f:
            run_required = json.load(f)['required']
        records, _ = self.parsed('cardlabo')
        run = output.write_release_files('cardlabo', records, today='2026-11-19',
                                         pages=[{'key': 'cardlabo', 'game': None, 'url': 'u', 'records': len(records), 'error': None}],
                                         root=self.root)
        self.assertEqual(sorted(run), sorted(run_required))

    def test_writes_parser_output_in_order(self):
        for source in ('cardlabo', 'torecamap'):
            records, unknown = self.parsed(source)
            pages = [{'key': source, 'game': None, 'url': 'u', 'records': len(records), 'error': None}]
            output.write_release_files(source, records, today='2026-11-19', pages=pages, unknown_labels=unknown, root=self.root)
            with open(os.path.join(self.root, source, 'latest.json')) as f:
                self.assertEqual(json.load(f), records)
            with open(os.path.join(self.root, source, '_run.json')) as f:
                run = json.load(f)
            self.assertEqual((run['record_count'], run['complete'], run['today']), (len(records), True, '2026-11-19'))

    def test_refuses_and_keeps_previous_files(self):
        records, _ = self.parsed('cardlabo')
        ok = [{'key': 'cardlabo', 'game': None, 'url': 'u', 'records': len(records), 'error': None}]
        output.write_release_files('cardlabo', records, today='2026-11-19', pages=ok, root=self.root)
        before = sorted(os.listdir(os.path.join(self.root, 'cardlabo')))
        with self.assertRaises(output.Refused):
            output.write_release_files('cardlabo', [], today='2026-11-20', pages=ok, root=self.root)
        with self.assertRaises(output.Refused):
            output.write_release_files('cardlabo', [dict(records[0], extra=1)], today='2026-11-20', pages=ok, root=self.root)
        with self.assertRaises(output.Refused):
            output.write_release_files('cardlabo', records, today='2026-11-20', root=self.root,
                                       pages=[dict(ok[0], error='HTTP 503')])
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, 'cardlabo'))), before)
        with open(os.path.join(self.root, 'cardlabo', '_run.json')) as f:
            self.assertEqual(json.load(f)['today'], '2026-11-19')


if __name__ == '__main__':
    unittest.main()
