import { repoKey, type RecentRun, type Repo, type RepoDir, type Run, type RunAction, type RunId, type RunStatus, type SshHost, type Step } from './domain'
import type { InboxItem } from './inbox'
import type { RepoChoice, Resolution } from './repo'
import type { Pace } from './pace'
import type { Dispatch, Product, Reason, Stage, TicketStatus, WorkItem } from './stagecraft'

export type Tone = 'ok' | 'fail' | 'run' | 'wait' | 'warm' | 'muted'
export type Pill = { tone: Tone; text: string }

const RUN_LOOK: Record<RunStatus, Pill> = {
  pending: { tone: 'muted', text: 'Pending' },
  running: { tone: 'run', text: 'Running' },
  suspended: { tone: 'wait', text: 'Waiting' },
  succeeded: { tone: 'ok', text: 'Passed' },
  failed: { tone: 'fail', text: 'Failed' },
  cancelled: { tone: 'muted', text: 'Cancelled' },
  interrupted: { tone: 'muted', text: 'Interrupted' },
  unknown: { tone: 'muted', text: 'Unknown' }
}

export const runLook = (status: RunStatus): Pill => RUN_LOOK[status]

export const stepsOf = (run: Run): Step[] => run.jobs.flatMap((j) => j.stages.flat())

/** "Waiting · 7/8": steps that passed, plus gates waiting, out of all steps. */
export function runPill(run: Run): Pill {
  const steps = stepsOf(run)
  const reached = steps.filter((s) => s.status === 'succeeded' || s.status === 'waiting' || s.status === 'resuming').length
  const look = steps.some((s) => s.status === 'resuming') ? { tone: 'run' as const, text: 'Resuming' } : runLook(run.status)
  return { tone: look.tone, text: `${look.text} · ${reached}/${steps.length}` }
}

