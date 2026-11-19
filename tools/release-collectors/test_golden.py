"""Golden replay of the aggregator merge; skipped when the git-ignored snapshot is absent.

  .venv/bin/python -I tools/release-collectors/test_golden.py
"""
import os
import sys
import unittest
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import golden  # noqa: E402


@unittest.skipUnless(os.path.exists(golden.MANIFEST), 'no golden snapshot (golden.py capture)')
class GoldenReplay(unittest.TestCase):
    def test_replay_matches_expected(self):
        warnings.simplefilter('ignore', ResourceWarning)  # update_data.py opens files without closing them
        items, report = golden.run()
        with open(os.path.join(golden.EXPECTED, 'items.json')) as f:
            self.assertEqual(items, f.read())
        with open(os.path.join(golden.EXPECTED, 'report.md')) as f:
            self.assertEqual(report, f.read())


if __name__ == '__main__':
    unittest.main()
