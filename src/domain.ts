export type RepoDir = string & { readonly __brand: 'RepoDir' }
export type RunId = string & { readonly __brand: 'RunId' }
/** A destination `ssh` connects to without a prompt: the name Orca gives its SSH target, which is the person's ~/.ssh/config Host. */
export type SshHost = string & { readonly __brand: 'SshHost' }

/** Where a swamp repo lives: on this machine, or on a host reached over SSH (a workspace on a remote Orca server). */
export type Repo = { kind: 'local'; dir: RepoDir } | { kind: 'ssh'; host: SshHost; dir: RepoDir }

/** One string per repo, for map keys, pins and the picker: the path, or `host:path` for a remote one. */
export const repoKey = (r: Repo): string => (r.kind === 'local' ? r.dir : `${r.host}:${r.dir}`)

export type FailureCode = 'swamp_not_found' | 'not_a_swamp_repo' | 'timeout' | 'swamp_error' | 'parse_error' | 'host_unreachable' | 'orca_cli_missing'

export class SwampFailure extends Error {
  code: FailureCode
  constructor(code: FailureCode, message: string) {
    super(message)
    this.code = code
  }
}

export type DataRef = { id: string; name: string; version: number; type?: string }

/** `gate` marks a manual_approval step, whose time is a wait for a person. `kind` is a short label of what runs the step. */
type StepBase = { name: string; description?: string; kind?: string; logTag?: string; outputs?: unknown; data: DataRef[]; gate?: true }

export type Step = StepBase &
  (
    | { status: 'pending' }
    | { status: 'running'; startedAt: string }
    | { status: 'waiting'; prompt: string; since?: string; expired: boolean }
    | { status: 'resuming' }
    | { status: 'succeeded'; durationMs?: number }
    | { status: 'failed'; error: string; durationMs?: number }
    | { status: 'skipped'; reason: string }
    | { status: 'unknown'; raw: string }
  )

export type StepStatus = Step['status']

export type Job = { name: string; description?: string; stages: Step[][] }

export type RunStatus =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'

export type Run = {
  id: RunId
  workflow: string
  status: RunStatus
  startedAt?: string
  durationMs?: number
  inputs: Record<string, string>
  jobs: Job[]
  /** Who started the run, as swamp records it, such as `user:dev`. */
  by?: string
}

export type Gate = { workflow: string; runId: RunId; step: string; prompt: string; since?: string; expired: boolean; input?: string }

export type WorkflowSummary = {
  name: string
  description: string
  steps: number
  latest?: { runId: RunId; status: RunStatus; startedAt: string; done: number; total: number; trigger?: string }
  /** The latest runs, newest first, at most HISTORY_LENGTH. */
  runs: RecentRun[]
}

export type RecentRun = { workflow: string; runId: RunId; status: RunStatus; startedAt: string; input?: string }

export const HISTORY_LENGTH = 10
export const RECENT_LENGTH = 6

export type LogText = { text: string; truncated: boolean }

export const LOG_LIMIT_BYTES = 15 * 1024

const RUN_STATUSES: readonly RunStatus[] = ['pending', 'running', 'suspended', 'succeeded', 'failed', 'cancelled', 'interrupted']

export function isLive(run: Run): boolean {
  return run.status === 'running' || run.status === 'pending' || run.jobs.some((j) => j.stages.flat().some((s) => s.status === 'resuming'))
}

export type Json = Record<string, unknown>

export function obj(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SwampFailure('parse_error', `unexpected swamp output: ${what} is not an object`)
  }
  return value as Json
}

export function arr(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new SwampFailure('parse_error', `unexpected swamp output: ${what} is not a list`)
  return value
}

// Answers cross Orca's JSON boundary, which refuses undefined values, so parsers return plain JSON.
export const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

export const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
export const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

