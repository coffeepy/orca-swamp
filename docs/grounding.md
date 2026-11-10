# orca-swamp grounding: Orca plugin + swamp workflows + StageCraft

Goal (Brant). An Orca right-sidebar panel that shows swamp workflows and StageCraft
factories for the swamp repo of the focused Orca workspace, and lets him approve or
reject gates there. v1 is view + approve.

Evidence labels. **[doc]** read in `orca skills get orca-plugin-authoring` references
(Orca 1.4.251). **[src]** read in Orca's extracted `app.asar` or swamp/StageCraft source.
**[ran]** command output captured this session. **[inferred]** reasoning, not observed.

Sources:
- Orca refs, dumped to `docs/orca-refs/{SKILL,components,host-api,events,recipes,testing,workflow,manifest,cli}.md`.
- Orca main bundle, extracted to `scratchpad/asar/x/out/main/` (`index.js`, `plugin-host-entry.js`).
- swamp `20261101.180046.0-sha.d1bb1cf2` at `~/.local/bin/swamp`; skill docs `~/.agents/skills/swamp/references/workflow/`.
- Captured JSON: `src/fixtures/`.
- StageCraft: `~/.gemini/antigravity-cli/brain/9181fcd1-.../scratch/swamp-extensions/stagecraft/` (`SC/` below).

---

## Overview

The plugin is one program with two halves.

- **Panel** (`src/panel.tsx`, `"ui": "components"`). Orca draws a tree of semantic
  components. There are no hooks, no DOM, and no styles. State lives in atoms. It talks
  to the worker only through `plugin.request(name, input)` and `plugin.on(event, fn)`.
- **Worker** (`src/worker.ts`, `main`, `execution: "trusted-worker"`). A plain Node child
  process. It can `execFile` the `swamp` CLI, parse `--json`, and answer the panel.

swamp gives everything v1 needs as CLI JSON: workflows, run history with per-step status,
pending approvals, approve and reject. StageCraft work items are swamp data records
readable with `swamp data query --json`, and gates are decided with model methods.

The one hard gap is **the focused workspace's filesystem path**. `workspace.readContext`
does not return it. See How It Works §3.

---

## Key Concepts

**Orca execution profiles [doc manifest.md:11].** `data` < `declarative` <
`sandboxed-ui` < `trusted-worker`. It is "most authority the plugin needs... Contributions
beyond it fail validation". So a `trusted-worker` plugin may also carry lower contributions,
including `contributes.themes` and `statusBarItems` [inferred from that wording; not run
through `plugin validate`]. Anything that runs code needs user approval; Orca prints a
fingerprint and `--approve <fp>`. Never approve on the user's behalf [doc SKILL.md "Approval"].

**Components vocabulary [doc components.md].**
- `Tone = 'neutral'|'accent'|'success'|'warning'|'danger'`, `Gap = 'none'|'xs'|'sm'|'md'|'lg'`,
  `Size = 'xs'|'sm'|'md'`, `Variant = 'solid'|'outline'|'ghost'`.
- `IconName` (the same set for panel icons and status bar items): activity, bar-chart-3,
  bell, blocks, book, bot, bug, calendar, cloud, code, database, file-text, flag, folder,
  gauge, globe, hammer, layers, lightbulb, package, plug, puzzle, rocket, star, terminal,
  wrench, zap, add, remove, delete, edit, refresh, search, settings, check, close, info,
  warning, error, open-external, copy, download, upload, play, pause, stop, more, expand,
  collapse, next, filter, branch, file, agent, link.

Components relevant to this panel, with exact props:

| Component | Props |
|---|---|
| `Stack` / `Row` | `gap?, align?`; Row adds `justify?: 'start'\|'center'\|'end'\|'between'; wrap?` |
| `Box` | `direction, gap, padding(X/Y), align, justify, grow, scroll?: 'x'\|'y'\|'both', border?: boolean\|Tone, radius, background?: 'none'\|'muted'\|'card'\|Tone, width/height/min/max` |
| `Heading` | `level?: 1\|2\|3` |
| `Text` | `tone?, muted?, size?, weight?: 'regular'\|'medium'\|'semibold', truncate?` |
| `Badge` | `tone?` (children: text) |
| `Button` | `variant?, tone?, size?, icon?, tooltip?, disabled?, onPress?` |
| `IconButton` | `icon, label, tooltip?, variant?, tone?, size?, disabled?, onPress?` |
| `List` / `ListItem` | List `label?`; ListItem `title?, description?, icon?, current?, disabled?, onPress?` |
| `Tabs` / `Tab` | Tabs `label, value?, defaultValue?, onChange?`; Tab `value, label, icon?, disabled?` |
| `Collapsible` | `title, description?, open?, defaultOpen?, disabled?, onChange?` |
| `Card` | `title?, description?` |
| `Callout` | `tone?, title?, icon?` |
| `Table` | `label, columns, rows, sort?, selectionMode?, selected?, hasMore?, loading?, emptyText?, maxHeight?, onRowAction?...` |
| `Tree` | `label, items, selected?, expanded?, maxHeight?, onSelect?, onToggle?, onAction?` |
| `KeyValue` | `label?, items` |
| `Code` | `block?: boolean` (children text) |
| `CodeView` | `code, language?, label?, lineNumbers?, wrap?, maxHeight?` |
| `Markdown` | `content` |
| `Textarea` / `Input` | `label, value?, placeholder?, rows?, onChange?, onSubmit?...` (for a reject reason) |
| `Select` | `label, options: {value,label,disabled?}[], value?, onChange?` (repo / factory picker) |
| `EmptyState`, `Spinner`, `Skeleton`, `Progress`, `Separator`, `Toolbar`, `Grid` | see components.md |
| `RelativeTime` | `at: number, format?, tone?, muted?` (ticks by itself; never poll for time) |

Unknown props or enum values are dropped with a warning. An unknown component draws a
placeholder. Render limits: 5000 nodes, depth 64, 512 KiB data, 16 KiB per text
[doc components.md "Limits"].

**Atoms [doc components.md "Runtime"].** `atom(initial)` is per panel run.
`atom(key, initial, { persist })` is keyed and survives hot reload.
`PersistScope = 'memory'|'plugin'|'workspace'|'storage'`. `'storage'` is shared with the
worker via `storage:own`. `read(a)` while rendering subscribes. `set(a, v)` and
`update(a, fn)` both throw while rendering. `derived(() => ...)` computes from other atoms.
`export function setup(ctx: PanelContext)` runs once before the first render.
`ctx` is `{ subscriptions, signal, visible: ReadonlyAtom<boolean>, panel: { id } }`.

**swamp status enums [src swamp binary, `StepRunView` and run views].**
- Step: `"pending" | "running" | "waiting_approval" | "waiting" | "succeeded" | "failed" | "skipped" | "unknown"`.
- Run: `"pending" | "running" | "suspended" | "succeeded" | "failed" | "cancelled" | "interrupted"`.
- Job: assumed to use the step enum [inferred; a second enum block next to StepRunView matched it].
- `skipReason.kind: "dependency" | "guarded" | "job_skipped"`.
- `approval.status: "approved" | "rejected" | "timed_out"`, plus `approvedBy/At`, `rejectedBy/At`, `reason`.
- The docs say `completed` [execution-semantics.md:8], but the real JSON says
  `"status": "succeeded"` [ran]. Trust `succeeded`.

**StageCraft terms [doc SC/README.md].** A *factory* is a model of type
`@swamp/stagecraft/factory`. A *work item* is a model of type `@swamp/stagecraft/work-item`
named by its key (`team-1`). A *gate* with a person deciding is a *human stop*. Run record
`status` is `"active" | "terminal"` [src run_record.ts:235].

---

## How It Works

### 1. Panel ↔ worker

The contract is declared once in `src/protocol.ts` by declaration merging, and both sides
are typed from it [doc components.md "Panel ↔ worker contract"; scaffold `src/protocol.ts`]:

```ts
declare module 'orca' {
  interface PluginRequests { 'counter.add': { input: { by: number }; output: { total: number } } }
  interface PluginPanelEvents { 'counter.changed': { total: number } }
}
```

- Panel: `plugin.request(name, input, { signal, timeoutMs })`. The default timeout is 30 s
  and the maximum is 120 s. It starts the worker if needed. It rejects with
  `unknown_method`, `timeout`, `unavailable`, or the code the handler threw [doc recipes.md].