export function stepTone(step: Step): Tone {
  switch (step.status) {
    case 'succeeded':
      return 'ok'
    case 'failed':
      return 'fail'
    case 'waiting':
      return 'wait'
    case 'running':
    case 'resuming':
      return 'run'
    default:
      return 'muted'
  }
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const s = Math.max(0, ms) / 1000
  if (s < 59.95) return `${s.toFixed(1)}s`
  const total = Math.round(s)
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}m ${total % 60}s`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/** "4m", "2h", "3d": how long since `iso`, or '' when it is not a time. */
export function since(iso: string | undefined, now: number): string {
  const t = Date.parse(iso ?? '')
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

/** "45s", "6m", "2h 6m": a length of time as short as it stays useful, for "2m of about 6m"; never under "1s". */
export function brief(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : duration(ms)
}

/** How each pace reads: its color, the words that name what is off, and what a person can do about it. */
export const PACE_LOOK: Record<Pace['state'], { tone: Tone; label?: (p: Pace) => string; hint?: string }> = {
  'on-pace': { tone: 'muted' },
  slow: { tone: 'warm', label: () => 'longer than usual' },
  quiet: {
    tone: 'warm',
    label: (p) => `no activity for ${brief(p.quietMs ?? p.elapsedMs)}`,
    hint: 'It may be in a long step that writes nothing, or it may have stopped. Stop it if it does not move.'
  },
  gone: { tone: 'fail', label: () => 'its process is gone', hint: 'swamp still lists it as running, but the swamp process that ran it no longer exists. Stop it to clear it, then run it again.' }
}

/** "2m of about 6m", or "2m" for a workflow with no usual time yet. */
export const paceProgress = (p: Pace): string => (p.usualMs === undefined ? brief(p.elapsedMs) : `${brief(p.elapsedMs)} of about ${brief(p.usualMs)}`)

export const paceLabel = (p: Pace): string | undefined => PACE_LOOK[p.state].label?.(p)

/** What a run's row has room for: that it went quiet or its process is gone, else how far along it is. */
export const paceRow = (p: Pace): string => (p.state === 'quiet' || p.state === 'gone' ? paceLabel(p)! : paceProgress(p))

export const ago = (iso: string | undefined, now: number): string => {
  const s = since(iso, now)
  return s && `${s} ago`
}

/** What the step row shows on the right, or under a parallel step's name. */
export function stepTime(step: Step, now: number): string {
  switch (step.status) {
    case 'succeeded':
      return duration(step.durationMs)
    case 'failed':
      return duration(step.durationMs)
    case 'waiting':
      return step.expired ? 'expired' : since(step.since, now)
    case 'running':
      return since(step.startedAt, now)
    case 'resuming':
      return 'approved, resuming'
    case 'skipped':
      return 'skipped'
    case 'unknown':
      return step.raw
    case 'pending':
      return ''
  }
}

export const shortId = (id: string): string => id.slice(0, 4)

/** Where the panel is: a tab, then one level deeper per step. Back goes to `parent`. */
export type Place =
  | { tab: 'inbox' }
  | { tab: 'workflows' }
  | { tab: 'workflows'; workflow: string; runId?: RunId }
  | { tab: 'stagecraft' }
  | { tab: 'stagecraft'; factory: string }
  | { tab: 'stagecraft'; factory: string; item: string }

/**
 * Which workspace has the focus, as far as the panel can tell. Several workspaces share a name and branch
 * (every repo's `main` checkout), so its terminals tell them apart; a renamed terminal is the same workspace.
 */
export const workspaceKey = (context: { displayName: string; branch: string; terminals: { id: string; title?: string }[] } | null): string =>
  context ? [context.displayName, context.branch, ...context.terminals.map((t) => t.id).sort()].join('\0') : ''

export const home = (tab: Place['tab']): Place => parsePlace({ tab })

/** One level up: a run to its workflow's latest run, a workflow to the list, a ticket to its factory, a factory to the tab. */
export function parent(p: Place): Place {
  if (p.tab === 'inbox') return p
  if (p.tab === 'workflows') return 'workflow' in p && p.runId ? { tab: 'workflows', workflow: p.workflow } : { tab: 'workflows' }
  return 'item' in p ? { tab: 'stagecraft', factory: p.factory } : { tab: 'stagecraft' }
}

/** A place read back from storage or a button, where anything malformed reads as the Workflows tab. */
export function parsePlace(raw: unknown): Place {
  const p = (raw ?? {}) as Record<string, unknown>
  const name = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const [workflow, runId, factory, item] = [name(p.workflow), name(p.runId) as RunId | undefined, name(p.factory), name(p.item)]
  if (p.tab === 'inbox') return { tab: 'inbox' }
  if (p.tab === 'stagecraft') return factory ? (item ? { tab: 'stagecraft', factory, item } : { tab: 'stagecraft', factory }) : { tab: 'stagecraft' }
  return workflow ? (runId ? { tab: 'workflows', workflow, runId } : { tab: 'workflows', workflow }) : { tab: 'workflows' }
}

/** One string per inbox item, for the button that acts on it and the note typed for it. */
export const inboxId = (i: InboxItem): string =>
  JSON.stringify(i.kind === 'gate' ? [repoKey(i.repo), i.gate.runId, i.gate.step] : [repoKey(i.repo), i.key])

/** Where Open on an inbox item goes, in that item's repo. */
export const inboxPlace = (i: InboxItem): Place =>
  i.kind === 'gate' ? { tab: 'workflows', workflow: i.gate.workflow, runId: i.gate.runId } : { tab: 'stagecraft', factory: i.factory, item: i.key }

/** The inbox items by repo, each group and its items in the order given, so the repo with the longest wait is first. */
export function inboxGroups(items: readonly InboxItem[]): { label: string; items: InboxItem[] }[] {
  const groups = new Map<string, { label: string; items: InboxItem[] }>()
  for (const i of items) (groups.get(repoKey(i.repo)) ?? groups.set(repoKey(i.repo), { label: i.repoLabel, items: [] }).get(repoKey(i.repo))!).items.push(i)
  return [...groups.values()]
}

/** How the Workflows tab narrows and orders its runs: one status chip, one time window, one sort. */
export type RunsView = { status: 'all' | 'running' | 'failed' | 'passed' | 'waiting'; when: 'all' | 'today' | 'week'; sort: 'newest' | 'oldest' | 'longest' | 'name' }

export const ALL_RUNS: RunsView = { status: 'all', when: 'all', sort: 'newest' }

/**
 * Each status chip, in the order drawn, and the run statuses it shows. A cancelled run is a person's choice, not a
 * failure, so only All shows it; the search finds it by the word "cancelled".
 */
export const RUN_CHIPS: Record<RunsView['status'], { label: string; tone: Tone; statuses?: readonly RunStatus[] }> = {
  all: { label: 'All', tone: 'muted' },
  running: { label: 'Running', tone: 'run', statuses: ['running', 'pending'] },
  failed: { label: 'Failed', tone: 'fail', statuses: ['failed', 'interrupted'] },
  passed: { label: 'Passed', tone: 'ok', statuses: ['succeeded'] },
  waiting: { label: 'Waiting', tone: 'wait', statuses: ['suspended'] }
}

export const WHEN_LABEL: Record<RunsView['when'], string> = { all: 'Any time', today: 'Today', week: 'This week' }

const newestRun = (a: RecentRun, b: RecentRun): number => b.startedAt.localeCompare(a.startedAt)

export const RUN_SORTS: Record<RunsView['sort'], { label: string; order: (a: RecentRun, b: RecentRun) => number }> = {
  newest: { label: 'Newest', order: newestRun },
  oldest: { label: 'Oldest', order: (a, b) => newestRun(b, a) },
  longest: { label: 'Longest', order: (a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1) || newestRun(a, b) },
  name: { label: 'Name', order: (a, b) => a.workflow.localeCompare(b.workflow) || newestRun(a, b) }
}

/** A runs view read back from storage or a button, where a part that is not a known choice reads as the default. */
export function parseRunsView(raw: unknown): RunsView {
  const v = (raw ?? {}) as Record<string, unknown>
  const known = <K extends string>(value: unknown, table: Record<K, unknown>, otherwise: K): K => (typeof value === 'string' && Object.hasOwn(table, value) ? (value as K) : otherwise)
  return { status: known(v.status, RUN_CHIPS, 'all'), when: known(v.when, WHEN_LABEL, 'all'), sort: known(v.sort, RUN_SORTS, 'newest') }
}

const DAY_MS = 86_400_000

/**
 * The runs the view and the search leave, in the view's order, and how many each status chip would show. The counts
 * follow the search and the time window but not the status chip. "Today" is since local midnight and "This week" the
 * last 7 days. The search reads a run's workflow, inputs, id, failed step and status word.
 */
export function runsShown(runs: readonly RecentRun[], view: RunsView, search: string, now: number): { runs: RecentRun[]; counts: Record<RunsView['status'], number> } {
  const q = search.trim().toLowerCase()
  const from = view.when === 'today' ? new Date(now).setHours(0, 0, 0, 0) : view.when === 'week' ? now - 7 * DAY_MS : undefined
  const pool = runs.filter(
    (r) =>
      (from === undefined || Date.parse(r.startedAt) >= from) &&
      (!q || [r.workflow, r.input, r.inputs, r.runId, r.failedStep, runLook(r.status).text].some((f) => f?.toLowerCase().includes(q)))
  )
  const of = (status: RunsView['status']): RecentRun[] => {
    const statuses = RUN_CHIPS[status].statuses
    return statuses ? pool.filter((r) => statuses.includes(r.status)) : pool
  }
  const counts = Object.fromEntries(Object.keys(RUN_CHIPS).map((s) => [s, of(s as RunsView['status']).length])) as Record<RunsView['status'], number>
  return { runs: [...of(view.status)].sort(RUN_SORTS[view.sort].order), counts }
}

/**
 * The workflows the view and the search leave: each one with a run in `shown`, the runs `runsShown` left. While no chip
 * or time window narrows the runs, a workflow also shows by its own name or description, or with no search at all, so
 * one that never ran is still found.
 */
export function workflowsShown<W extends { name: string; description?: string }>(workflows: readonly W[], shown: readonly RecentRun[], view: RunsView, search: string): W[] {
  const q = search.trim().toLowerCase()
  const anyRun = view.status === 'all' && view.when === 'all'
  const withRun = new Set(shown.map((r) => r.workflow))
  return workflows.filter((w) => withRun.has(w.name) || (anyRun && (!q || [w.name, w.description].some((f) => f?.toLowerCase().includes(q)))))
}

/**
 * The first `limit` runs by workflow, the groups in the order of their first run and each group's runs in the order
 * given, so the sort of the runs is also the sort of the groups.
 */
export function runGroups(runs: readonly RecentRun[], limit: number): { workflow: string; runs: RecentRun[] }[] {
  const groups = new Map<string, RecentRun[]>()
  for (const r of runs) (groups.get(r.workflow) ?? groups.set(r.workflow, []).get(r.workflow)!).push(r)
  let left = limit
  return [...groups].flatMap(([workflow, all]) => {
    const rows = all.slice(0, left)
    left -= rows.length
    return rows.length ? [{ workflow, runs: rows }] : []
  })
}

/** The last place in each repo and how its runs were narrowed, by repo key, the most recent last, as the panel keeps it in localStorage. */
export type Places = { repo: string; place: Place; runs?: RunsView }[]

// ponytail: the 20 repos used last keep their place; an older one opens on its tab's first screen.
const PLACES_KEPT = 20

/** Saved places read back from storage; an older version saved one `{ place, repo }`, and anything malformed is dropped. */
export function parsePlaces(raw: unknown): Places {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  return list.flatMap((x: { repo?: unknown; place?: unknown; runs?: unknown } | null) =>
    typeof x?.repo === 'string' && x.repo ? [{ repo: x.repo, place: parsePlace(x.place), ...(x.runs !== undefined && { runs: parseRunsView(x.runs) }) }] : []
  )
}

/** The saved places with `place`, and `runs` when given, as the last ones of `repo`. */
export const withPlace = (stored: unknown, repo: string, place: Place, runs?: RunsView): Places =>
  [...parsePlaces(stored).filter((x) => x.repo !== repo), { repo, place, ...(runs && { runs }) }].slice(-PLACES_KEPT)

/** Where the person was in `repo`, or undefined for a repo with no saved place. */
export const placeIn = (stored: unknown, repo: string): Place | undefined => parsePlaces(stored).filter((x) => x.repo === repo).at(-1)?.place

/** How the person last narrowed the runs of `repo`; everything, newest first, for a repo with nothing saved. */
export const runsViewIn = (stored: unknown, repo: string): RunsView => parsePlaces(stored).filter((x) => x.repo === repo).at(-1)?.runs ?? ALL_RUNS

/**
 * The last answer to "which repo does this workspace use", by workspace key, the most recent last, as the panel
 * keeps it in localStorage. The panel shows it at once on a switch back, while it asks again.
 */
export type Resolutions = { workspace: string; resolution: Resolution }[]

// ponytail: the 20 workspaces used last are remembered; an older one shows the loading screen once.
const RESOLUTIONS_KEPT = 20

function parseRepo(raw: unknown): Repo | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.dir !== 'string' || !r.dir) return null
  if (r.kind === 'local') return { kind: 'local', dir: r.dir as RepoDir }
  return r.kind === 'ssh' && typeof r.host === 'string' && r.host ? { kind: 'ssh', host: r.host as SshHost, dir: r.dir as RepoDir } : null
}

function parseResolution(raw: unknown): Resolution | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const repo = parseRepo(r.repo)
  if (!Array.isArray(r.candidates) || (r.repo !== null && !repo)) return null
  const candidates = r.candidates.flatMap((c: { repo?: unknown; label?: unknown } | null) => {
    const choice = parseRepo(c?.repo)
    return choice && typeof c?.label === 'string' ? [{ repo: choice, label: c.label }] : []
  })
  const w = (r.workspace ?? {}) as Record<string, unknown>
  const workspace = typeof w.name === 'string' ? { name: w.name, listed: w.listed === true, ...(typeof w.sharedName === 'number' && { sharedName: w.sharedName }) } : undefined
  return { repo, candidates, ...(workspace && { workspace }), ...(isStrings(r.remoteHosts) && { remoteHosts: r.remoteHosts as SshHost[] }) }
}

/** Remembered resolutions read back from storage; anything malformed is dropped. */
export function parseResolutions(raw: unknown): Resolutions {
  return (Array.isArray(raw) ? raw : []).flatMap((x: { workspace?: unknown; resolution?: unknown } | null) => {
    const resolution = parseResolution(x?.resolution)
    return typeof x?.workspace === 'string' && resolution ? [{ workspace: x.workspace, resolution }] : []
  })
}

/** The remembered resolutions with `resolution` as the last one of `workspace`. One that carries a problem is not remembered: it may pass. */
export function withResolution(stored: unknown, workspace: string, resolution: Resolution): Resolutions {
  const kept = parseResolutions(stored)
  const mine = resolution.problem ? [] : parseResolutions([{ workspace, resolution }])
  return mine.length ? [...kept.filter((x) => x.workspace !== workspace), ...mine].slice(-RESOLUTIONS_KEPT) : kept
}

/** What `workspace` resolved to last, or undefined for a workspace never seen. */
export const resolutionIn = (stored: unknown, workspace: string): Resolution | undefined =>
  parseResolutions(stored).find((x) => x.workspace === workspace)?.resolution

/** Where a workflow comes from: a scoped name such as `@swamp/stagecraft/claim` is an installed extension's. */
export type Origin = { kind: 'repo' } | { kind: 'extension'; name: string }

export function originOf(workflow: string): Origin {
  const scope = /^(@[^/]+\/[^/]+)\//.exec(workflow)?.[1]
  return scope ? { kind: 'extension', name: scope } : { kind: 'repo' }
}

const EXTENSION_TITLE: Record<string, string> = { '@swamp/stagecraft': 'StageCraft' }

export type WorkflowGroup<T> = { origin: Origin; title: string; workflows: T[] }

/** The repo's own workflows first, then one group per extension in name order. */
export function groupWorkflows<T extends { name: string }>(workflows: readonly T[]): WorkflowGroup<T>[] {
  const groups = new Map<string, WorkflowGroup<T>>()
  for (const w of workflows) {
    const origin = originOf(w.name)
    const key = origin.kind === 'repo' ? '' : origin.name
    const title = origin.kind === 'repo' ? 'Workflows' : (EXTENSION_TITLE[origin.name] ?? origin.name)
    const group = groups.get(key) ?? groups.set(key, { origin, title, workflows: [] }).get(key)!
    group.workflows.push(w)
  }
  return [...groups.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))).map(([, g]) => g)
}

/** The name a workflow card shows under its group's heading: `claim` for `@swamp/stagecraft/claim`. */
export const shortName = (workflow: string): string => {
  const origin = originOf(workflow)
  return origin.kind === 'repo' ? workflow : workflow.slice(origin.name.length + 1)
}

/** The repo's name as the header shows it, with the host for a remote repo: "factory-v3 · jarvis". */
export const repoTitle = (c: RepoChoice): string => {
  const name = c.label.split(' · ')[0]
  return c.repo.kind === 'ssh' ? `${name} · ${c.repo.host}` : name
}

const REMOTE_OFF: Record<'studio' | 'send', (host: string) => string> = {
  studio: (host) => `Studio runs a web server on ${host}, which this Mac cannot open without a port forward.`,
  send: (host) => `This run lives on ${host}, and Send can only type into a terminal Orca names on this Mac. Copy the retry command and run it on ${host}.`
}

/** Why a feature is off for this repo, or null when it works. */
export const remoteOff = (repo: Repo, feature: 'studio' | 'send'): string | null => (repo.kind === 'ssh' ? REMOTE_OFF[feature](repo.host) : null)

export const approveCommand = (workflow: string, step: string, runId: string): string =>
  `swamp workflow approve ${workflow} ${step} --run ${runId}`

export const retryCommand = (run: Run, step: string): string => actionCommand('retry', run, step)

/**
 * How each run action's button reads, by the run's status where the same action reads differently, and while its
 * request runs. `confirm` is what a first press asks before a second press acts, for the actions that end work in
 * progress or run steps a second time.
 */
export const ACTION_LOOK: Record<RunAction, { label: string | Partial<Record<RunStatus, string>>; busy: string; confirm?: string }> = {
  stop: { label: 'Stop', busy: 'Stopping…', confirm: 'Stop this run? The step that is running is ended and the rest are skipped.' },
  retry: { label: { failed: 'Retry failed steps', suspended: 'Resume' }, busy: 'Starting…' },
  recover: { label: 'Recover and resume', busy: 'Recovering…', confirm: 'This run was cut off. A step that was running then runs again from its start.' },
  again: { label: 'Run again', busy: 'Starting…' }
}

export const actionLabel = (action: RunAction, status: RunStatus): string => {
  const { label } = ACTION_LOOK[action]
  return typeof label === 'string' ? label : (label[status] ?? 'Retry')
}

/** The swamp command an action runs, as a person would type it, shown under the buttons. */
export function actionCommand(action: Exclude<RunAction, 'again'>, run: Run, from?: string): string {
  const target = `${run.workflow} --run ${run.id}`
  switch (action) {
    case 'stop':
      return `swamp workflow cancel ${target}`
    case 'retry':
      return `swamp workflow resume ${target}${from ? ` --from ${from}` : ''}`
    case 'recover':
      return `swamp workflow recover ${target} --acknowledge-unknown, then swamp workflow resume ${target}`
  }
}

export const firstFailed = (run: Run): Extract<Step, { status: 'failed' }> | undefined =>
  stepsOf(run).find((s): s is Extract<Step, { status: 'failed' }> => s.status === 'failed')

/** One line of text an agent can act on, typed into its terminal without pressing Enter. */
export function failurePrompt(run: Run, step: Extract<Step, { status: 'failed' }>): string {
  const inputs = Object.entries(run.inputs).map(([k, v]) => `${k}=${v}`).join(', ')
  // A newline typed into a terminal presses Enter, and an escape character starts a terminal command.
  return [
    `The swamp workflow ${run.workflow} failed at step ${step.name} (run ${run.id}${inputs ? `, inputs ${inputs}` : ''}): ${step.error}.`,
    `Read the log with \`swamp workflow history logs ${run.id}\`, fix the cause,`,
    `then retry with \`${retryCommand(run, step.name)}\`.`
  ]
    .join(' ')
    .replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ')
}

