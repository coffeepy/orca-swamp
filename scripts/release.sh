#!/bin/sh
# Runs every release check on this machine, then makes the tag. The tests need Orca, which CI does not have,
# so this script is the test gate. It does not push: the push of the tag starts the release workflow.
# Usage: scripts/release.sh
set -eu
cd "$(dirname "$0")/.."

[ "$(git branch --show-current)" = main ] || { echo "release from main" >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "commit or stash your changes first" >&2; exit 1; }
git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main is not the same as origin/main" >&2; exit 1; }

scripts/version-check.sh > /dev/null
version=$(node -p "require('./orca-plugin.json').version")
orca plugin validate .
orca plugin test .

git tag -a "v$version" -m "v$version"
echo "Tagged v$version. To release it: git push origin v$version"