- Worker: `orca.panels.handle(name, async (input, { panel, signal }) => output)`.
  Answers are JSON, up to 1 MiB.
- Worker → panel: `orca.panels.post(event, payload, { panel? })` goes to every open panel,
  or to one. Limits are 256 KiB per post and 200 posts per 10 s. The panel listens with
  `plugin.on(event, fn)`, pushed into `ctx.subscriptions` [doc recipes.md].
- Lifecycle: `export default function activate(orca)` is required; a named export is never
  called. An optional `deactivate()` is awaited. **An idle worker stops** and restarts on
  its next command, event, or panel request. A save restarts the worker and drops
  in-memory state, so keep caches in `orca.storage` [doc recipes.md, SKILL.md "Gotchas"].
- A plugin with `main` and `statusBarItems` keeps its worker running while it is enabled,
  so the worker can poll and call `statusBar.update` [doc host-api.md `statusBar.update`].

### 2. The worker process: child processes and PATH

[src `index.js`] Orca starts the worker with
`child_process.fork(plugin-host-entry.js, [], { env: fQr(), execArgv: [], serialization: 'advanced', stdio: ['ignore','pipe','pipe','ipc'] })`.
- There is no `--experimental-permission` and no module allowlist in
  `plugin-host-entry.js`. `import { execFile } from 'node:child_process'` works.
  **No Orca capability gates it**, because capabilities cover only `host.call` methods
  [src; host-api.md "Capabilities" lists none for processes]. Worker stdout and stderr
  are piped into `orca plugin logs`.
- The worker env is an **allowlist**:
  `PATH, HOME, USERPROFILE, LANG, LC_ALL, LC_CTYPE, TZ, TMPDIR, TEMP, TMP, SYSTEMROOT, ...`
  plus `ELECTRON_RUN_AS_NODE=1`. Any `SWAMP_*` variable or vault credential from Brant's
  shell does **not** reach the worker.
- PATH: Orca was launched by launchd with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` [ran `ps eww`].
  A packaged Orca then patches `process.env.PATH` at startup (`jjn()`). It appends
  `/opt/homebrew/bin`, `/usr/local/bin`, `~/bin`, `~/.local/bin`, `~/.nix-profile/bin`,
  and others, plus login-shell entries [src index.js]. So `swamp` should resolve
  [inferred; not run inside a live worker]. Still call it by absolute path
  (`path.join(os.homedir(), '.local/bin/swamp')`) with a PATH fallback.
- Pass `cwd: repoDir` or `--repo-dir <dir>`. Outside a repo, swamp prints
  `{"error":"Not a swamp repository: ..."}` [ran]. A repo root holds `.swamp.yaml` [ran].

### 3. Finding the focused workspace's path (the gap)

[doc host-api.md, events.md]
- `workspace.readContext` (worker, panel; `workspace:read`) returns
  `{ branch: string; displayName: string; terminals: { id: string; title?: string }[] } | null`.
  **It has no path.**
- `workspace.list` (worker only; `workspace:read`; since 1.3) returns
  `{ workspaces: { id; kind: "worktree"|"folder"; name; path; branch: string|null; hostId: string|null }[]; truncated }`.
  **It has no "focused" flag.**
- `workspace.changed` (worker via `contributes.events`, or a panel via `on(...)`) has the
  payload `{ context: <readContext answer> | null }`. It fires once on subscribe, then on
  focus change and on terminal open, close, or rename.
- Matching on name or branch alone is ambiguous. On this machine, `orca worktree list` has
  58 worktrees, and several share `(displayName, branch)`, for example `('main','refs/heads/main')`
  and `('master', ...)` [ran]. Also, the CLI reports `branch` as `refs/heads/main`. Whether
  `workspace.list` and readContext use `refs/heads/...` or a short name is unverified.
- `orca worktree show --worktree active` resolves from the **current directory**, not the
  UI focus. From `~` it returned `selector_ambiguous` [ran]. It is not a focus oracle.
- Candidate fix [inferred, needs a prototype]. `orca terminal list --json` gives each
  terminal `worktreePath` [ran]. If readContext's `terminals[].id` equals that list's
  `handle`, the focused path is
  `terminals.find(t => t.handle === ctx.terminals[0].id).worktreePath`. The worker would
  get that by `execFile` of `/Applications/Orca.app/Contents/Resources/bin/orca`.
  This fails for a focused workspace with no terminals.
- Recommended v1 resolution order [inferred]:
  1. Match readContext to `workspace.list` by name/displayName plus branch, keeping
     only candidates whose `path` contains `.swamp.yaml`.
  2. If more than one remains, use the terminal-handle lookup above.
  3. Otherwise show a `Select` of swamp repos from `workspace.list`, and remember the choice
     per workspace (`atom(key, …, { persist: 'workspace' })`).
  Verify with `orca plugin dev request` once the plugin is approved.

### 4. Reading swamp (all run in swipenews-factory) [ran]

`swamp workflow search --json` (0.8 s):
```json
{ "query": "", "results": [ { "id": "3183ce29-…", "name": "issue-factory", "description": "…",
  "jobCount": 1, "stepCount": 8, "hasInputs": true,
  "trigger": { "inputs": { "issueId": "${{ … }}" } } } ] }
