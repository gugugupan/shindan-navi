"""  .venv/bin/python -I tools/release-collectors/official/test/test_collect.py

Jev, the LLM and page_text are stubbed; pages come from the synthetic fixtures next to this file. No network, no keys."""
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
from lib import output  # noqa: E402
from official import collect, common, run  # noqa: E402

TODAY = '2026-11-19'
with open(os.path.join(output.ROOT, 'contracts', 'release.schema.json')) as f:
    RELEASE = json.load(f)
with open(os.path.join(output.ROOT, 'contracts', 'release-run.schema.json')) as f:
    RUN = json.load(f)
REAL = collect.load_sources()

LISTING_URL = 'https://example.test/products/'
LISTING_FINAL = 'https://example.test/products/index.html'
POKEMON_API = 'https://www.pokemon-card.com/products/resultAPI.php?page=1'


def fixture(name):
    with open(os.path.join(HERE, 'fixtures', name), 'rb') as f:
        return f.read()


PAGES = {POKEMON_API: fixture('pokemon-api-page1.json'),
         REAL['yugioh']['pages'][0]['url']: fixture('yugioh-products-trimmed.html'),
         LISTING_URL: b'<html>listing</html>'}

# what the stubbed LLM "reads" from the listing page
LISTING_PRODUCTS = [
    {'name': 'テストブースター', 'release_date': '2026-12-12', 'release_date_text': '2026年12月12日', 'price_text': '220円',
     'price_box_yen': 4400, 'packs_per_box': 20, 'cards_per_pack': 6, 'product_type': '拡張パック',
     'editions': ['日本語版', '英語版'], 'url': None, 'image_url': 'https://example.test/img/booster.png', 'tentative': False},
    {'name': 'テストブースター', 'release_date': '2026-12-12', 'price_text': None, 'editions': ['日本語版', '英語版'],
     'url': 'https://example.test/products/booster/'},  # duplicate: fills url only
    {'name': '昨日のデッキ', 'release_date': '2026-11-18', 'product_type': 'デッキ'},
    {'name': '未定のセット', 'release_date': None, 'release_date_text': '2027年春発売予定', 'product_type': 'セット', 'tentative': True,
     'price_box_yen': 0, 'packs_per_box': 1000},
    {'name': '発売記念大会', 'release_date': '2026-12-13', 'product_type': 'イベント'},
]


def fake_fetch(url, headers=None, max_age=None):
    if url not in PAGES:
        raise OSError(f'no fixture for {url}')
    if url == LISTING_URL:
        common._FINAL[url] = LISTING_FINAL
    return PAGES[url]


def fake_jev(task, questions, batch=20):
    out = {}
    for q, spec in questions.items():
        item = spec['instructions']['item']
        kind = ('NOT_A_PRODUCT' if '大会' in item else 'SUPPLY_OR_ACCESSORY' if 'スリーブ' in item
                else 'DECK' if 'デッキ' in item else 'PRODUCT_SET_OR_BOX' if 'セット' in item else 'BOOSTER_PACK')
        out[q] = (kind, 0.9)
    return out


def sources(*keys, broken=False):
    s = {'pokemon': {**REAL['pokemon'], 'pages': [{**REAL['pokemon']['pages'][0], 'pages': 1}]},
         'yugioh': REAL['yugioh'],
         'listing': {'game': 'テストTCG', 'full_name': 'テストカードゲーム', 'pages': [{'kind': 'listing', 'url': LISTING_URL}]}}
    if broken:
        s['broken'] = {'game': '壊れたTCG', 'full_name': '壊れた', 'pages': [{'kind': 'listing', 'url': 'https://example.test/gone/'}]}
    return {k: s[k] for k in keys} if keys else s


