"""Moved to tools/release-collectors/official/common.py; kept so scripts/update_data.py (`from common import load_env`) still works."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'tools', 'release-collectors'))
from official.common import *  # noqa: E402,F401,F403