```

`swamp workflow get issue-factory --json`. Top-level keys are
`id, name, description, version, inputs, trigger, tags, reports, jobs, path`.
```json
{ "jobs": [ { "name": "factory", "description": "…", "dependsOn": [], "steps": [
  { "name": "intake", "dependsOn": [], "task": { "type": "model_method", "modelIdOrName": "factory-intake", "methodName": "prepare", "inputs": {…} } },
  { "name": "assert-quality", "dependsOn": [ { "step": "quality-gate", "condition": { "type": "succeeded" } } ],
    "task": { "type": "assert", "expr": "…", "message": "…", "severity": "high" } },
  { "name": "human-signoff", "dependsOn": [ { "step": "assert-adversary", "condition": { "type": "succeeded" } } ],
    "task": { "type": "manual_approval", "prompt": "High-risk change detected …" } },
  { "name": "ship", "dependsOn": [ { "step": "assert-adversary", "condition": { "type": "succeeded" } },
    { "step": "human-signoff", "condition": { "type": "or", "conditions": [ { "type": "succeeded" }, { "type": "skipped" } ] } } ] }
] } ] }
```
Task types seen: `model_method`, `assert`, `manual_approval`. Others such as
`wait_for_signal` exist per the docs.

`swamp workflow history search --json` (2.7 s, the slowest). Filters are
`--workflow <name>`, `--input K=V`, and `--filter '<CEL>'`.
```json
{ "query": "", "results": [ { "runId": "ee6e9038-…", "workflowId": "3183ce29-…", "workflowName": "issue-factory",
  "status": "succeeded", "startedAt": "2026-10-26T19:25:08.936Z", "completedAt": "…", "duration": 3963,
  "tags": {…}, "inputs": { "issueId": "ISSUE-101", "mode": "fast", "risk": "" },
  "triggerSource": "manual", "stepProgress": { "completed": 8, "total": 8 } } ] }