def validate(value, schema, root, path='$'):
    """The subset of JSON Schema draft-07 the contracts use; returns a list of problems."""
    schema = resolve(schema, root)
    errs = []
    if 'oneOf' in schema:
        ok = [s for s in schema['oneOf'] if not validate(value, resolve(s, root), root, path)]
        return [] if len(ok) == 1 else [f'{path}: matches {len(ok)} of oneOf']
    t = schema.get('type')
    if t:
        types = t if isinstance(t, list) else [t]
        py = {'string': str, 'integer': int, 'number': (int, float), 'boolean': bool, 'object': dict, 'array': list, 'null': type(None)}
        if not any(isinstance(value, py[x]) and not (x in ('integer', 'number') and isinstance(value, bool)) for x in types):
            return [f'{path}: {value!r} is not {t}']
    if 'enum' in schema and value not in schema['enum']:
        errs.append(f'{path}: {value!r} not in enum')
    if 'const' in schema and value != schema['const']:
        errs.append(f'{path}: {value!r} != const')
    if isinstance(value, str):
        if 'pattern' in schema and not re.search(schema['pattern'], value):
            errs.append(f'{path}: {value!r} does not match pattern')
        if len(value) < schema.get('minLength', 0):
            errs.append(f'{path}: too short')
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 'minimum' in schema and value < schema['minimum']:
            errs.append(f'{path}: below minimum')
        if 'maximum' in schema and value > schema['maximum']:
            errs.append(f'{path}: above maximum')
    if isinstance(value, dict):
        errs += [f'{path}: missing {k}' for k in schema.get('required', []) if k not in value]
        props = schema.get('properties', {})
        if schema.get('additionalProperties') is False:
            errs += [f'{path}: extra {k}' for k in value if k not in props]
        for k, v in value.items():
            if k in props:
                errs += validate(v, resolve(props[k], root), root, f'{path}.{k}')
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0):
            errs.append(f'{path}: fewer than minItems')
        if 'items' in schema:
            for i, v in enumerate(value):
                errs += validate(v, resolve(schema['items'], root), root, f'{path}[{i}]')
    return errs


def resolve(schema, root):
    while '$ref' in schema:
        node = root
        for part in schema['$ref'].lstrip('#/').split('/'):
            node = node[part]
        schema = node
    return schema


