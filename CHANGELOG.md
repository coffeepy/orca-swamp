# Changelog

## Unreleased

## 0.2.0

- A workflow step, a job and a StageCraft stage show the description their author wrote, and a step shows a small label of what runs it, such as "shell" or "approval".
- A change of workspace shows what that workspace showed last at once and refreshes behind it; the Refresh icon turns while it does.
- The plugin is renamed from "Swamp" (`orca-swamp`) to "Swampling" (`swampling`), because Orca reserves ids that start with `orca-`. Its settings folder is now `~/.config/swampling/`; move `~/.config/orca-swamp/` there to keep your picks and theme.
- Workflows tab: the repo's own workflows first, then one group per extension.
- Workflows tab: a workflow's recent runs under its latest run.
- The "Factories" tab becomes "StageCraft": a searchable factory list, a grid of tickets by stage, status filters and recent runs.
- A stage that runs a workflow says so.
- The ticket screen shows the same stage grid as the factory view, and a click anywhere in a grid row opens the ticket.
- The repo you pick is kept for each workspace only.
- Reads StageCraft run records of schemaVersion 2.
- Fixed: a failed run that you retry with `swamp workflow resume --run` no longer continues to show as failed.
- Fixed: "Send failure" can no longer press Enter in the terminal when a run input or error has a line break.
- Fixed: two gates that wait at the same time each have their own note.
- Fixed: text you select in a log stays selected while the page has no change.
- A ticket with a run record version the panel cannot read is skipped with a warning, and the other tickets show.
- Adds the Swamp Club theme.
- Fixed: a workspace on a remote Orca server that Orca names but does not list now gets the remote repos. The panel picks the repo of the remote workspace with its name and branch, or you pick one and the panel remembers it.
- A workspace on a remote host is offered the repos of that host only, not the repos of this Mac.
- The panel remembers where you were in each repo. A switch back to a repo opens the same run, factory or ticket.
- The panel title is "Swampling".

## 0.1.0

First version, used from a local folder.

- Workflows list, run view with steps, logs, outputs and data, and parallel steps side by side.
- Approve and reject waiting steps, with automatic resume.
- Send a failed run to an agent terminal, and copy the retry command.
- StageCraft factories and work items, with approve and decline.
- Repos on remote hosts over SSH.
- Themes.