/** A timestamp as UTC ISO, so times compare as strings; undefined when it is not one. */
export function time(value: unknown): string | undefined {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function runIdOf(value: unknown, what: string): RunId {
  const id = str(value)
  if (!id) throw new SwampFailure('parse_error', `unexpected swamp output: ${what} has no run id`)
  return id as RunId
}

function runStatus(value: unknown): RunStatus {
  return RUN_STATUSES.find((s) => s === value) ?? 'unknown'
}

function inputValues(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries((value ?? {}) as Json)) {
    if (v === '' || v === null || v === undefined) continue
    out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return out
}

const firstInput = (value: unknown): string | undefined => Object.values(inputValues(value))[0]

const recentRun = (r: Json): RecentRun => ({
  workflow: str(r.workflowName) ?? '?',
  runId: runIdOf(r.runId, 'history entry'),
  status: runStatus(r.status),
  startedAt: time(r.startedAt) ?? '',
  input: firstInput(r.inputs)
})

const newestFirst = (a: { startedAt: string }, b: { startedAt: string }) => b.startedAt.localeCompare(a.startedAt)

export function parseRecent(history: unknown): RecentRun[] {
  return plain(arr(obj(history, 'history').results, 'history.results').map((raw) => recentRun(obj(raw, 'history entry'))).sort(newestFirst))
}

export function parseWorkflowList(search: unknown, history: unknown): WorkflowSummary[] {
  const byWorkflow = new Map<string, Json[]>()
  for (const raw of arr(obj(history, 'history').results, 'history.results')) {
    const r = obj(raw, 'history entry')
    const name = str(r.workflowName)
    if (name) byWorkflow.set(name, [...(byWorkflow.get(name) ?? []), r])
  }
  return plain(
    arr(obj(search, 'search').results, 'search.results').map((raw) => {
      const w = obj(raw, 'workflow')
      const name = str(w.name) ?? '?'
      const runs = (byWorkflow.get(name) ?? []).sort((a, b) => (time(b.startedAt) ?? '').localeCompare(time(a.startedAt) ?? ''))
      const last = runs[0]
      const progress = (last?.stepProgress ?? {}) as Json
      return {
        name,
        description: str(w.description) ?? '',
        steps: num(w.stepCount) ?? 0,
        runs: runs.slice(0, HISTORY_LENGTH).map(recentRun),
        latest: last && {
          runId: runIdOf(last.runId, 'history entry'),
          status: runStatus(last.status),
          startedAt: time(last.startedAt) ?? '',
          done: num(progress.completed) ?? 0,
          total: num(progress.total) ?? 0,
          trigger: str(last.triggerSource)
        }
      }
    })
  )
}

export function parseApprovals(raw: unknown): Gate[] {
  const body = obj(raw, 'approvals')
  const gate = (expired: boolean) => (entry: unknown): Gate => {
    const g = obj(entry, 'approval')
    return {
      workflow: str(g.workflowName) ?? '?',
      runId: runIdOf(g.runId, 'approval'),
      step: str(g.stepName) ?? '?',
      prompt: str(g.prompt) ?? '',
      since: time(g.suspendedAt),
      expired,
      input: firstInput(g.inputs)
    }
  }
  return plain([...arr(body.approvals, 'approvals').map(gate(false)), ...arr(body.expired ?? [], 'expired').map(gate(true))])
}

type StepDef = { deps: string[]; description?: string; kind?: string; prompt?: string; model?: string; method?: string; gate: boolean }
type JobDef = { description?: string; steps: Map<string, StepDef> }

const text = (value: unknown): string | undefined => str(value)?.trim() || undefined

const TASK_KIND: Record<string, string> = { manual_approval: 'approval', assert: 'assert', workflow: 'workflow' }

/**
 * A short label of what runs a step, from its task: a fixed name for the task types that run no behavior, else the
 * last part of the behavior type (`command/shell` is "shell"). swamp prints the type as modelType, or behaviorType
 * since it renamed models. A step that names an existing behavior gives no type, so it has no label.
 */
export function stepKind(task: Json): string | undefined {
  const type = str(task.type) ?? ''
  if (TASK_KIND[type]) return TASK_KIND[type]
  const behavior = str(task.behaviorType) ?? str(task.modelType)
  if (behavior) return behavior.split('/').at(-1) || undefined
  return type && type !== 'model_method' && type !== 'behavior' ? type.replaceAll('_', ' ') : undefined
}

/** Each job's steps by name: two jobs may each have a step of the same name. */
function parseDefinition(def: unknown): Map<string, JobDef> {
  const jobs = new Map<string, JobDef>()
  for (const rawJob of arr(obj(def, 'workflow').jobs, 'workflow.jobs')) {
    const job = obj(rawJob, 'job')
    const steps = new Map<string, StepDef>()
    for (const raw of arr(job.steps, 'job.steps')) {
      const s = obj(raw, 'step')
      const task = (s.task ?? {}) as Json
      steps.set(str(s.name) ?? '?', {
        deps: arr(s.dependsOn ?? [], 'step.dependsOn').map((d) => str(obj(d, 'step dependency').step) ?? ''),
        description: text(s.description),
        kind: stepKind(task),
        prompt: str(task.prompt),
        // swamp stores a task as modelIdOrName, or as modelType + modelName for a model it creates per run.
        model: str(task.modelIdOrName) ?? str(task.modelName),
        method: str(task.methodName),
        gate: task.type === 'manual_approval'
      })
    }
    jobs.set(str(job.name) ?? '?', { description: text(job.description), steps })
  }
  return jobs
}

/**
 * The `model·method` a step's log lines carry. A model name may be a template such as `fc-${{ run.id }}-prepare`,
 * and the lines carry it rendered.
 */
function logTagOf(def: StepDef, id: string, inputs: Record<string, string>): string | undefined {
  if (!def.model || !def.method) return undefined
  const model = def.model.replace(/\$\{\{\s*(run\.id|inputs\.([\w-]+))\s*\}\}/g, (whole, expr: string, input?: string) =>
    expr === 'run.id' ? id : (inputs[input!] ?? whole)
  )
  // ponytail: renders run.id and inputs only; any other expression leaves the step without a log filter.
  return model.includes('${{') ? undefined : `${model}·${def.method}`
}

function parseStep(s: Json, def: (StepDef & { logTag?: string }) | undefined, run: RunStatus, expired: ReadonlySet<string>): Step {
  const data = arr(s.dataArtifacts ?? [], 'step.dataArtifacts').map((d) => {
    const a = obj(d, 'data artifact')
    return { id: str(a.dataId) ?? '', name: str(a.name) ?? '?', version: num(a.version) ?? 0, type: str((a.tags as Json | undefined)?.type) }
  })
  const base = { name: str(s.name) ?? '?', description: def?.description, kind: def?.kind, logTag: def?.logTag, outputs: s.outputs ?? s.assertResult, data, ...(def?.gate && { gate: true as const }) }
  const durationMs = num(s.duration)
  switch (s.status) {
    case 'pending':
      return { ...base, status: 'pending' }
    case 'running':
      return { ...base, status: 'running', startedAt: time(s.startedAt) ?? '' }
    case 'waiting_approval':
      return { ...base, status: 'waiting', prompt: def?.prompt ?? '', since: time(s.startedAt), expired: expired.has(base.name) }
    case 'succeeded': {
      const approved = (s.approval as Json | undefined)?.status === 'approved'
      return approved && run === 'suspended' ? { ...base, status: 'resuming' } : { ...base, status: 'succeeded', durationMs }
    }
    case 'failed':
      return { ...base, status: 'failed', error: str(s.error) ?? 'failed', durationMs }
    case 'skipped':
      return { ...base, status: 'skipped', reason: str((s.skipReason as Json | undefined)?.kind) ?? 'skipped' }
    default:
      return { ...base, status: 'unknown', raw: String(s.status) }
  }
}

export function layerSteps<T extends { name: string }>(steps: readonly T[], dependsOn: ReadonlyMap<string, readonly string[]>): T[][] {
  const known = new Set(steps.map((s) => s.name))
  const depth = new Map<string, number>()
  const depthOf = (name: string, seen: ReadonlySet<string>): number => {
    const cached = depth.get(name)
    if (cached !== undefined) return cached
    const deps = (dependsOn.get(name) ?? []).filter((d) => known.has(d) && !seen.has(d))
    const next = new Set(seen).add(name)
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, next)))
    depth.set(name, d)
    return d
  }
  const layers: T[][] = []
  for (const step of steps) (layers[depthOf(step.name, new Set())] ??= []).push(step)
  return layers.filter(Boolean)
}

