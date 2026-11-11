# Architecture

Notes for people who work on the plugin. For what it does and how to install it, see the [README](../README.md).

A right-sidebar panel that shows the swamp workflows of the focused workspace's repo, lets you approve or reject waiting gates, and hands a failed run to an agent terminal. The panel is an HTML page (`src/app.ts`, styled from Orca's `--orca-*` theme variables) that polls its worker (`src/worker.ts`) every 10 s, or every 2 s while a run is moving. The worker runs `~/.local/bin/swamp --json` (`src/swamp.ts`) and parses its output (`src/domain.ts`); `src/present.ts` holds the pill, time and command strings the page shows. `src/repo.ts` finds the focused workspace's folder through one of its terminals (`orca terminal show`), finds the repo at or above that folder or registered below it, and a repo picked in the panel is remembered per workspace folder in `~/.config/swampling/pins.json`. A workspace with no terminal is matched by name and branch; when several share them, the panel asks instead of guessing. After an approve, the worker starts `swamp workflow resume --run <id>` in the background. The panel keeps the last place (tab, run, factory or ticket) of each repo in its `localStorage`, for the 20 repos used last, so a switch back to a repo opens where you were.

A workspace change shows the last known answer at once and asks again behind it; the Refresh icon turns meanwhile. The panel keeps each workspace's last resolution in `localStorage` (the 20 used last) and each repo's last read data in memory (the 10 left last), and puts a repo's data away whenever another repo takes the screen, so one repo's data never shows under another's header. The worker remembers its slow lookups for its life: swamp's workspace registry (read again behind an answer once it is 30 s old), the workspace of each terminal, and the remote repos (60 s, never an answer with a problem). The registry is read while Orca and the remote hosts are asked. The Refresh button sends `repo.resolve` with `fresh: true`, which reads all of them again. A workspace never seen shows "Loading…" as before.

Repos on remote hosts work too. For a focused workspace on a remote Orca server, Orca answers `workspace.readContext` with null, or with a name that `workspace.list` does not hold. In the two cases the panel asks the `orca` CLI (`src/remote.ts`) for every saved server's workspaces and the SSH host Orca deployed each server through, finds their swamp repos over SSH in one call per host, and offers them in the picker. While a remote host is paired, such a workspace is offered the remote repos only, not the repos of this Mac. With a name, the one remote workspace of that name and branch gives the repo without a pick, and a pick is remembered for that name; with null, the pick is remembered for all remote workspaces. Every swamp call for a remote repo runs as `ssh -o BatchMode=yes <host> sh -s` with the script on stdin and each argument quoted for `sh`, so a csh or fish login shell never parses a value; calls share one connection per host for a minute. A host that needs a password or key prompt shows the exact `ssh` command to try. Studio is off for remote repos (it would need a port forward), and Send failure needs a terminal Orca names, which it does not for remote workspaces.

A Factories tab shows StageCraft factories (`src/stagecraft.ts` parses them). It checks for the extension with `swamp model type search stagecraft`, and a repo without it gets an explainer with the install command instead of an error. The board reads every work item's `run` record with one `swamp data query`; a work item's page reads its run, pinned definition, products and metrics with another. Approve runs the work item's `approve` method on the person's behalf and, when that was the last gate the exit waited on, `advance` on that exit; Decline runs `decline`. Studio starts `studio serve` (creating the studio model on first use) and opens the URL it logs in the browser.

`orca plugin test .` runs the tests against captured swamp JSON in `src/fixtures/`.


## Files the plugin writes

- `~/.config/swampling/pins.json` holds the repo picked for each workspace.
- `~/.config/swampling/settings.json` holds the theme.
- `~/.config/swampling/ssh/` holds the shared SSH connection sockets for remote repos.

## Environment overrides

- `SWAMPLING_BIN` sets the swamp binary.
- `SWAMPLING_PINS` sets the pins file. The settings file sits beside it.

## Develop

```sh
orca plugin validate .
orca plugin test .         # runs the tests against captured swamp JSON in src/fixtures/
orca plugin dev watch .    # loads this folder into Orca and prints its logs and reloads; Ctrl-C unloads it
```

Orca names the publisher after where the plugin is installed from: the GitHub or GitLab owner of
its repository, or `local` for a folder. See
https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md.
