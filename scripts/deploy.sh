#!/usr/bin/env bash
# Manual fallback for .github/workflows/deploy.yml. Needs `npx wrangler login` (or CLOUDFLARE_API_TOKEN)
# and D1_DATABASE_ID in the environment. Pass --no-routes to deploy without attaching shindan-navi.app.
set -euo pipefail
cd "$(dirname "$0")/.."
GA_ID="${GA_ID:-G-Q4NENX804G}"
PY=python3; [ -x .venv/bin/python ] && PY=.venv/bin/python
GA_ID="$GA_ID" TZ=Asia/Tokyo "$PY" -I scripts/build.py
node api/scripts/remote-config.mjs "$@"
npx --yes wrangler@4.164.0 deploy --config wrangler.remote.json
