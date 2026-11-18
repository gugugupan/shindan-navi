#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ -x .cache/node22/bin/node ]; then
  export PATH="$PWD/.cache/node22/bin:$PATH"
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo 'Node 20+ is required. Prepare the runtime with run.sh --doctor.' >&2
  exit 1
fi
if [ "${1:-}" = --direct ]; then
  shift
  exec node scrape.mjs "$@"
fi
exec node scrape-browser.mjs "$@"
