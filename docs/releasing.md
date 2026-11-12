# Releasing

Each new `version` in `orca-plugin.json` that reaches `main` becomes a release. Orca installs the newest `vX.Y.Z` tag of this repository, so each release is a version that people can install.

1. Set `version` in `orca-plugin.json`.
2. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z` and add an empty `## Unreleased` above it.
3. Run `orca plugin validate .`, `orca plugin test .` and `scripts/typecheck.sh` on a machine with Orca. CI cannot run the tests or the type check, because they need files that only Orca ships.
4. Merge to `main`. The Release workflow makes the tag `vX.Y.Z` and a GitHub release with the changelog section as its notes.

A push to `main` that does not change the version releases nothing.

To install one version: `orca plugin install coffeepy/swampling@vX.Y.Z`. To get the newest: `orca plugin update coffeepy.swampling`.

## Before a merge

Run `scripts/typecheck.sh` before every merge to `main`, not only for a release. `orca plugin test .` runs the tests without checking types, so a type error can pass 200 green tests. The script needs the plugin API types that `orca plugin types .` writes to `.orca/types`, which git ignores, so a CI runner without Orca cannot run it. It installs TypeScript and Node's types into a temp folder on first use, and adds no dependency to the repo.
