#!/usr/bin/env bash
# Manual fallback for .github/workflows/deploy.yml.
#   ./scripts/deploy.sh pages              Pages site (live until the cutover; built without /events/)
#   ./scripts/deploy.sh worker             Worker, version preview URL only (needs D1_DATABASE_ID)
#   ./scripts/deploy.sh worker --domain    preview check, then Worker with shindan-navi.app (the cutover step)
# Needs `npx wrangler login` (or CLOUDFLARE_API_TOKEN).
set -euo pipefail
cd "$(dirname "$0")/.."
target="${1:-}"; shift || true
export GA_ID="${GA_ID:-G-Q4NENX804G}" TZ=Asia/Tokyo
PY=python3; [ -x .venv/bin/python ] && PY=.venv/bin/python
WRANGLER="npx --yes wrangler@4.164.0"
case "$target" in
  pages)
    BUILD_EVENTS=0 "$PY" -I scripts/build.py
    $WRANGLER pages deploy dist --project-name shindan-navi --branch main --commit-dirty=true ;;
  worker)
    "$PY" -I scripts/build.py
    if [ "${1:-}" = "--domain" ]; then
      # same gate as CI: a version preview with imported data must work before the domain moves
      node api/scripts/remote-config.mjs
      node api/scripts/preview-check.mjs
    fi
    node api/scripts/remote-config.mjs "$@"
    $WRANGLER deploy --config wrangler.remote.json ;;
  *) echo "usage: $0 pages | worker [--domain]" >&2; exit 2 ;;
esac
