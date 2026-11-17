#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
task_dir="$PWD"
runtime_dir="$task_dir/.cache/node22"
mkdir -p "$task_dir/.cache"

if [ ! -x "$runtime_dir/bin/node" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-x86_64) node_platform=darwin-x64 ;;
    Darwin-arm64) node_platform=darwin-arm64 ;;
    Linux-x86_64) node_platform=linux-x64 ;;
    Linux-aarch64) node_platform=linux-arm64 ;;
    *) echo "Unsupported platform; install Node.js 22 manually." >&2; exit 1 ;;
  esac

  download_dir="$(mktemp -d "$task_dir/.cache/node-download.XXXXXX")"
  trap 'rm -rf -- "$download_dir"' EXIT
  node_base=https://nodejs.org/dist/latest-v22.x
  echo "Downloading a project-local Node.js 22 runtime ($node_platform)..."
  curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 60 "$node_base/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
  archive_name="$(awk -v platform="$node_platform" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-" platform "\\.tar\\.gz$") { print $2 }' "$download_dir/SHASUMS256.txt")"
  if [ -z "$archive_name" ] || [ "$(printf '%s\n' "$archive_name" | wc -l | tr -d ' ')" != 1 ]; then
    echo "Could not identify one official Node.js 22 archive." >&2
    exit 1
  fi
  curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 180 "$node_base/$archive_name" -o "$download_dir/$archive_name"
  awk -v archive="$archive_name" '$2 == archive' "$download_dir/SHASUMS256.txt" > "$download_dir/selected.sha256"
  (cd "$download_dir" && shasum -a 256 -c selected.sha256)
  mkdir "$download_dir/runtime"
  tar -xzf "$download_dir/$archive_name" --strip-components=1 -C "$download_dir/runtime"
  "$download_dir/runtime/bin/node" -e 'if (process.versions.node.split(".")[0] !== "22") process.exit(1)'
  mv "$download_dir/runtime" "$runtime_dir"
fi

export PATH="$runtime_dir/bin:$PATH"
export npm_config_cache="$task_dir/.cache/npm"
node --version
if node --input-type=module - <<'JS'
import fs from 'node:fs';
try {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  for (const [name, wanted] of Object.entries(manifest.dependencies || {})) {
    const installed = JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, 'utf8'));
    if (installed.version !== wanted || lock.packages?.[`node_modules/${name}`]?.version !== wanted) process.exit(1);
  }
  await import('playwright-core');
} catch { process.exit(1); }
JS
then
  echo "Reusing installed dependencies (manifest and lockfile versions match)."
elif [ -f package-lock.json ]; then
  npm ci --ignore-scripts --no-audit --no-fund
else
  npm install --ignore-scripts --no-audit --no-fund
fi

for state_dir in .session out .control; do
  if [ -e "$task_dir/$state_dir" ] && { [ ! -w "$task_dir/$state_dir" ] || [ ! -x "$task_dir/$state_dir" ]; }; then
    echo "Cannot access existing browser data: $task_dir/$state_dir" >&2
    echo "Restore ownership of this tool directory once from your normal terminal:" >&2
    printf 'sudo chown -R %s:%s %q\n' "$(id -un)" "$(id -gn)" "$task_dir" >&2
    echo "Then rerun this script without sudo; the saved session is preserved." >&2
    exit 1
  fi
done
npm test
exec node probe.mjs --control "$@"
