"""  .venv/bin/python -I tools/release-collectors/torecamap/test/test_collect.py"""
import contextlib
import datetime
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))
from lib import output  # noqa: E402
from torecamap import collect, parse  # noqa: E402

FIXTURE = os.path.join(HERE, 'fixtures', 'release-schedule-trimmed.html')
TODAY = datetime.date(2026, 11, 19)
with open(FIXTURE, 'rb') as f:
    PAGE = f.read()
with open(os.path.join(output.ROOT, 'contracts', 'release.schema.json')) as f:
    DEFS = json.load(f)['definitions']
AGGREGATOR = DEFS['aggregator']
with open(os.path.join(output.ROOT, 'contracts', 'release-run.schema.json')) as f:
    RUN = json.load(f)


def serve(pages):
    """fetch answering each month URL from `pages` (url → bytes or an exception to raise)."""
    def fake(url):
        body = pages[url]
        if isinstance(body, Exception):
            raise body
        return body
    return fake


def _contents(directory):
    out = {}
    for n in os.listdir(directory):
        with open(os.path.join(directory, n)) as f:
            out[n] = f.read()
    return out


class Collect(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        self.urls = collect.month_urls(TODAY)
        saved = collect.common.fetch
        self.addCleanup(setattr, collect.common, 'fetch', saved)

    def run_main(self, pages):
        collect.common.fetch = serve(pages)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            code = collect.main(['--today', TODAY.isoformat(), '--root', self.root])
        return code, err.getvalue()

    def written(self):
        out = os.path.join(self.root, 'torecamap')
        if not os.path.isdir(out):
            return None
        return sorted(os.listdir(out))

    def test_month_urls(self):
        self.assertEqual(len(self.urls), parse.TORECAMAP_MONTHS)
        self.assertEqual(self.urls[0], 'https://torecamap.co.jp/release-schedule?year=2026&month=11')
        self.assertEqual(self.urls[2], 'https://torecamap.co.jp/release-schedule?year=2027&month=1')

    def test_writes_schema_shaped_files_in_parser_order(self):
        code, err = self.run_main({u: PAGE for u in self.urls})
        self.assertEqual(code, 0, err)
        self.assertEqual(self.written(), ['_run.json', 'latest.json'])
        with open(os.path.join(self.root, 'torecamap', 'latest.json')) as f:
            records = json.load(f)
        with open(os.path.join(self.root, 'torecamap', '_run.json')) as f:
            run = json.load(f)
        unknown = set()
        saved, parse.fetch = parse.fetch, serve({u: PAGE for u in self.urls})
        try:
            expected = parse.parse_torecamap(TODAY, unknown)
        finally:
            parse.fetch = saved
        self.assertEqual(records, expected)
        self.assertEqual(len(records), 5)
        date = re.compile(DEFS['date']['pattern'])
        for r in records:
            self.assertEqual(sorted(r), sorted(AGGREGATOR['required']))
            self.assertTrue(all(isinstance(r[k], str) for k in r))
            self.assertRegex(r['date'], date)
            self.assertTrue(r['name'])
            self.assertEqual(r['src'], 'torecamap')
        self.assertEqual(sorted(run), sorted(RUN['required']))
        self.assertEqual((run['source'], run['today'], run['complete'], run['errors']), ('torecamap', '2026-11-19', True, []))
        self.assertEqual(run['record_count'], len(records))
        self.assertEqual([p['url'] for p in run['pages']], self.urls)
        for p in run['pages']:
            self.assertEqual(sorted(p), sorted(RUN['properties']['pages']['items']['required']))
            self.assertIsNone(p['game'])
            self.assertIsNone(p['error'])
        # the same page served for every month: later months only repeat (date, name) pairs the first one added
        self.assertEqual([p['records'] for p in run['pages']], [5, 0, 0, 0, 0, 0])

    def test_empty_month_is_fine_when_others_have_items(self):
        empty = re.sub(rb'class="ReleaseScheduleDayGroup_release-schedule-day-group.*', b'</div>', PAGE, flags=re.S)
        self.assertIn(collect.MARKER.encode(), empty)
        pages = {u: PAGE for u in self.urls}
        pages[self.urls[-1]] = empty
        code, err = self.run_main(pages)
        self.assertEqual(code, 0, err)

    def assert_refused(self, pages, needle):
        code, err = self.run_main(pages)
        self.assertNotEqual(code, 0)
        self.assertIn(needle, err)
        self.assertIsNone(self.written())

    def test_refuses_a_failed_fetch(self):
        pages = {u: PAGE for u in self.urls}
        pages[self.urls[3]] = OSError('HTTP Error 503')
        self.assert_refused(pages, self.urls[3])

    def test_refuses_a_page_without_the_layout_marker(self):
        pages = {u: PAGE for u in self.urls}
        pages[self.urls[1]] = PAGE.replace(collect.MARKER.encode(), b'SomethingElse')
        self.assert_refused(pages, collect.MARKER)

    def test_refuses_zero_items_over_all_months(self):
        empty = re.sub(rb'class="ReleaseScheduleDayGroup_release-schedule-day-group.*', b'</div>', PAGE, flags=re.S)
        self.assert_refused({u: empty for u in self.urls}, 'no records')

    def test_refusal_keeps_previous_files(self):
        self.assertEqual(self.run_main({u: PAGE for u in self.urls})[0], 0)
        out = os.path.join(self.root, 'torecamap')
        before = _contents(out)
        pages = {u: PAGE for u in self.urls}
        pages[self.urls[0]] = OSError('timed out')
        self.assertNotEqual(self.run_main(pages)[0], 0)
        self.assertEqual(_contents(out), before)


class Parse(unittest.TestCase):
    """Images and prices as the merge wants them (contracts/releases.md › Aggregator records)."""

    def setUp(self):
        urls = collect.month_urls(TODAY)
        self.records, _ = collect._parse_served(TODAY, {u: PAGE for u in urls})
        self.by_name = {r['name']: r for r in self.records}

    def test_images(self):
        self.assertEqual([r['img'] for r in self.records], [
            '',  # no-image placeholder
            'https://d26vgo7frmwa7l.cloudfront.net/master-packs/1793765571168-a0cd7e7b.webp',
            'https://d26vgo7frmwa7l.cloudfront.net/master-packs/5/1792573249745-63e5f6e8-yugioh-rushduel-jounetsu-no-jointech.webp',
            '',
            '',  # last item of the month: the page-tail section-title-small.png is not its image
        ])

    def test_old_next_image_form_and_relative_urls(self):
        enc = '/_next/image?url=https%3A%2F%2Fd.cloudfront.net%2Fmaster-packs%2Fa.webp&amp;w=256&amp;q=75'
        self.assertEqual(parse.product_image(f'<img alt="" src="{enc}"/><div class="ProductInfo_name__x">a</div>'),
                         'https://d.cloudfront.net/master-packs/a.webp')
        for src in ('/_next/image?url=%2Fimages%2Fsection-title-small.png&amp;w=3840&amp;q=75', '/images/a.png'):
            self.assertEqual(parse.product_image(f'<img src="{src}"/><div class="ProductInfo_name__x">a</div>'), '')
        self.assertEqual(parse.product_image('<div class="ProductInfo_name__x">a</div><img src="https://x.test/a.png"/>'), '')

    def test_prices(self):
        self.assertEqual([(r['pack'], r['box']) for r in self.records], [
            ('418円', '6,688円'), ('385円', '6,160円'), ('198円', '5,940円'), ('', '2,530円'), ('440円', '')])
        for text, want in (('1,100円', '1,100円'), ('12345円（税込）', '12,345円'), ('値段設定なし', ''), ('オープン価格', 'オープン価格')):
            self.assertEqual(parse.price(text), want)


if __name__ == '__main__':
    unittest.main()