/** A swamp log line without its timestamp and method prefix, and how loud it is. */
export function logLine(line: string): { text: string; level: 'error' | 'warn' | 'info' } {
  const level = /\[(ERR|FTL)\]/.test(line) ? 'error' : /\[WRN\]/.test(line) ? 'warn' : 'info'
  const text = line.replace(/^\S+Z \[[A-Z]{3}\] /, '').replace(/^[\w-]+(·[\w@/.-]+)+: /, '')
  try {
    const unquoted = JSON.parse(text)
    if (typeof unquoted === 'string') return { text: unquoted, level }
  } catch {}
  return { text, level }
}

export const isFinished = (s: TicketStatus): boolean => s === 'done' || s === 'abandoned'

export const TICKET_LABEL: Record<TicketStatus, string> = {
  'needs-you': 'needs you',
  stuck: 'stuck',
  working: 'working',
  queued: 'queued',
  done: 'done',
  abandoned: 'abandoned'
}

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`

/** A working ticket that went quiet: its dispatch is still open and recorded nothing for so long that it counts as stuck. */
export const isQuiet = (item: Pick<WorkItem, 'status' | 'reason'>): boolean => item.reason.kind === 'working' && item.status === 'stuck'

/** The word a ticket's line starts with. A ticket that does not move names why; one that moves or is finished names its status. */
export const reasonWord = (item: WorkItem): string => (isQuiet(item) ? 'no activity' : (REASON_WORD[item.reason.kind] ?? TICKET_LABEL[item.status]))

const REASON_WORD: Partial<Record<Reason['kind'], string>> = {
  parked: 'parked',
  failed: 'failed',
  interrupted: 'interrupted',
  passed: 'not advanced',
  idle: 'idle'
}

/** What the line under a ticket's name says after that word: how long it has been so, how many tries it used, or which try it is on. */
export function ticketWhen(item: WorkItem, now: number): string {
  const r = item.reason
  if (r.kind === 'parked') return `${r.count} of ${r.limit} tries`
  if (r.kind === 'working' && isQuiet(item)) return since(r.activeAt, now)
  if (r.kind === 'working' && item.cycle > 1) return `${ordinal(item.cycle)} try`
  return since(r.kind === 'working' ? item.enteredAt : r.since, now)
}

/** The ticket screen's "Why it is here": what holds the ticket, and what moves it. */
export function whyHere(item: WorkItem, now: number): { text: string; next: string; why?: string } {
  const r = item.reason
  const work = `The work for ${item.stage}`
  const again = "The agent that drives this factory must dispatch the stage's work again."
  switch (r.kind) {
    case 'gate':
      return {
        text: r.gates.length ? `A person must decide ${r.gates.join(' and ')}.` : 'A person must choose an exit.',
        next: r.gates.length ? 'Approve or decline under Now.' : 'Tell the agent that drives this factory which exit to take; the exits are under Now.'
      }
    case 'parked':
      return {
        text: `Parked: it used ${r.count} of its ${r.limit} tries in ${item.stage}.`,
        next: 'A person must grant a dispatch override before it is tried again. Tell the agent that drives this factory.',
        why: r.why
      }
    case 'working':
      if (isQuiet(item)) {
        const open = 'Its dispatch is still open and never reported how it ended, so it may have stopped.'
        return {
          text: `${work}${r.dispatch.workflow ? `, sent to the workflow ${r.dispatch.workflow},` : ''} has shown no activity for ${since(r.activeAt, now)}.`,
          next: r.dispatch.workflow ? `${open} Open the run of ${r.dispatch.workflow} to see; if it is dead, the stage's work must be dispatched again.` : `${open} ${again}`
        }
      }
      return { text: r.dispatch.workflow ? `${work} is running in the workflow ${r.dispatch.workflow}.` : `${work} is in progress.`, next: 'Nothing to do. It moves when the work reports how it ended.' }
    case 'failed':
    case 'interrupted':
      return {
        text: `${work} ${r.kind === 'failed' ? 'failed' : 'was interrupted'}, and nothing was tried since.`,
        next: r.dispatch.workflow ? `Open the run of ${r.dispatch.workflow} to see what failed and retry it.` : again,
        why: r.why
      }
    case 'passed':
      return { text: `${work} passed, but nothing moved the ticket on.`, next: 'The agent that drives this factory advances it once the gates of an exit pass; the exits are under Now.' }
    case 'idle':
      return {
        text: item.cycle > 1 ? `It came back to ${item.stage}${item.from ? ` from ${item.from}` : ''}, and nothing was started since.` : `Nothing was started for ${item.stage} yet.`,
        next: "The agent that drives this factory must dispatch the stage's work."
      }
    case 'done':
      return { text: `Finished in ${item.stage}.`, next: '' }
  }
}

