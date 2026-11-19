"""  .venv/bin/python -I -m unittest discover -s tools/release-collectors/cardlabo/test   (or run this file directly)"""
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))
from cardlabo import collect, parse  # noqa: E402
from lib import common, output  # noqa: E402

with open(os.path.join(HERE, 'fixtures', 'hatsubai-trimmed.html'), 'rb') as f:
    FIXTURE = f.read()
with open(os.path.join(output.ROOT, 'contracts', 'release.schema.json')) as f:
    AGGREGATOR = json.load(f)['definitions']['aggregator']
with open(os.path.join(output.ROOT, 'contracts', 'release-run.schema.json')) as f:
    RUN = json.load(f)

EXPECTED = [
    ('2026-10-02', 'ヴァイスシュヴァルツ', 'WS ブースターパック anemoi', '440円'),
    ('2026-10-02', 'MTG', 'MTG リアリティ・フラクチャー プレイ・ブースター 日本語版', '627円'),
    ('2026-10-02', 'MTG', 'MTG リアリティ・フラクチャー プレイ・ブースター 英語版', '748円'),
    ('2026-12-26', 'バトルスピリッツ', 'バトルスピリッツ コラボスターター アイカツ！ スタンダードステージ！【26RSD12】', '1,980円'),
    ('2026-12-26', 'バトルスピリッツ', 'バトルスピリッツ コラボブースター アイカツ！ 新たなる煌めき【26RCB02】', '363円'),
]


def serving(body):
    def fetch(url):
        assert url == parse.CLABO_URL, url
        return body
    return fetch


class Collect(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        self.out = os.path.join(self.root, 'cardlabo')

    def load(self, name):
        with open(os.path.join(self.out, name)) as f:
            return json.load(f)

    def test_records_match_schema_in_page_order(self):
        run = collect.collect('2026-11-19', root=self.root, fetch=serving(FIXTURE))
        records = self.load('latest.json')
        self.assertEqual([(r['date'], r['game'], r['name'], r['pack']) for r in records], EXPECTED)
        for r in records:
            self.assertEqual(sorted(r), sorted(AGGREGATOR['required']))
            self.assertRegex(r['date'], AGGREGATOR['properties']['date'].get('pattern', r'^\d{4}-\d{2}-\d{2}$'))
            self.assertTrue(r['name'])
            self.assertEqual((r['box'], r['url'], r['img'], r['src']), ('', '', '', 'clabo'))
        self.assertEqual(sorted(self.load('_run.json')), sorted(RUN['required']))
        self.assertEqual(self.load('_run.json'), run)
        self.assertEqual((run['source'], run['today'], run['record_count'], run['complete'], run['errors'], run['unknown_labels']),
                         ('cardlabo', '2026-11-19', 5, True, [], []))
        self.assertEqual(run['pages'], [{'key': 'cardlabo', 'game': None, 'url': parse.CLABO_URL, 'records': 5, 'error': None}])
        self.assertEqual(parse.fetch, common.fetch)

    def test_same_records_as_parse_clabo(self):
        import datetime
        with mock.patch.object(parse, 'fetch', serving(FIXTURE)):
            expected = parse.parse_clabo(datetime.date(2026, 11, 19), set())
        collect.collect('2026-11-19', root=self.root, fetch=serving(FIXTURE))
        self.assertEqual(self.load('latest.json'), expected)

    def test_unknown_label_kept_and_listed(self):
        body = FIXTURE.replace('<td>MTG</td>'.encode(), '<td>新タイトル</td>'.encode(), 1)
        run = collect.collect('2026-11-19', root=self.root, fetch=serving(body))
        self.assertEqual(run['unknown_labels'], ['新タイトル'])
        self.assertEqual(self.load('latest.json')[1]['game'], '新タイトル')

    def snapshot(self):
        out = {}
        for n in os.listdir(self.out):
            with open(os.path.join(self.out, n), 'rb') as f:
                out[n] = f.read()
        return out

    def assertRefusedKeepsPrevious(self, body=None, fetch=None):
        collect.collect('2026-11-19', root=self.root, fetch=serving(FIXTURE))
        before = self.snapshot()
        with self.assertRaises(output.Refused):
            collect.collect('2026-11-20', root=self.root, fetch=fetch or serving(body))
        self.assertEqual(self.snapshot(), before)

    def test_missing_daily_marker(self):
        self.assertRefusedKeepsPrevious(FIXTURE.replace(b'id="hatsubai_daily"', b'id="other"'))

    def test_missing_cate_marker(self):
        self.assertRefusedKeepsPrevious(FIXTURE.replace(b'id="hatsubai_cate"', b'id="other"'))

    def test_no_records(self):
        text = FIXTURE.decode()
        a, b = text.index('id="hatsubai_daily"'), text.index('id="hatsubai_cate"')
        empty = text[:a] + re.sub(r'<h3>.*', '', text[a:b], flags=re.S) + '</div>\n<div ' + text[b:]
        self.assertRefusedKeepsPrevious(empty.encode())

    def test_fetch_failure(self):
        def boom(url):
            raise OSError('HTTP 503')
        self.assertRefusedKeepsPrevious(fetch=boom)

    def test_main_exit_codes(self):
        with mock.patch.object(common, 'fetch', serving(FIXTURE)), redirect_stdout(io.StringIO()):
            self.assertEqual(collect.main(['--today', '2026-11-19', '--root', self.root]), 0)
        self.assertEqual(self.load('_run.json')['today'], '2026-11-19')
        with mock.patch.object(common, 'fetch', serving(b'<html></html>')), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(collect.main(['--today', '2026-11-20', '--root', self.root]), 1)
        self.assertIn('layout marker missing', err.getvalue())
        self.assertEqual(self.load('_run.json')['today'], '2026-11-19')


if __name__ == '__main__':
    unittest.main()
