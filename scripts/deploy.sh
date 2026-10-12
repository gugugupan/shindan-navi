#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
GA_ID="${GA_ID:-G-Q4NENX804G}"
GA_ID="$GA_ID" python3 -I scripts/build.py
npx --yes wrangler@4 pages deploy dist --project-name shindan-navi --branch main --commit-dirty=true