/**
 * The run a dispatch to a workflow stage started: the first run of that workflow that began after the dispatch.
 * ponytail: matched by name and time, since the dispatch record holds no run id; two tickets sent to one workflow
 * within the same moment can swap runs. Match on the `_stagecraft` input when a factory is seen to pass it.
 */
export const dispatchRun = (runs: readonly RecentRun[], dispatch: Dispatch): RecentRun | undefined =>
  runs.filter((r) => r.workflow === dispatch.workflow && r.startedAt >= dispatch.at).sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]

/** One grid cell: a stage passed, the one it is in now, one it was sent back from, or one not reached. */
export type Cell = { kind: 'passed' | 'now' | 'back' | 'ahead'; passes?: number }

/** A ticket's cell in each stage column, from how many times it entered each stage. */
export function cellsOf(columns: readonly Stage[], item: WorkItem): Cell[] {
  const at = columns.findIndex((s) => s.id === item.stage)
  return columns.map((s, i) => {
    const n = item.entries[s.id] ?? 0
    const passes = n > 1 ? { passes: n } : {}
    if (i === at) return { kind: 'now', ...passes }
    if (!n) return { kind: 'ahead' }
    // A stage past the current one was entered, so the ticket came back from there; the journal names which.
    const back = at >= 0 && i > at && (item.from === undefined || item.from === s.id)
    return { kind: back ? 'back' : 'passed', ...passes }
  })
}

