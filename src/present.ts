import type { Repo, RepoDir, Run, RunId, RunStatus, SshHost, Step } from './domain'
import type { RepoChoice, Resolution } from './repo'
import type { Product, Stage, TicketStatus, WorkItem } from './stagecraft'

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

export const home = (tab: Place['tab']): Place => ({ tab })

/** One level up: a run to its workflow's latest run, a workflow to the list, a ticket to its factory, a factory to the tab. */
export function parent(p: Place): Place {
  if (p.tab === 'workflows') return 'workflow' in p && p.runId ? { tab: 'workflows', workflow: p.workflow } : { tab: 'workflows' }
  return 'item' in p ? { tab: 'stagecraft', factory: p.factory } : { tab: 'stagecraft' }
}

/** A place read back from storage or a button, where anything malformed reads as the Workflows tab. */
export function parsePlace(raw: unknown): Place {
  const p = (raw ?? {}) as Record<string, unknown>
  const name = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const [workflow, runId, factory, item] = [name(p.workflow), name(p.runId) as RunId | undefined, name(p.factory), name(p.item)]
  if (p.tab === 'stagecraft') return factory ? (item ? { tab: 'stagecraft', factory, item } : { tab: 'stagecraft', factory }) : { tab: 'stagecraft' }
  return workflow ? (runId ? { tab: 'workflows', workflow, runId } : { tab: 'workflows', workflow }) : { tab: 'workflows' }
}

/** The last place in each repo, by repo key, the most recent last, as the panel keeps it in localStorage. */
export type Places = { repo: string; place: Place }[]

// ponytail: the 20 repos used last keep their place; an older one opens on its tab's first screen.
const PLACES_KEPT = 20

/** Saved places read back from storage; an older version saved one `{ place, repo }`, and anything malformed is dropped. */
export function parsePlaces(raw: unknown): Places {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  return list.flatMap((x: { repo?: unknown; place?: unknown } | null) => (typeof x?.repo === 'string' && x.repo ? [{ repo: x.repo, place: parsePlace(x.place) }] : []))
}

/** The saved places with `place` as the last one of `repo`. */
export const withPlace = (stored: unknown, repo: string, place: Place): Places =>
  [...parsePlaces(stored).filter((x) => x.repo !== repo), { repo, place }].slice(-PLACES_KEPT)

/** Where the person was in `repo`, or undefined for a repo with no saved place. */
export const placeIn = (stored: unknown, repo: string): Place | undefined => parsePlaces(stored).filter((x) => x.repo === repo).at(-1)?.place

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

export const retryCommand = (run: Run, step: string): string => `swamp workflow resume ${run.workflow} --run ${run.id} --from ${step}`

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

/** What the line under a ticket's name says after its status: how long, how many tries, or which try. */
export function ticketWhen(item: WorkItem, now: number): string {
  if (item.status === 'needs-you') return since(item.waiting?.since, now)
  if (item.status === 'stuck' && item.parked) return `${item.parked.count} of ${item.parked.limit} tries`
  if (!isFinished(item.status) && item.cycle > 1) return `${ordinal(item.cycle)} try`
  return since(item.enteredAt, now)
}

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
