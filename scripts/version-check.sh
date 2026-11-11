#!/bin/sh
# Checks that the manifest version, the changelog and (when given) the tag agree, then prints that version's
# changelog section. CI runs it on every push; the release workflow uses its output as the release notes.
# Usage: scripts/version-check.sh [tag]
set -eu
cd "$(dirname "$0")/.."

version=$(node -p "require('./orca-plugin.json').version")
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "orca-plugin.json: version '$version' is not X.Y.Z" >&2; exit 1; }

if [ $# -gt 0 ] && [ "$1" != "v$version" ]; then
  echo "tag $1 does not match orca-plugin.json version $version (expected v$version)" >&2
  exit 1
fi

notes=$(awk -v h="## $version" '$0 == h { on = 1; next } /^## / { on = 0 } on' CHANGELOG.md)
[ -n "$notes" ] || { echo "CHANGELOG.md has no '## $version' section with entries" >&2; exit 1; }
echo "$notes"