/** "Approve plan" for the gate plan-approval. */
export const approveLabel = (gateId: string): string => `Approve ${gateId.replace(/-(approval|confirmation)$/, '')}`

export const INSTALL_COMMAND = 'swamp extension pull @swamp/stagecraft'

export const startCommand = (factory: string): string =>
  `swamp model @swamp/stagecraft/work-item method run start <key> --input factory=${factory} --input 'title=<title>'`

export type Finding = { severity: string; description: string; resolved: boolean; tone: Tone }

/** One part of a product payload, as the work item view reads it out. */
export type PayloadBlock =
  | { kind: 'text'; label: string; text: string }
  | { kind: 'list'; label: string; items: string[] }
  | { kind: 'steps'; label: string; steps: { description: string; files: string[] }[] }
  | { kind: 'findings'; label: string; findings: Finding[] }
  | { kind: 'fields'; label: string; rows: [string, string][] }

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
const SEVERITY_TONE: Record<string, Tone> = { critical: 'fail', high: 'fail', medium: 'warm', low: 'muted' }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isStep = (s: unknown): s is { description: string; files?: string[] } =>
  isObj(s) && typeof s.description === 'string' && Object.keys(s).every((k) => k === 'description' || (k === 'files' && isStrings(s.files)))
const isFinding = (f: unknown): f is { severity: string; description: string; resolved?: unknown } =>
  isObj(f) && typeof f.severity === 'string' && typeof f.description === 'string'

