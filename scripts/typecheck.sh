#!/bin/sh
# Type-checks every file under src, tests included, which `orca plugin test` does not: it runs the tests untyped.
# Needs Orca on this machine for the plugin API types (`orca plugin types .` writes them to .orca/types, which git
# ignores), so CI cannot run it. TypeScript and Node's types are installed once into a folder outside the repo.
# Usage: scripts/typecheck.sh
set -eu
cd "$(dirname "$0")/.."
repo=$(pwd)

[ -f .orca/types/tsconfig.json ] || orca plugin types .

tools=${SWAMPLING_TYPECHECK_DIR:-${TMPDIR:-/tmp}/swampling-typecheck}
[ -x "$tools/node_modules/.bin/tsc" ] || npm install --silent --no-audit --no-fund --prefix "$tools" typescript@5.9.3 @types/node@22.20.5

cat > "$tools/tsconfig.json" <<JSON
{
  "extends": "$repo/tsconfig.json",
  "compilerOptions": {
    "typeRoots": ["$repo/.orca/types", "$tools/node_modules/@types"],
    "types": ["orca", "orca-host", "orca-frame", "orca-worker", "orca-services", "orca-testing", "node"]
  },
  "include": ["$repo/src"]
}
JSON
"$tools/node_modules/.bin/tsc" --noEmit -p "$tools/tsconfig.json"
echo "types ok"