export function parseRun(def: unknown, run: unknown, gates: readonly Gate[] = []): Run {
  const r = obj(run, 'run')
  const jobs = parseDefinition(def)
  const status = runStatus(r.status)
  const id = runIdOf(r.id, 'run')
  const inputs = inputValues(r.inputs)
  const expired = new Set(gates.filter((g) => g.expired && g.runId === id).map((g) => g.step))
  return plain({
    id,
    workflow: str(r.workflowName) ?? '?',
    status,
    startedAt: time(r.startedAt),
    durationMs: num(r.duration),
    inputs,
    by: str(r.initiatedBy),
    jobs: arr(r.jobs, 'run.jobs').map((raw) => {
      const job = obj(raw, 'run job')
      const name = str(job.name) ?? '?'
      const steps = jobs.get(name)?.steps ?? new Map<string, StepDef>()
      const parsed = arr(job.steps, 'run job.steps').map((rawStep) => {
        const s = obj(rawStep, 'run step')
        const d = steps.get(str(s.name) ?? '')
        return parseStep(s, d && { ...d, logTag: logTagOf(d, id, inputs) }, status, expired)
      })
      return { name, description: jobs.get(name)?.description, stages: layerSteps(parsed, new Map([...steps].map(([n, s]) => [n, s.deps]))) }
    })
  })
}

export function parseDecision(raw: unknown): { allGatesDecided: boolean } {
  return { allGatesDecided: obj(raw, 'decision').allGatesDecided !== false }
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

export function parseLogs(raw: unknown, logTag?: string): LogText {
  const lines = arr(obj(raw, 'logs').lines, 'logs.lines')
    .map((l) => String(l).replace(ANSI, ''))
    .filter((l) => !logTag || l.includes(`·${logTag}:`))
  const kept: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    bytes += Buffer.byteLength(lines[i]) + 1
    if (bytes > LOG_LIMIT_BYTES) break
    kept.unshift(lines[i])
  }
  if (!kept.length && lines.length) {
    // The newest line alone is over the cap: keep its end, dropping a character the byte cut split.
    const tail = Buffer.from(lines.at(-1)!).subarray(-LOG_LIMIT_BYTES).toString().replace(/^\uFFFD+/, '')
    return { text: tail, truncated: true }
  }
  return { text: kept.join('\n'), truncated: kept.length < lines.length }
}
