#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ -x .cache/node22/bin/node ]; then
  export PATH="$PWD/.cache/node22/bin:$PATH"
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo 'Node 20+ is required. Run bash tools/event-collectors/tcg-plus/run.sh --doctor from the repository root to prepare the local runtime.' >&2
  exit 1
fi
exec node trial.mjs "$@"
