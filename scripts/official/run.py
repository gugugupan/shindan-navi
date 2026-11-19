"""Moved to tools/release-collectors/official/run.py; kept so scripts/update_data.py (`import run`) still works."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'tools', 'release-collectors'))
from official.run import *  # noqa: E402,F401,F403
