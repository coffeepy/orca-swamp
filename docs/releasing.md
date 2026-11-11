# Releasing

Orca installs the newest `vX.Y.Z` tag of this repository, so a tag is a release.

1. Set `version` in `orca-plugin.json`.
2. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z` and add an empty `## Unreleased` above it.
3. Commit and merge to `main`.
4. Run `scripts/release.sh` on a machine with Orca. It checks the version, runs `orca plugin validate` and the tests, then makes the tag.
5. Run `git push origin vX.Y.Z`. The Release workflow checks the tag and publishes a GitHub release with the changelog section as its notes.

CI (`.github/workflows/ci.yml`) checks the manifest version and the changelog on each push. It cannot run the tests, because they need files that only Orca ships. `scripts/release.sh` is the test gate.