/** "testingStrategy" reads "Testing strategy". */
const labelOf = (key: string): string => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function flatten(path: string, v: unknown, rows: [string, string][]): void {
  if (isObj(v) && Object.keys(v).length) for (const [k, x] of Object.entries(v)) flatten(path ? `${path}.${k}` : k, x, rows)
  else if (Array.isArray(v) && v.length) v.forEach((x, i) => flatten(`${path}[${i + 1}]`, x, rows))
  else rows.push([path, Array.isArray(v) ? 'none' : isObj(v) ? 'empty' : String(v)])
}

/**
 * A payload of any shape as readable blocks, in its own key order: strings as text, string arrays as lists, plan steps
 * (description and files) and findings (worst first) in their known form, and everything else as key/value rows.
 */
export function payloadBlocks(payload: unknown): PayloadBlock[] {
  const rows: [string, string][] = []
  if (!isObj(payload)) {
    flatten('value', payload, rows)
    return [{ kind: 'fields', label: 'Payload', rows }]
  }
  const blocks: PayloadBlock[] = []
  for (const [key, v] of Object.entries(payload)) {
    const label = labelOf(key)
    if (typeof v === 'string') blocks.push({ kind: 'text', label, text: v })
    else if (isStrings(v) && v.length) blocks.push({ kind: 'list', label, items: v })
    else if (Array.isArray(v) && v.length && v.every(isStep)) blocks.push({ kind: 'steps', label, steps: v.map((s) => ({ description: s.description, files: s.files ?? [] })) })
    else if (Array.isArray(v) && v.length && v.every(isFinding)) {
      const findings = v.map((f) => ({ severity: f.severity, description: f.description, resolved: f.resolved === true, tone: SEVERITY_TONE[f.severity] ?? 'muted' }))
      const rank = (f: Finding) => (f.resolved ? 10 : 0) + (SEVERITY_RANK[f.severity] ?? 4)
      blocks.push({ kind: 'findings', label, findings: findings.sort((a, b) => rank(a) - rank(b)) })
    } else flatten(key, v, rows)
  }
  if (rows.length) blocks.push({ kind: 'fields', label: blocks.length ? 'Other fields' : 'Fields', rows })
  return blocks
}

/** Why the panel shows a product's payload with a warning, or cannot show it. */
export function storedNote(p: Product): string | undefined {
  if (p.stored.match === 'missing') return `swamp holds no payload for ${p.name} v${p.version}, the version the journal recorded.`
  if (p.stored.match === 'stale')
    return p.stored.version === p.version
      ? `The stored ${p.name} v${p.version} does not match the digest the journal recorded, so it may have changed since.`
      : `The journal recorded ${p.name} v${p.version}, but swamp only holds v${p.stored.version}. This is v${p.stored.version}.`
  return undefined
}