```

`swamp workflow history get issue-factory --json` returns the latest run, or takes a run id.
This is the per-step source. Top-level keys are
`id, workflowId, workflowName, inputs, status, jobs, startedAt, completedAt, duration, path, workflowDataArtifacts, initiatedBy` (`"user:coffeepy"`).
```json
{ "jobs": [ { "name": "factory", "status": "succeeded", "startedAt": "…", "completedAt": "…", "duration": 3950, "steps": [
  { "name": "intake", "status": "succeeded", "startedAt": "…", "completedAt": "…", "duration": 191,
    "dataArtifacts": [ { "dataId": "8b87…", "name": "intake", "version": 1, "tags": {…} } ] },
  { "name": "assert-quality", "status": "succeeded", "duration": 15,
    "assertResult": { "passed": true, "expr": "…", "message": "…", "severity": "high" } },
  { "name": "human-signoff", "status": "skipped", "completedAt": "…",
    "skipReason": { "kind": "guarded", "expression": "data.latest(\"factory-intake\", \"intake\").attributes.risk != \"high\"" } }
] } ] }
```
Other step fields from the source [src StepRunView] are `error?, errorCode?, outputId?,
allowedFailure?, approval?: ApprovalView, outputs?, failureKind?: "workflow_changed", nestedRun?`.
Only one run exists in this repo, and it succeeded. **No suspended run was available to
capture.** The `waiting_approval` shape comes from source, not output.

`swamp workflow history logs issue-factory --json` returns `{ "path", "lines": string[], "lineCount" }`.
Lines look like `"2026-10-26T19:25:09.055Z [INF] model·method·run·factory-intake·prepare: \"…\""`
and **contain raw ANSI escapes** (`\x1b[0m\x1b[32m…`). Strip them before display.

`swamp workflow approvals --json` returned `{ "approvals": [], "expired": [] }` [ran].
The entry shape [src `interface PendingApproval`] is:
```ts
{ workflowId: string; workflowName: string; runId: string; stepName: string;
  suspendedAt: string | undefined; prompt: string | undefined; inputs: Record<string, unknown>;
  initiatedBy?: string; parentRun?: { workflowId; … }; parentWaiting?: boolean;
  parentEnded?: boolean; parentMissing?: boolean; /* plus a serve-started flag */ }
```
`expired` lists gates past their `timeout`. Those can only be cancelled, not decided
[doc swamp workflow reference.md:936-941].

### 5. Deciding swamp gates (help only; nothing was run)

```
swamp workflow approve <workflow_id_or_name> <step_name> [--run <run_id>] [--reason <r>] [--json] [--repo-dir <dir>] [--server <url> --token …]
swamp workflow reject  <workflow_id_or_name> <step_name> [--run <run_id>] [--reason <r>] [--json] [--repo-dir <dir>] [--server <url> …]
swamp workflow resume  <workflow_id_or_name> [--run <run_id>] [--input k=v] [--json]
```
**Approving does not continue the run locally.** The run stays `suspended` until
`swamp workflow resume <wf> --run <id>` [doc execution-semantics.md "Suspension and Resume"].
Under `swamp serve` with `autoResume: true`, serve resumes it itself. A local approval on a
filesystem datastore is picked up within `--continuation-sweep-interval` (30 s).
issue-factory sets `autoResume: true` [ran grep]. Reject marks the run `failed`, and other
waiting gates fail with `cancelled`. Always pass `--run <runId>` from the approvals list,
because several runs can be suspended at once.

### 6. StageCraft

**Verified 2026-11-07** against swamp 20261101 and StageCraft 2026.10.31.1, added to a scratch repo
with `swamp extension source add <stagecraft checkout>` [ran]. Where this differs from the notes below:
- Detect it with `swamp model type search stagecraft --json` (about 1.2 s): `results` lists
  `@swamp/stagecraft/factory` when installed and is empty otherwise. `swamp extension list` misses an
  extension added with `extension source add`, so it is not a reliable check [ran].
- `swamp data query 'modelType == "@swamp/stagecraft/work-item" && modelName == "<key>" && !name.startsWith("report-")'`
  returns one work item's `run`, `definition` (the pinned copy), `artifact-*`, `evidence-*` and `metrics`
  in one call. `metrics.summary` holds review rounds and dispatch counts [ran].
- `approve` records the decision but does not move the work item. `advance --input transition=<exit>`
  does. The panel runs both on one press [ran].
- A dispatch past the cap writes an `awaiting` event with `exits: []` and `dispatchOverride` (parked) [ran].
- `status --json` carries no structured status, only the text in the log [ran].
- `studio serve` prints `studio: http://127.0.0.1:<random port>/` within about 2 s, but only without
  `--json` [ran]. Its `/api/work-items?factory=` answered a plain `curl` from the same machine, so
  "page-only" is about origin checks, not every request [ran]. The panel still never fetches it.
- Notes and other inputs go as `--input name:json=<JSON>`, because a plain value starting with `@` is
  read as a file path [doc driving.md; ran with a note starting with `@`].

**Not installed in any of Brant's repos.** `grep -rl stagecraft ~/develop/*/.swamp* ~/develop/*/*/.swamp*`
found nothing [ran]. swipenews-factory's models are only `@coffeepy/*` [ran `swamp model search`].
Everything below comes from the source and docs and was not run.

- **List factories**: `swamp model search --json`, filtered to
  `type === "@swamp/stagecraft/factory"`. The studio's remote mode does exactly this
  [src studio_remote.ts:321-331]. The result shape is `{ query, results: [{ id, name, type, methods, … }] }` [ran on @coffeepy].
  The factory definition lives at `models/@swamp/stagecraft/factory/<name>.yaml` under `globalArguments.definition`.
- **List work items** (the Board's data source) [src studio_work_items.ts:67-76]:
  ```
  swamp data query 'modelType == "@swamp/stagecraft/work-item" && name == "run" && attributes.factory == "<factory>"' --json
  swamp data query 'modelName == "<key>" && name == "run"' --json      # one work item
  ```
  Each result's `content` is the run record [`data query` envelope ran:
  `{ predicate, results: [{ id, name, version, isLatest, modelName, modelType, tags, content, … }] }`].
  The studio dedups by key and keeps the record with the latest `journal.at(-1).at`.
  Filtering on `isLatest` should do the same [inferred].
- **Run record fields** [src run_record.ts:213-253]: `key, title?, externalRefs, tracker,
  factory, definition{digest,version?}, era, status: "active"|"terminal", stage,
  entries: Record<stage, n>` (the current cycle is `entries[stage]`), `products`,
  `validations`, `dispatches[]`, `approvals[]` (each
  `{ id, gateId, decision: "approve"|"decline", note?, era, stage, cycle, at, actor, products }`),
  `overrides`, and `journal[]`.
- **Waiting on a person**: the **latest `awaiting` journal event** holds it
  [src journal.ts:173-185, awaiting.ts]. An empty `exits` means nobody is waited on.
  ```ts
  { type: "awaiting", at, …, exits: { transition: string; to: string; manual: boolean; gateIds: string[]; readyAt?: string }[],
    dispatchOverride?: { count; limit; granted; interruptions? } }
  ```
  The Board card is derived from this [src studio_cards.ts `BoardCard`]:
  `{ key, title, trackerRef, status, stage, cycle, enteredAt, waiting: { since, exits: CardExit[] } | null, parked: Park[], pinnedDigest, problem? }`.
- **`status` method**: `swamp model @swamp/stagecraft/work-item method run status <key>`.
  It **writes no data** (`return { dataHandles: [] }`). It logs text lines and attaches the
  structured view as the log property `status` [src work_item_ops.ts:1175-1185]. Getting
  that as JSON would mean parsing log properties (`--show-properties`?), which is unverified.
  **Use the run record from `data query`.** You still need `status` once for
  `expectedStage/Cycle/Era`, but those are also the run record's `stage`,
  `entries[stage]`, and `era` [inferred from REFERENCE.md "Running it"].
- **Approve / decline** [src engine/work_item.ts:334-360; doc driving.md:662-670]:
  ```
  swamp model @swamp/stagecraft/work-item method run approve <key> \
    --input gateId=<gate-id> --input note="<their words>" --input onBehalfOf=<person> \
    --input expectedStage=<stage> --input expectedCycle=<cycle> --input expectedEra=<era>
  # decline: same inputs, method `decline`
  ```
  The schema is `{ gateId: string(min 1); note?: string; expectedStage; expectedCycle: number;
  expectedEra; onBehalfOf? }`. A stale `expected*` value is refused, and nothing is written.
  A tracker-bound work item should then be published with
  `swamp workflow run @swamp/stagecraft/publish --input tracker=<tracker> --input workItem=<key>` [doc driving.md].
- **`studio serve` URL**: `swamp model method run studio serve [--input port=8123]`.
  It logs `studio: http://127.0.0.1:${port}${basePath ?? ""}/` and runs until Ctrl-C
  [src studio_serve.ts:258-271]. Board view is `/f/<factory>/board`. A work item is `/w/<key>`.
  JSON endpoints are `GET /api/work-items?factory=<name>`, `/api/work-items/<key>`,
  `/api/work-items/<key>/ticket`, and `/api/tickets?factory=<name>`. The server
  "answers only requests addressed to it from its own page" [doc REFERENCE.md "The studio"],
  so calling them from the worker is probably refused [inferred].

### 7. Other Orca surfaces

- **Notifications**: `notifications.show({ title, body? }) → { delivered }`. It needs
  `notifications:show` and works from the worker or the panel [doc host-api.md].
- **Status bar**: declare `contributes.statusBarItems: [{ id, text?, icon?, tone?, tooltip?, command? }]`
  (`engines.orca >= 1.4.248`; `command` must be one of the plugin's own `contributes.commands`).
  The worker calls `orca.host.call('statusBar.update', { id, text?, icon?, tone?, tooltip?, visible? })`.
  It needs no capability. It is desktop only and lasts until restart [doc host-api.md, recipes.md].
- **Panel theming**: a components panel **cannot set colours**. It has no `className` or
  `style`. Colour comes only through `tone` (`Badge`, `Text`, `Button`, `Callout`) and
  `Box border`/`background` tones. It follows Orca's theme automatically, and `env.theme`
  or `on('theme')` gives `colorScheme`. An HTML panel (`ui: "html"`) can style freely
  from `--orca-*` CSS variables [doc host-api.md "Theme variables in frames"].
- **App theme in the same plugin**: `contributes.themes: [{ id, title, path }]`, where each
  path is a JSON theme file of at most 16 KiB [doc manifest.md:109-115]. Allowed under
  `trusted-worker` [inferred, §Key Concepts]. The theme file format comes from
  `orca plugin create … --template theme`, which was not read. Alternatively, a worker can
  push colours with `appearance.apply` (`appearance:write`).
- **Manifest today** (`~/develop/orca-swamp/orca-plugin.json`): `trusted-worker`,
  `main: src/worker.ts`, one panel `{ id: "orca-swamp", title: "Swamp", icon: "blocks",
  entry: "src/panel.tsx", ui: "components" }`, capabilities `[storage:own]`.
  v1 needs at least `workspace:read`, plus `contributes.events: [{ on: "workspace.changed" }]`
  if the worker tracks focus. A panel can `on('workspace.changed')` without a `contributes.events` entry.

### 8. Testing [doc testing.md, workflow.md]

- `orca plugin test [dir] --json` runs `*.test.ts(x)` under `node:test`.
  It prints `{ ok, result: { runner, code, node, files } }`.
- `orca plugin check [dir] --json` validates, mounts the worker, and renders each panel once
  per scenario in `src/panel.check.ts` (`defineCheck({ name: MockHostOptions & { persisted?, theme?, events? } })`).
  Exit codes are 0 ok, 1 `plugin_check_failed`, 2 invalid. A scenario's `requests` stubs a
  worker handler; any other request reaches the real worker, which in check would really
  `execFile` swamp.
- `orca plugin shot <key|dir> [--panel id] [--theme light|dark] [--width px] [--act '<json>' | --scenario <name>] --json`
  writes a PNG of the panel. It needs Orca's window hidden or minimized for `--theme`, `--act`, and `--scenario`.
- `orca plugin dev watch <dir> --check --shot <dir> --json` streams reloads.
  `orca plugin dev request <dir> <name> --data '<json>'` calls a worker handler.
  `orca plugin dev emit <dir> workspace.changed --data '…'` fires an event.
- `mount(panelModule, { host: mockHost({...}), persisted, theme, panelId })` returns a `TestPanel`
  with `find/findAll({ type|role|text|label|testId })`, `press`, `type`, `select`, `toggle`,
  `post(event, payload)`, `emit(event, payload)`, `summary()`, `tree()`, and `errors/warnings/refusals`.
- `mountWorker(workerModule, { host, events, commands })` returns a `TestWorker` with
  `request(name, input, { panel })`, `emit`, `posts`, `logs`, `refusals`, and `deactivate()`.
- `mockHost({ capabilities, results: { 'workspace.readContext': {...}, 'workspace.list': {...} }, requests, storage, settings, secrets })`.
  It refuses what Orca refuses (`capability_denied`, `invalid_params`, `not_permitted`).
- To test without spawning swamp, have the worker take an injectable runner, for example a
  module-level `run = execFileJson` that tests replace [inferred design note].

---

## Where Things Live

| What | Path |
|---|---|
| Plugin scaffold | `~/develop/orca-swamp/{orca-plugin.json, src/protocol.ts, src/worker.ts, src/panel.tsx, src/panel.check.ts, src/*.test.ts*}` |
| Orca plugin refs (dumped) | `docs/orca-refs/*.md` |
| Orca worker launcher / env allowlist / PATH patch | `scratchpad/asar/x/out/main/index.js` (`xQr`, `fQr`, `dQr`, `jjn`) |
| Orca worker runtime | `scratchpad/asar/x/out/main/plugin-host-entry.js` |
| Orca CLI | `/Applications/Orca.app/Contents/Resources/bin/orca` |
| swamp binary | `~/.local/bin/swamp` |
| Sample swamp repo | `~/develop/swamp-factory-demo/swipenews-factory` (`.swamp.yaml`, `workflows/workflow-issue-factory.yaml`, `.swamp/workflow-runs/<wfId>/workflow-run-<runId>.{yaml,log}`) |
| Other swamp repos | `~/develop/health-monitor`, `~/develop/sdk-generator` |
| swamp workflow docs | `~/.agents/skills/swamp/references/workflow/{reference.md, references/execution-semantics.md}` |
| StageCraft docs | `SC/README.md`, `SC/REFERENCE.md` ("Running it", "The studio"), `SC/.claude/skills/stagecraft/references/driving.md` ("Human stops") |
| StageCraft read code | `SC/extensions/models/_lib/engine/{studio_work_items.ts, studio_cards.ts, run_record.ts, journal.ts, awaiting.ts, studio_serve.ts, studio_remote.ts, work_item_ops.ts}` |
| StageCraft methods | `SC/extensions/models/engine/work_item.ts` |
| Captured JSON | `src/fixtures/` |

---

## Gotchas

1. **No workspace path from Orca's API.** readContext has none, workspace.list has no focus
   flag, and `(displayName, branch)` collides across repos ("main"). See §3.
2. **Worker env is an allowlist.** Shell `SWAMP_*` vars, tokens, and vault env never arrive.
   PATH is Orca's patched PATH, not your zsh PATH. Use the absolute swamp path.
3. **Approve ≠ continue.** Locally, `approve` leaves the run `suspended`. Either run
   `resume --run <id>` or rely on serve's `autoResume`. Decide this explicitly for v1, and
   show "approved, awaiting resume" as its own state.
4. **`workflow get --json` drops fields.** The YAML's `guard:` on human-signoff and the
   top-level `autoResume: true` are absent from the JSON [ran]. Read the YAML (`path` is
   given) when the panel needs them.
5. **Docs vs reality on run status.** Docs say `completed`; JSON says `succeeded`. The
   source also has `interrupted` and `pending` run states. Render unknown statuses
   generically.
6. **Slow CLI.** Measured 0.8 s for search, 1.3 s for approvals, and 2.7 s for history
   search [ran]. Don't fan out per workflow on every refresh. Cache in the worker, push
   with `panels.post`, and keep `plugin.request` under its 30 s default.
7. **Idle worker stops.** In-memory caches and timers die. Either add a status bar item,
   which keeps the worker alive, or poll from the panel only while `ctx.visible` is true.
8. **Logs carry ANSI escapes.** Strip them before `CodeView`/`Code`.
9. **Gate step name ≠ run.** `approve <workflow> <step>` without `--run` targets the latest
   suspended run. Always pass `--run` from the approvals entry.
10. **Expired gates** appear in `expired`, cannot be approved, and only cancel works.
11. **StageCraft is not installed locally.** No live data exists to test against. The
    `status` method returns no JSON data, so read run records via `data query`. Approve
    needs `expectedStage/Cycle/Era` and is refused when stale. driving.md says never to
    approve without the person's explicit word, so the panel's button press is that word,
    and `onBehalfOf` should name Brant.
12. **Studio API is page-only.** It answers only requests from its own page, so don't plan
    on calling `/api/work-items` from the worker [doc; inferred refusal].
13. **Components panel has no colours of its own.** Only tones. Use an HTML panel only if
    custom styling is a hard requirement.
14. **`orca plugin types` is broken in 1.4.251** (per brief). `tsc -p .` will fail on the
    `orca` imports. Rely on `plugin check`/`plugin test` for validation, or hand-write a
    minimal `orca.d.ts` shim [inferred].
15. **zsh gotcha when scripting**: `echo ===` errors under zsh EQUALS expansion. Harmless,
    but it broke one capture command.