class Base(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        common._FINAL.clear()
        for target, value in ((common, 'load_env'), (run, 'fetch'), (run, 'jev_choice'), (run, 'page_text'), (run, 'llm_json')):
            stub = {'load_env': lambda: None, 'fetch': fake_fetch, 'jev_choice': fake_jev,
                    'page_text': lambda html, url, limit=40000: 'page text', 'llm_json': self.fake_llm}[value]
            p = mock.patch.object(target, value, stub)
            p.start()
            self.addCleanup(p.stop)
        env = mock.patch.dict(os.environ, {'TYPESAFE_API_KEY': 'test', 'OPENROUTER_API_KEY': 'test'})
        env.start()
        self.addCleanup(env.stop)

    def fake_llm(self, system, user, max_tokens=6000):
        return {'products': [dict(p) for p in LISTING_PRODUCTS]}

    def files(self):
        out = os.path.join(self.root, 'official')
        return sorted(os.listdir(out)) if os.path.isdir(out) else []

    def load(self, name):
        with open(os.path.join(self.root, 'official', name)) as f:
            return json.load(f)


class Rules(unittest.TestCase):
    def test_dedupe_keeps_first_and_fills_blanks(self):
        got = run.dedupe([{'name': 'Ａ パック', 'date': '2026-12-01', 'url': None, 'pack_yen': 200},
                          {'name': 'aパック', 'date': '2026-12-01', 'url': 'https://x/', 'pack_yen': 300},
                          {'name': 'A パック', 'date': '2026-12-02', 'url': None, 'pack_yen': None}])
        self.assertEqual([(e['name'], e['date'], e['url'], e['pack_yen']) for e in got],
                         [('Ａ パック', '2026-12-01', 'https://x/', 200), ('A パック', '2026-12-02', None, None)])

    def test_split_editions(self):
        got = run.split_editions([{'name': 'X', 'editions': ['日本語版', '英語版']}, {'name': 'Y', 'editions': ['日本語版']},
                                  {'name': 'Z', 'editions': []}])
        self.assertEqual([(e['name'], e['editions']) for e in got],
                         [('X 日本語版', ['日本語版']), ('X 英語版', ['英語版']), ('Y', ['日本語版']), ('Z', [])])


class Collect(Base):
    def test_records_match_schema_and_rules(self):
        result = collect.collect(TODAY, sources=sources('pokemon', 'yugioh', 'listing'), root=self.root)
        records, saved = self.load('latest.json'), self.load('_run.json')
        self.assertEqual(validate(records, RELEASE, RELEASE), [])
        self.assertEqual(validate(saved, RUN, RUN), [])
        self.assertEqual(saved, {**result, 'fetched_at': saved['fetched_at']})
        self.assertEqual([(r['source_key'], r['name'], r['date'], r['via'], r['kind']) for r in records], [
            ('pokemon', '拡張パック「テストの星」', '2026-12-05', 'pokemon_api', 'BOOSTER_PACK'),
            ('pokemon', 'スタートデッキ テスト', '2026-11-19', 'pokemon_api', 'DECK'),
            ('yugioh', 'テストパック', '2026-12-20', 'records', 'BOOSTER_PACK'),
            ('yugioh', 'テストストラクチャーデッキ', '2027-01-10', 'records', 'DECK'),
            ('yugioh', 'テストスリーブ', None, 'records', 'SUPPLY_OR_ACCESSORY'),
            ('listing', 'テストブースター 日本語版', '2026-12-12', 'listing', 'BOOSTER_PACK'),
            ('listing', 'テストブースター 英語版', '2026-12-12', 'listing', 'BOOSTER_PACK'),
            ('listing', '未定のセット', None, 'listing', 'PRODUCT_SET_OR_BOX'),
        ])
        by = {r['name']: r for r in records}
        jp = by['テストブースター 日本語版']
        self.assertEqual((jp['url'], jp['pack_yen'], jp['box_yen'], jp['per_box'], jp['per_pack'], jp['editions']),
                         ('https://example.test/products/booster/', 220, 4400, 20, 6, ['日本語版']))
        self.assertEqual(jp['source'], run.make_source('https://example.test/products/booster/', jp['name'], 'official'))
        undated = by['未定のセット']
        # no product link: the source is the listing page as reached after its redirect
        self.assertEqual(undated['source']['url'], run.make_source(LISTING_FINAL, undated['name'], 'official')['url'])
        self.assertEqual((undated['box_yen'], undated['per_box'], undated['tentative']), (None, None, True))
        self.assertEqual((by['テストスリーブ']['date_text'], by['テストスリーブ']['tentative']), ('2027年2月', True))
        self.assertEqual(by['テストストラクチャーデッキ']['url'], None)
        self.assertEqual(by['テストパック']['url'], 'https://www.yugioh-card.com/japan/products/testpack/')
        self.assertEqual(by['スタートデッキ テスト']['pack_yen'], 1650)
        self.assertTrue(saved['complete'])
        self.assertEqual(saved['record_count'], len(records))
        self.assertEqual([(p['key'], p['records'], p['error']) for p in saved['pages']],
                         [('pokemon', 2, None), ('yugioh', 3, None), ('listing', 5, None)])
        self.assertTrue(any('listing listing https://example.test/products/: 5 entries' in n for n in saved['notes']))

    def test_failed_page_gives_partial_run(self):
        result = collect.collect(TODAY, sources=sources('broken', 'yugioh', broken=True), root=self.root)
        self.assertFalse(result['complete'])
        self.assertEqual(len(result['errors']), 1)
        self.assertTrue(result['errors'][0].startswith('https://example.test/gone/: '))
        self.assertEqual({r['source_key'] for r in self.load('latest.json')}, {'yugioh'})

    def test_classify_failure_marks_that_title_failed(self):
        def flaky(task, questions, batch=20):
            if any('テストブースター' in q['instructions']['item'] for q in questions.values()):
                raise RuntimeError('jev HTTP 500')
            return fake_jev(task, questions)
        with mock.patch.object(run, 'jev_choice', flaky):
            result = collect.collect(TODAY, sources=sources('listing', 'yugioh'), root=self.root)
        self.assertFalse(result['complete'])
        self.assertEqual([p['key'] for p in result['pages'] if p['error']], ['listing'])
        self.assertEqual({r['source_key'] for r in self.load('latest.json')}, {'yugioh'})

    def test_no_records_refuses_and_keeps_previous_files(self):
        collect.collect(TODAY, sources=sources('yugioh'), root=self.root)
        before = self.load('latest.json')
        with self.assertRaises(output.Refused):
            collect.collect(TODAY, sources=sources('broken', broken=True), root=self.root)
        self.assertEqual(self.load('latest.json'), before)

    def test_missing_keys_writes_nothing_and_exits_0(self):
        with mock.patch.dict(os.environ, {'TYPESAFE_API_KEY': '', 'OPENROUTER_API_KEY': ''}), \
                mock.patch.object(run, 'fetch', side_effect=AssertionError('fetched without keys')):
            self.assertIsNone(collect.collect(TODAY, root=self.root))
            err = io.StringIO()
            with redirect_stderr(err), redirect_stdout(io.StringIO()):
                self.assertEqual(collect.main(['--today', TODAY, '--root', self.root]), 0)
        self.assertIn('skipped', err.getvalue())
        self.assertEqual(os.listdir(self.root), [])

    def test_main_reports_refusal(self):
        with mock.patch.object(collect, 'load_sources', lambda: sources('broken', broken=True)), \
                redirect_stderr(io.StringIO()) as err:
            self.assertEqual(collect.main(['--today', TODAY, '--root', self.root]), 1)
        self.assertIn('refused', err.getvalue())
        self.assertEqual(self.files(), [])


if __name__ == '__main__':
    unittest.main()
