"""scripts/refresh.py without running any step: worktree check, merge-base reset, packet parsing, stop on failure.

  .venv/bin/python -I tools/release-collectors/test_refresh.py
"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import warnings
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), 'scripts'))
import refresh  # noqa: E402


def sh(cwd, *args):
    subprocess.run(['git', '-C', cwd, *args], check=True, capture_output=True)


class Repo(unittest.TestCase):
    """A throwaway git repo as refresh.ROOT, with committed data/ and public/thumbs."""

    def setUp(self):
        warnings.simplefilter('ignore', ResourceWarning)  # refresh.py opens files without closing them
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        sh(self.root, 'init', '-q', '-b', 'main')
        sh(self.root, 'config', 'user.email', 'test@example.test')
        sh(self.root, 'config', 'user.name', 'test')
        os.makedirs(os.path.join(self.root, 'data'))
        os.makedirs(os.path.join(self.root, 'public/thumbs'))
        self.write('data/items.json', '[1]\n')
        self.write('data/meta.json', '{"updated": "2026-11-18"}\n')
        self.write('public/thumbs/a.jpg', 'a')
        self.write('public/thumbs/b.jpg', 'b')
        sh(self.root, 'add', '.')
        sh(self.root, 'commit', '-q', '-m', 'init')
        self.logdir = os.path.join(self.root, 'out')
        os.makedirs(self.logdir)
        p = mock.patch.object(refresh, 'ROOT', self.root)
        p.start()
        self.addCleanup(p.stop)

    def write(self, rel, text):
        with open(os.path.join(self.root, rel), 'w') as f:
            f.write(text)

    def read(self, rel):
        with open(os.path.join(self.root, rel)) as f:
            return f.read()

    def quiet(self, fn, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fn(*args)
        return out.getvalue()


class Reset(Repo):
    def test_restores_data_and_thumbs(self):
        self.write('data/items.json', '[1, 2]\n')
        os.remove(os.path.join(self.root, 'public/thumbs/a.jpg'))
        self.write('public/thumbs/b.jpg', 'changed')
        self.write('public/thumbs/new.jpg', 'n')
        self.write('public/thumbs/notes.txt', 'keep')
        out = self.quiet(refresh.reset_merge_base, self.logdir)
        self.assertEqual(self.read('data/items.json'), '[1]\n')
        self.assertEqual(self.read('out/items.json.before-refresh'), '[1, 2]\n')
        self.assertEqual((self.read('public/thumbs/a.jpg'), self.read('public/thumbs/b.jpg')), ('a', 'b'))
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, 'public/thumbs'))), ['a.jpg', 'b.jpg', 'notes.txt'])
        self.assertIn('removed 1 untracked thumbnails: new.jpg', out)
        self.assertIn('restored 2 files from HEAD', out)
        self.assertEqual(self.quiet(refresh.reset_merge_base, self.logdir), '')  # nothing left to reset

    def test_failed_git_show_writes_nothing(self):
        sh(self.root, 'rm', '-q', '--cached', 'data/meta.json')
        sh(self.root, 'commit', '-q', '-m', 'drop meta')
        self.write('data/items.json', '[1, 2]\n')
        self.write('public/thumbs/new.jpg', 'n')
        with self.assertRaises(SystemExit) as cm:
            self.quiet(refresh.reset_merge_base, self.logdir)
        self.assertIn('git show HEAD:data/meta.json failed', str(cm.exception))
        self.assertEqual(self.read('data/items.json'), '[1, 2]\n')
        self.assertTrue(os.path.exists(os.path.join(self.root, 'public/thumbs/new.jpg')))


class Worktree(Repo):
    def test_main_checkout_on_main_is_refused(self):
        with self.assertRaises(SystemExit) as cm:
            refresh.check_worktree()
        self.assertIn('refusing to run in the main checkout on main', str(cm.exception))

    def test_worktree_is_fine(self):
        wt = os.path.join(tempfile.mkdtemp(), 'wt')
        self.addCleanup(shutil.rmtree, os.path.dirname(wt))
        sh(self.root, 'worktree', 'add', '-q', wt, '-b', 'data/x')
        with mock.patch.object(refresh, 'ROOT', wt):
            self.assertEqual(self.quiet(refresh.check_worktree), '')
            self.assertEqual(refresh.check_worktree(), 'data/x')

    def test_main_checkout_on_a_branch_warns(self):
        sh(self.root, 'checkout', '-q', '-b', 'other')
        self.assertIn('WARNING', self.quiet(refresh.check_worktree))


class Packet(Repo):
    REPORT = '\n'.join([
        '# データ更新レポート 2026-11-19', '',
        '- カードラボ 3件 / トレカの地図 2件 → 統合 4件', '- items.json: 4件 → 5件', '',
        '## 新規（1）', '', '- 2026-12-01  [MTG] 拡張パック', '',
        '## 価格の変更（0）', '', '- なし', '',
        '## 公式サイト取得ログ', '', '- official: skipped (no keys)', '- box info: skipped', ''])

    def test_report_lines(self):
        self.write('data/update-report.md', self.REPORT)
        self.assertEqual(refresh.report_lines(), [
            '- カードラボ 3件 / トレカの地図 2件 → 統合 4件', '- items.json: 4件 → 5件', '- 新規: 1', '- 価格の変更: 0',
            '- 公式サイト取得ログ:', '  - official: skipped (no keys)', '  - box info: skipped'])

    def test_collector_lines(self):
        releases = os.path.join(self.root, 'data/releases')
        for src, today, extra in (('cardlabo', '2026-11-19', {}), ('torecamap', '2026-11-18', {'unknown_labels': ['新TCG']})):
            os.makedirs(os.path.join(releases, src))
            with open(os.path.join(releases, src, '_run.json'), 'w') as f:
                json.dump(dict({'today': today, 'record_count': 3, 'complete': True, 'fetched_at': 'T', 'errors': []}, **extra), f)
        with mock.patch.object(refresh, 'RELEASES', releases):
            lines = refresh.collector_lines('2026-11-19', {'skipped': {'official': '--no-official'}})
        self.assertEqual(lines, [
            '- cardlabo: 3 records, complete true, fetched_at T',
            '- torecamap: 3 records, complete true, fetched_at T (unknown_labels: 新TCG) — STALE (today 2026-11-18, not 2026-11-19)',
            '- official: skipped (--no-official)'])


class Steps(unittest.TestCase):
    def test_stops_at_first_failure(self):
        ran, resets = [], []

        def step(name, cmd, env, logdir, n):
            ran.append((n, name))
            return (3 if name == 'build' else 0), f'{name} out'
        steps = [(n, [n]) for n in ('collect-cardlabo', 'merge', 'build', 'verify-release')]
        with mock.patch.object(refresh, 'run_step', step):
            stopped, outputs = refresh.run_steps(steps, {}, '/nowhere', lambda: resets.append(len(ran)))
        self.assertEqual(stopped, ('build', 3))
        self.assertEqual(ran, [(1, 'collect-cardlabo'), (2, 'merge'), (3, 'build')])
        self.assertEqual(resets, [1])  # reset right before the merge, once
        self.assertEqual(list(outputs), ['collect-cardlabo', 'merge', 'build'])

    def test_all_pass_without_reset(self):
        with mock.patch.object(refresh, 'run_step', lambda *a: (0, '')):
            self.assertEqual(refresh.run_steps([('merge', ['m'])], {}, '/nowhere', None), (None, {'merge': ''}))


if __name__ == '__main__':
    unittest.main()
