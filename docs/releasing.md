# Releasing

Each new `version` in `orca-plugin.json` that reaches `main` becomes a release. Orca installs the newest `vX.Y.Z` tag of this repository, so each release is a version that people can install.

1. Set `version` in `orca-plugin.json`.
2. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z` and add an empty `## Unreleased` above it.
3. Run `orca plugin validate .` and `orca plugin test .` on a machine with Orca. CI cannot run the tests, because they need files that only Orca ships.
4. Merge to `main`. The Release workflow makes the tag `vX.Y.Z` and a GitHub release with the changelog section as its notes.

A push to `main` that does not change the version releases nothing.

To install one version: `orca plugin install coffeepy/swampling@vX.Y.Z`. To get the newest: `orca plugin update coffeepy.swampling`.
