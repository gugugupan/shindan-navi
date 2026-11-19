"""scripts/update_data.py as the merge step: guards, the official step, thumbnails. No network, no keys.

  .venv/bin/python -I tools/release-collectors/test_merge.py
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import warnings
from unittest import mock

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import output  # noqa: E402
from official import run as official_run  # noqa: E402

sys.path.insert(0, os.path.join(output.ROOT, 'scripts'))
import update_data as ud  # noqa: E402
from sourcekey import make_source  # noqa: E402

TODAY = '2026-11-19'
OP = 'ONE PIECE'


def agg(date, game, name, src, pack='', img='', url=''):
    return {'date': date, 'game': game, 'name': name, 'pack': pack, 'box': '', 'url': url, 'img': img, 'src': src}


def item(date, game, name, pack='', thumb='', source=None):
    return {'id': ud.item_id(game, name), 'date': date, 'game': game, 'name': name, 'pack': pack, 'box': '', 'url': '',
            'thumb': thumb, 'approx': False, 'sources': ['clabo'],
            'source': source or {'url': '', 'key': make_source('', name)['key'], 'site': 'aggregator'}}


def off(key, game, name, date, kind='BOOSTER_PACK', url=None, final=None, **kw):
    page = f'https://example.test/{key}/products/'
    return dict({'source_key': key, 'game': game, 'name': name, 'date': date, 'date_text': date, 'source_page': page,
                 'url': url, 'image': None, 'pack_yen': None, 'box_yen': None, 'per_box': None, 'per_pack': None,
                 'type': None, 'tentative': False, 'editions': [], 'kind': kind, 'kind_p': 0.9, 'via': 'listing',
                 'source': make_source(final or url or page, name, 'official')}, **kw)


E1 = item('2026-12-05', OP, 'ブースターパック 新時代の主役【OP-15】', pack='220円')
E2 = item('2026-12-12', OP, 'エクストラブースター メモリアルコレクション2')
E3 = item('2026-12-20', OP, 'プレミアムカードコレクション ベストセレクション')
CS = 'ワンピースカードゲーム チャンピオンシップセット2026'
E4 = item('2027-01-10', OP, CS, source=make_source('https://example.test/products/cs2026.html', CS, 'official'))
E4['sources'] = []

CLABO = [agg(x['date'], OP, x['name'], 'clabo') for x in (E1, E2, E3)]
TORECAMAP = [agg('2026-12-01', 'MTG', '拡張パック テスト航海', 'torecamap', pack='440円')]

OFFICIAL = [
    off('onepiece', OP, 'ブースターパック 新時代の主役【OP-15】', '2026-12-05', pack_yen=330, box_yen=7920, per_box=24),
    off('onepiece', OP, 'EXTRA BOOSTER MEMORIAL COLLECTION 2', '2026-12-12'),
    off('onepiece', OP, 'プレミアムカードコレクション ベストセレクション vol.1', '2026-12-20', kind='PRODUCT_SET_OR_BOX'),
    # the collector followed a redirect: `source` is the final page, which a recomputation from `url` would not know
    off('onepiece', OP, CS, '2027-01-10', kind='PRODUCT_SET_OR_BOX', url='https://example.test/r/cs',
        final='https://example.test/products/cs2026.html'),
    off('onepiece', OP, 'スタートデッキ 黒ひげ海賊団【ST-31】', '2027-01-24', kind='DECK', pack_yen=1650),
    off('onepiece', OP, 'ブースターパック 未来の航路【OP-16】', None),
    off('onepiece', OP, 'オフィシャルカードスリーブ 15', '2026-12-05', kind='SUPPLY_OR_ACCESSORY'),
    off('pokemon', 'ポケモンカード', '拡張パック テスト', '2026-12-26', pack_yen=180),
]


def jev(task, questions, batch=20):
    """SAME only for the English / katakana pair; everything else DIFFERENT."""
    out = {}
    for q, body in questions.items():
        ins = body['instructions']
        same = ins['listing_a'].startswith('EXTRA BOOSTER MEMORIAL') and 'メモリアルコレクション2' in ins['listing_b']
        out[q] = ('SAME', 0.95) if same else ('DIFFERENT', 0.9)
    return out


def png():
    buf = io.BytesIO()
    Image.new('RGBA', (400, 300), (200, 30, 30, 128)).save(buf, 'PNG')
    return buf.getvalue()


class MergeCase(unittest.TestCase):
    def setUp(self):
        warnings.simplefilter('ignore', ResourceWarning)  # update_data.py opens files without closing them
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.data, self.releases = os.path.join(self.tmp, 'data'), os.path.join(self.tmp, 'releases')
        self.thumbs = os.path.join(self.tmp, 'thumbs')
        os.makedirs(self.data)
        os.makedirs(self.thumbs)
        self.write_data([E1, E2, E3, E4], {})
        for p in (mock.patch.dict(os.environ, {'TODAY': TODAY}), mock.patch.object(ud, 'THUMBS', self.thumbs),
                  mock.patch.object(ud, 'fetch', self.no_fetch)):
            p.start()
            self.addCleanup(p.stop)

    def no_fetch(self, url):
        raise AssertionError(f'unexpected fetch {url}')

    def write_data(self, items, overrides):
        for name, value in (('items.json', items), ('overrides.json', overrides)):
            with open(os.path.join(self.data, name), 'w') as f:
                json.dump(value, f, ensure_ascii=False)

    def write_source(self, source, records, today=TODAY):
        pages = [{'key': source, 'game': None, 'url': 'u', 'records': len(records), 'error': None}]
        output.write_release_files(source, records, today=today, pages=pages, root=self.releases)

    def write_official(self, records=OFFICIAL, today=TODAY, games=(OP, 'ポケモンカード'), errors=None):
        pages = [{'key': k, 'game': g, 'url': f'https://example.test/{k}/products/', 'records': 1, 'error': (errors or {}).get(g)}
                 for k, g in (('onepiece', OP), ('pokemon', 'ポケモンカード')) if g in games]
        output.write_release_files('official', [dict(r) for r in records if r['game'] in games], today=today, pages=pages,
                                   games=games,
                                   notes=['onepiece listing https://example.test/onepiece/products/: 7 entries'],
                                   usage={'jev': {'calls': 3, 'prompt_tokens': 0, 'completion_tokens': 0, 'cost': 0.001, 'seconds': 1.0}},
                                   root=self.releases)

    def run_merge(self, *args):
        with contextlib.redirect_stdout(io.StringIO()):
            return ud.main(['--releases', self.releases, '--data', self.data, '--thumbs', self.thumbs, *args])

    def report(self):
        with open(os.path.join(self.data, 'update-report.md')) as f:
            return f.read()

    def section(self, title):
        text = self.report()
        start = text.index('## ' + title)
        body = text[start:].split('\n\n', 2)[1]
        return [] if body == '- なし' else [x[2:] for x in body.split('\n')]


class Guards(MergeCase):
    def setUp(self):
        super().setUp()
        self.write_source('cardlabo', CLABO)
        self.write_source('torecamap', TORECAMAP)
        self.before = sorted(os.listdir(self.data))

    def edit_run(self, source, **kw):
        path = os.path.join(self.releases, source, '_run.json')
        with open(path) as f:
            run = json.load(f)
        run.update(kw)
        with open(path, 'w') as f:
            json.dump(run, f)

    def assertRefused(self, fragment):
        with self.assertRaises(SystemExit) as cm:
            self.run_merge('--no-official')
        self.assertIn('abort:', str(cm.exception))
        self.assertIn(fragment, str(cm.exception))
        self.assertIn('nothing written', str(cm.exception))
        self.assertEqual(sorted(os.listdir(self.data)), self.before)

    def test_missing_source(self):
        os.remove(os.path.join(self.releases, 'torecamap', '_run.json'))
        self.assertRefused('torecamap')

    def test_stale_source(self):
        self.write_source('cardlabo', CLABO, today='2026-11-18')
        self.assertRefused('stale')

    def test_incomplete_source(self):
        self.edit_run('torecamap', complete=False, errors=['u: HTTP 503'])
        self.assertRefused('incomplete')

    def test_count_mismatch(self):
        self.edit_run('cardlabo', record_count=len(CLABO) + 1)
        self.assertRefused('record_count')

    def test_empty_source(self):
        with open(os.path.join(self.releases, 'cardlabo', 'latest.json'), 'w') as f:
            f.write('[]\n')
        self.edit_run('cardlabo', record_count=0)
        self.assertRefused('empty')

    def test_too_few_releases(self):
        many = [item(f'2026-12-{d:02d}', 'MTG', f'商品{d}') for d in range(1, 21)]
        self.write_data(many, {})
        with self.assertRaises(SystemExit) as cm:
            self.run_merge('--no-official')
        self.assertIn('releases scraped vs', str(cm.exception))
        self.assertEqual(sorted(os.listdir(self.data)), self.before)

    def test_official_missing_or_stale_is_skipped(self):
        self.run_merge('--dry-run', '--no-enrich')
        self.assertIn('official: skipped (no ', self.report())
        self.write_official(today='2026-11-18')
        self.run_merge('--dry-run', '--no-enrich')
        self.assertIn('official: skipped (stale run from 2026-11-18', self.report())
        self.assertEqual(sorted(os.listdir(self.data)), sorted(self.before + ['update-report.md']))


class OfficialCase(MergeCase):
    def setUp(self):
        super().setUp()
        self.write_source('cardlabo', CLABO)
        self.write_source('torecamap', TORECAMAP)
        self.write_official()
        self.llm_calls = []
        for p in (mock.patch.dict(os.environ, {'TYPESAFE_API_KEY': 'test', 'OPENROUTER_API_KEY': ''}),
                  mock.patch.object(official_run, 'jev_choice', jev),
                  mock.patch.object(official_run, 'llm_json', lambda *a, **kw: self.llm_calls.append(a) or {'pairs': []})):
            p.start()
            self.addCleanup(p.stop)

    def merged(self):
        # OPENROUTER_API_KEY is empty, so has_official_keys() says no: give the official step its keys, not enrich
        with mock.patch.object(ud, 'has_official_keys', lambda: True):
            return {x['id']: x for x in self.run_merge('--dry-run')}


class Official(OfficialCase):
    def test_fold_new_and_dedupe(self):
        items = self.merged()
        e1, e2, e3, e4 = (items[x['id']] for x in (E1, E2, E3, E4))
        self.assertEqual((e1['source'], e1['pack'], e1['box'], e1['per_box'], e1['sources'], e1['official_name']),
                         (OFFICIAL[0]['source'], '330円', '7,920円', 24, ['clabo', 'official'], OFFICIAL[0]['name']))
        self.assertEqual((e2['source'], e2['sources']), (OFFICIAL[1]['source'], ['clabo', 'official']))
        self.assertEqual(e3['sources'], ['clabo'])
        self.assertEqual((e4['source'], e4['sources']), (OFFICIAL[3]['source'], ['official']))
        new = items[ud.item_id(OP, 'スタートデッキ 黒ひげ海賊団【ST-31】')]
        self.assertEqual((new['date'], new['pack'], new['sources'], new['source']), ('2027-01-24', '1,650円', ['official'], OFFICIAL[4]['source']))
        self.assertIn(ud.item_id('ポケモンカード', '拡張パック テスト'), items)
        self.assertNotIn(ud.item_id(OP, OFFICIAL[2]['name']), items)
        self.assertNotIn(ud.item_id(OP, OFFICIAL[6]['name']), items)
        self.assertEqual(len(items), 4 + 1 + 2)  # existing + torecamap MTG + two official-only
        self.assertEqual(self.section('公式サイトから追加'),  # sources.json key order, then page order
                         ['2027-01-24  [ONE PIECE] スタートデッキ 黒ひげ海賊団【ST-31】 1,650円', '2026-12-26  [ポケモンカード] 拡張パック テスト 180円'])
        self.assertEqual(self.section('公式で発表済み・発売日未定'),
                         ['[ONE PIECE] ブースターパック 未来の航路【OP-16】 — 日付未定  https://example.test/onepiece/products/'])
        self.assertEqual(self.section('公式サイトで確認できなかった今後の商品'), ['2026-12-20  [ONE PIECE] プレミアムカードコレクション ベストセレクション'])
        self.assertIn('[ONE PIECE] ブースターパック 新時代の主役【OP-15】  pack: 220円 → 330円（公式）', self.section('価格の変更'))
        log = self.section('公式サイト取得ログ')
        self.assertIn('onepiece listing https://example.test/onepiece/products/: 7 entries', log)
        self.assertIn('official onepiece: skipped duplicate 「プレミアムカードコレクション ベストセレクション vol.1」 = 「プレミアムカードコレクション ベストセレクション」', log)
        self.assertIn('official onepiece: 1 supplies/accessories not added', log)
        self.assertIn('official cost (collect): jev 3 calls 0+0 tok $0.0010', log)
        self.assertIn('box info: skipped (OPENROUTER_API_KEY not set in .env)', log)
        self.assertEqual(len(self.llm_calls), 1)  # the unpaired 12-20 entry against E3

    def test_deterministic(self):
        first = self.merged()
        report = self.report()
        self.assertEqual(self.merged(), first)
        self.assertEqual(self.report(), report)

    def test_without_keys_skips(self):
        with mock.patch.object(ud, 'has_official_keys', lambda: False):
            items = self.run_merge('--dry-run', '--no-enrich')
        self.assertIn('official: skipped (TYPESAFE_API_KEY / OPENROUTER_API_KEY not set in .env)', self.report())
        self.assertFalse(any('official' in x['sources'] for x in items))


class OfficialNotRun(OfficialCase):
    """What the last official run gave an item survives a run whose official step is skipped."""
    OP19 = 'ブースターパック 応答せよ、世界【OP-19】'

    def setUp(self):
        super().setUp()
        url = 'https://www.onepiece-cardgame.com/products/boosters/op19.php'
        adopted = dict(item('2027-02-27', OP, self.OP19, source=make_source(url, self.OP19, 'official')),
                       url=url, box='7,920円', per_box=24, sources=['official'], official_name=self.OP19)
        renamed = dict(E2, sources=['clabo', 'official'], official_name='EXTRA BOOSTER MEMORIAL COLLECTION 2')
        gone = dict(E3, sources=['clabo', 'official'], official_name=E3['name'])
        self.existing = {x['id']: x for x in (E1, renamed, gone, adopted)}
        self.write_data(list(self.existing.values()), {})
        self.write_source('cardlabo', [agg(x['date'], OP, x['name'], 'clabo') for x in (E1, renamed)])
        self.write_source('torecamap', [agg('2027-02-27', OP, '応答せよ、世界【OP-19】', 'torecamap', pack='330円')])

    def check_kept(self, items, added=()):
        op19 = items[ud.item_id(OP, self.OP19)]
        self.assertEqual({k: op19[k] for k in ('name', 'source', 'url', 'box', 'per_box', 'official_name')},
                         {k: self.existing[op19['id']][k] for k in ('name', 'source', 'url', 'box', 'per_box', 'official_name')})
        self.assertEqual((op19['sources'], op19['pack']), (['official', 'torecamap'], '330円'))
        self.assertEqual(items[E2['id']]['sources'], ['clabo', 'official'])
        self.assertEqual(items[E2['id']]['name'], E2['name'])  # the aggregator's name, not official_name: unchanged
        self.assertEqual(items[E3['id']]['sources'], ['official'])
        self.assertEqual(set(items), set(self.existing) | set(added))
        self.assertEqual((self.section('発売日の変更'), self.section('価格の変更')), ([], []))

    def test_without_keys(self):
        with mock.patch.object(ud, 'has_official_keys', lambda: False):
            self.check_kept({x['id']: x for x in self.run_merge('--dry-run', '--no-enrich')})

    def test_no_official_flag(self):
        self.check_kept({x['id']: x for x in self.run_merge('--dry-run', '--no-official')})

    def test_stale_official_files(self):
        self.write_official(today='2026-11-18')
        with mock.patch.object(ud, 'has_official_keys', lambda: True):
            self.check_kept({x['id']: x for x in self.run_merge('--dry-run', '--no-enrich')})

    def test_official_ran(self):
        # sources come from this run's matches only; the official name stays, as without the official step
        items = self.merged()
        op19 = items[ud.item_id(OP, self.OP19)]
        self.assertEqual((op19['name'], op19['sources']), (self.OP19, ['torecamap']))
        self.assertEqual((op19['source'], op19['url'], op19['box']), (self.existing[op19['id']]['source'], self.existing[op19['id']]['url'], '7,920円'))
        self.assertEqual(items[E2['id']]['sources'], ['clabo', 'official'])
        self.assertEqual(items[E3['id']]['sources'], [])

    def test_partial_official_run_keeps_unchecked_titles(self):
        # a --games pokemon run (or a failed ONE PIECE page) did not check ONE PIECE: keep what it had
        pokemon = [r for r in OFFICIAL if r['source_key'] == 'pokemon']
        for kw in ({'games': ('ポケモンカード',)}, {'errors': {OP: 'HTTP 503'}}):
            with self.subTest(**kw):
                self.write_official(records=pokemon, **kw)
                self.check_kept(self.merged(), added=[ud.item_id('ポケモンカード', '拡張パック テスト')])
                self.assertEqual(self.section('公式サイトで確認できなかった今後の商品'), [])

    def test_official_checked(self):
        page = {'key': 'k', 'url': 'u', 'records': 1}
        run = {'games': ['A', 'B', 'C'], 'pages': [dict(page, game='A', error=None), dict(page, game='B', error=None),
                                                  dict(page, game='B', error='HTTP 503'), dict(page, game='D', error=None)]}
        self.assertEqual(ud.official_checked(run), {'A'})  # B: a page failed; C: no page; D: not in scope
        self.assertEqual(ud.official_checked({'pages': run['pages']}), set())  # a run file without scope checks nothing


class Thumbs(MergeCase):
    def test_save_and_cleanup(self):
        pinned = item('2026-12-03', 'MTG', '固定画像の商品')
        kept = item('2026-12-04', 'MTG', '既存画像の商品', thumb='thumbs/kept.jpg')
        self.write_data([E1, E2, E3, pinned, kept], {pinned['id']: {'thumb': 'thumbs/pinned.jpg', '_name': pinned['name']}})
        for name in ('stale.jpg', 'pinned.jpg', 'kept.jpg', 'notes.txt'):
            open(os.path.join(self.thumbs, name), 'w').close()
        self.write_source('cardlabo', CLABO)
        self.write_source('torecamap', TORECAMAP[:1] + [agg('2026-12-02', 'MTG', '画像つき新商品', 'torecamap', img='https://img.test/new.png')])
        fetched = []
        with mock.patch.object(ud, 'fetch', lambda url: fetched.append(url) or png()):
            items = {x['id']: x for x in self.run_merge('--no-official')}
        new = items[ud.item_id('MTG', '画像つき新商品')]
        saved = new['thumb'].split('/')[-1]
        self.assertEqual(fetched, ['https://img.test/new.png'])
        self.assertTrue(new['thumb'].startswith('thumbs/') and saved.endswith('.jpg'))
        self.assertEqual(sorted(os.listdir(self.thumbs)), sorted(['kept.jpg', 'notes.txt', 'pinned.jpg', saved]))
        with Image.open(os.path.join(self.thumbs, saved)) as im:
            self.assertEqual((im.format, im.mode, max(im.size)), ('JPEG', 'RGB', 280))
        self.assertEqual(items[pinned['id']]['thumb'], 'thumbs/pinned.jpg')
        with open(os.path.join(self.data, 'items.json')) as f:
            self.assertEqual(len(json.load(f)), len(items))
        with open(os.path.join(self.data, 'meta.json')) as f:
            self.assertEqual(json.load(f), {'updated': TODAY})
        self.assertEqual(sorted(os.listdir(self.data)), ['items.json', 'meta.json', 'overrides.json', 'update-report.md'])

    def test_dry_run_writes_no_thumbs_or_data(self):
        open(os.path.join(self.thumbs, 'stale.jpg'), 'w').close()
        self.write_source('cardlabo', CLABO)
        self.write_source('torecamap', [agg('2026-12-02', 'MTG', '画像つき新商品', 'torecamap', img='https://img.test/new.png')])
        self.run_merge('--dry-run', '--no-official')
        self.assertEqual(os.listdir(self.thumbs), ['stale.jpg'])
        self.assertEqual(sorted(os.listdir(self.data)), ['items.json', 'overrides.json', 'update-report.md'])

    def test_bad_image_is_skipped_and_reported(self):
        self.write_source('cardlabo', CLABO)
        self.write_source('torecamap', [agg('2026-12-02', 'MTG', '相対パス画像', 'torecamap', img='/images/section-title-small.png'),
                                        agg('2026-12-03', 'MTG', '取得失敗画像', 'torecamap', img='https://img.test/gone.png'),
                                        agg('2026-12-04', 'MTG', '壊れた画像', 'torecamap', img='https://img.test/broken.png')])
        bodies = {'https://img.test/gone.png': OSError('HTTP Error 404'), 'https://img.test/broken.png': b'not an image'}

        def fetch(url):
            body = bodies[url]
            if isinstance(body, Exception):
                raise body
            return body
        with mock.patch.object(ud, 'fetch', fetch):
            items = {x['name']: x for x in self.run_merge('--no-official')}
        self.assertEqual([items[n]['thumb'] for n in ('相対パス画像', '取得失敗画像', '壊れた画像')], ['', '', ''])
        self.assertEqual(os.listdir(self.thumbs), [])
        failed = [x for x in self.section('画像を取得/差し替え') if '画像の取得に失敗' in x]
        self.assertEqual(len(failed), 3)
        self.assertIn('not an http(s) URL', failed[0])
        self.run_merge('--dry-run', '--no-official')
        self.assertEqual(len([x for x in self.section('画像を取得/差し替え') if 'not an http(s) URL' in x]), 1)

    def test_crash_after_download_leaves_no_orphan_thumbs(self):
        self.write_source('cardlabo', CLABO)
        self.write_source('torecamap', [agg('2026-12-02', 'MTG', '画像つき新商品', 'torecamap', img='https://img.test/new.png')])
        before = sorted(os.listdir(self.data))
        with mock.patch.object(ud, 'fetch', lambda url: png()), \
                mock.patch.object(ud, 'write_report', mock.Mock(side_effect=KeyboardInterrupt)):
            with self.assertRaises(KeyboardInterrupt):
                self.run_merge('--no-official')
        self.assertEqual(os.listdir(self.thumbs), [])
        self.assertEqual(sorted(os.listdir(self.data)), before)

    def test_data_without_thumbs_is_refused(self):
        self.write_source('cardlabo', CLABO)
        self.write_source('torecamap', TORECAMAP)
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()) as err:
            ud.main(['--releases', self.releases, '--data', self.data, '--no-official'])
        self.assertIn('--data DIR needs --thumbs DIR', err.getvalue())
        self.assertEqual(sorted(os.listdir(self.data)), ['items.json', 'overrides.json'])
        with contextlib.redirect_stdout(io.StringIO()):
            ud.main(['--releases', self.releases, '--data', self.data, '--no-official', '--dry-run'])

    def test_thumbs_flag(self):
        other = os.path.join(self.tmp, 'other-thumbs')
        os.makedirs(other)
        self.write_source('cardlabo', CLABO)
        self.write_source('torecamap', [agg('2026-12-02', 'MTG', '画像つき新商品', 'torecamap', img='https://img.test/new.png')])
        with mock.patch.object(ud, 'fetch', lambda url: png()):
            items = {x['name']: x for x in self.run_merge('--no-official', '--thumbs', other)}
        self.assertEqual(os.listdir(other), [items['画像つき新商品']['thumb'].split('/')[-1]])
        self.assertEqual(os.listdir(self.thumbs), [])


class Prices(MergeCase):
    def test_same_amount_written_differently_is_not_a_price_change(self):
        a = dict(item('2026-12-05', 'MTG', '税込表記の商品', pack='440円(税込)'), box='6688円(税込)')
        b = dict(item('2026-12-06', 'MTG', '値上げの商品', pack='440円'), box='')
        self.write_data([a, b], {})
        self.write_source('cardlabo', [agg(a['date'], 'MTG', a['name'], 'clabo', pack='440円')])
        self.write_source('torecamap', [dict(agg(a['date'], 'MTG', a['name'], 'torecamap', pack='440円'), box='6,688円'),
                                        agg(b['date'], 'MTG', b['name'], 'torecamap', pack='495円')])
        items = {x['name']: x for x in self.run_merge('--dry-run', '--no-official')}
        self.assertEqual((items[a['name']]['pack'], items[a['name']]['box']), ('440円', '6,688円'))
        self.assertEqual(self.section('価格の変更'), ['[MTG] 値上げの商品  pack: 440円 → 495円'])


if __name__ == '__main__':
    unittest.main()
