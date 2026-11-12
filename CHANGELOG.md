# Changelog

## Unreleased

## 0.5.2

- A run that was left unfinished because swamp itself stopped (the computer restarted, or its terminal was closed) now reads "interrupted", like any interrupted run, and counts under the Failed chip. Before, it stayed "running · its process is gone" under Running, with a red dot, for as long as swamp listed it. Its screen says what happened in one sentence and offers Recover and resume, which continues it from its last checkpoint, and Run again. Discard, in place of Stop, cancels it so it leaves the Failed chip. This is known for repos on this Mac only; on a remote host such a run still reads as running.
- On a run's screen the button that starts a new run of the workflow reads "New run", not "Run", so it does not read as an action on the run that is open.

## 0.5.1

- A server that Orca reaches with a pairing code, not over SSH, works. On a workspace there the panel shows "Connect Swampling to" the server, with one field for an SSH login. The field holds the address Orca connects to, and the panel names the user ssh logs in as when you give none. Connect tries the login for 20 seconds at most, with Cancel, and then lists the swamp repos there. A workspace that Orca names goes straight to the repo when the login has one. "My repo is not listed" takes the repo's folder on the server, as a full path or one under `~`.
- When ssh cannot connect, the panel says why in plain words and what to do: the login asks for a password, this Mac has never connected to it, its host key changed, the name was not found, nothing answered, or it timed out. The command to run has a Copy button, and ssh's own message is under it. A login that failed is not saved. The same words replace the `ssh -o BatchMode=yes` hint for every remote repo.
- "No SSH login to this server yet?" under the form shows the three commands that put an SSH key on the server, with your login filled in.
- The gear menu lists your SSH logins, with Remove and "Add an SSH login…". Removing a login unpicks the repos picked on it and says so. When a saved login does not answer, the panel keeps your setup and offers Retry and "Change SSH login", which moves your picks to the new login. Logins are kept in `~/.config/swampling/settings.json` as `sshHosts`.
- With a server paired without SSH, a workspace on it is no longer offered the repos of this Mac. While Orca's server list cannot be read, the repos of this Mac are offered but a pick of one is not saved for remote workspaces.
- An answer that names a problem is kept for 10 seconds, so a server that is off no longer holds every workspace switch for the `orca` command's timeout. Refresh and Retry read again.
- An SSH name may hold letters, digits and `. _ - @ : % +` only. A name with another character, from Orca or from `pins.json`, is not used, and its entry stays in `pins.json`.
- `scripts/typecheck.sh` type-checks the plugin and its tests.

## 0.5.0

- Live log on a run's screen. A run that is running shows what it logs under its buttons, and new lines appear as swamp writes them, with no terminal. The view follows the newest line until you scroll up; then it stays where you are and "Jump to latest" takes you back. A click on a step shows that step's lines only. When the run ends the log stays, below the steps, and a failed run opens at its first error line when the log has one. The log opens on its newest lines and "Show earlier" pages back. Text in it can be selected, and Copy takes what is shown. Color codes a workflow prints are removed. Works for repos on remote hosts.
- Expected time, with a no-activity label. A workflow with three or more passed runs shows how long it usually takes ("usually 6m", the median of its latest passed runs). A running run shows how far along it is ("2m of about 6m") on its screen and its rows, and reads "longer than usual" once it takes twice the usual time. A run that showed no activity for longer than its usual time, and for 10 minutes at least, reads "no activity for 12m": no step began or ended, and for a repo on this Mac neither its record nor its log changed. That is not a failure; a long step that writes nothing reads the same. For a repo on this Mac, a run swamp still lists as running after its swamp process died reads "its process is gone", and Stop clears it. A StageCraft ticket whose work is in progress but recorded nothing for 2 hours reads "no activity · 3d" on the board and in "Why it is here", and counts as stuck, so the Stuck chip finds it.
- StageCraft: a ticket says why it is where it is. Its screen opens with "Why it is here": one sentence for what holds it (a person must decide a gate, it is parked at its dispatch cap, its work is in progress, its work failed or was interrupted, its work passed but nothing moved it on, or nothing was started), the reason the driver wrote when the work ended, how long it has been so, and what moves it. A ticket sent to a workflow stage has a button that opens that run. On the board, a ticket that does not move names why under its title ("failed · 4d", "interrupted · 4d", "not advanced · 7d", "idle · 3d", "parked · 2 of 2 tries"), and one that moves reads as before. A ticket whose last dispatch failed or was interrupted now counts as stuck, so the Stuck chip finds it.
- Run, stop and retry a workflow from the panel. A workflow's screen has Run, which asks for the workflow's inputs in a small form when it declares any (required ones marked, defaults filled in). A finished run has Run again, which starts a new run with the same inputs. A running, pending or waiting run has Stop, which asks once more before it cancels. A failed run has Retry failed steps, and each of its steps that ran has Retry from here. A run that was cut off has Recover and resume. A workflow that never ran has Run on its card. Each button says what it is doing, shows what swamp said when swamp refuses, and works for repos on remote hosts.

## 0.4.0

- Workflows tab: every run of the repo is listed, not the newest 6, under a heading for its workflow. Chips narrow the workflows and the runs together to running, failed, passed or waiting, and to today or this week, so "Running" leaves the workflows that have a running run and those runs. A sort button orders the runs by newest, oldest, longest or workflow name, and the workflow groups by their first run. The search also finds a run by any input, its id or its failed step. Each repo keeps its chips and sort.

## 0.3.0

- A "Needs you" tab lists every workflow gate and StageCraft ticket that waits for you, across all your repos on this Mac and on remote hosts. Approve, reject or decline there, or open the run or ticket in its own repo. The settings menu turns the tab off.

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
