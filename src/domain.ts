export type RepoDir = string & { readonly __brand: 'RepoDir' }
export type RunId = string & { readonly __brand: 'RunId' }
/**
 * What `ssh` is given to connect with, without a prompt: a Host from ~/.ssh/config, a server name or address, with or
 * without `user@`. The panel calls it an SSH login.
 */
export type SshHost = string & { readonly __brand: 'SshHost' }

/**
 * The one way a string becomes an SshHost. ssh reads a destination that starts with `-` as an option; a ~/.ssh/config
 * ProxyCommand may hand the name to a shell; and the panel prints the login inside commands a person pastes into a
 * terminal. So it holds letters, digits and `. _ - @ : % +` only, none of which a shell reads.
 */
export const sshHostOf = (value: unknown): SshHost | null =>
  typeof value === 'string' && /^(?!-)[\w.@:%+-]{1,253}$/.test(value) ? (value as SshHost) : null

const LOOPBACK = /^(localhost|127(\.\d+){3}|::1)$/i

/** A login as people paste it: `ssh dev@lab-box` and `ws://203.0.113.7:6768/` both mean their host part. */
export function tidyLogin(text: string): string {
  const typed = text.trim().replace(/^ssh\s+/, '')
  const url = /^wss?:\/\/([^/]*)/i.exec(typed)
  return url ? url[1].replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1') : typed
}

/** The address in one of Orca's endpoints, when ssh could try it: not this Mac's own end of an SSH tunnel. */
export function addressOf(endpoint: unknown): SshHost | null {
  const address = typeof endpoint === 'string' && /^wss?:\/\//i.test(endpoint) ? sshHostOf(tidyLogin(endpoint)) : null
  return address && !LOOPBACK.test(address) ? address : null
}

/** Where a swamp repo lives: on this machine, or on a host reached over SSH (a workspace on a remote Orca server). */
export type Repo = { kind: 'local'; dir: RepoDir } | { kind: 'ssh'; host: SshHost; dir: RepoDir }

/** One string per repo, for map keys, pins and the picker: the path, or `host:path` for a remote one. */
export const repoKey = (r: Repo): string => (r.kind === 'local' ? r.dir : `${r.host}:${r.dir}`)

/** Why ssh could not run a command on a host. */
export type SshCause = 'asks-password' | 'host-key-unknown' | 'host-key-changed' | 'unknown-name' | 'no-answer' | 'timed-out' | 'other'

// The first pattern that matches names the cause: a changed host key also prints "Host key verification failed".
const SSH_SAYS: [RegExp, SshCause][] = [
  [/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i, 'host-key-changed'],
  [/Host key verification failed|host key is known/i, 'host-key-unknown'],
  [/Permission denied|Too many authentication failures|No more authentication methods/i, 'asks-password'],
  [/Could not resolve hostname/i, 'unknown-name'],
  [/connect to host|Connection timed out|Operation timed out|No route to host|Network is unreachable/i, 'no-answer']
]

/** Reads the cause off what ssh printed and how it ended; `killed` is an ssh stopped at the panel's own time limit. */
export function sshCause(stderr: string, exit: { killed?: boolean }): SshCause {
  if (exit.killed) return 'timed-out'
  return SSH_SAYS.find(([says]) => says.test(stderr))?.[1] ?? 'other'
}

/** ssh's own last line, for a person who wants the exact words. */
export const sshSaid = (stderr: string): string =>
  stderr
    .split('\n')
    .map((l) => l.replace(/[\x00-\x1f\x7f]/g, '').trim())
    .filter(Boolean)
    .at(-1) ?? ''

/** A login ssh could not use, with why. */
export type SshFault = { login: SshHost; cause: SshCause; said: string }

export type FailureCode =
  | 'swamp_not_found'
  | 'not_a_swamp_repo'
  | 'timeout'
  | 'swamp_error'
  | 'parse_error'
  | 'host_unreachable'
  | 'orca_cli_missing'
  | 'server_unreachable'

export class SwampFailure extends Error {
  code: FailureCode
  /** swamp exited with an error code and printed no reason. For `run` and `resume` that is a run that ended failed or cancelled, not a refusal. */
  silent?: true
  /** Set when ssh itself failed, before or while it ran the command. */
  ssh?: SshFault
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
} & Vitals

/**
 * Signs of life of a run in flight. `activeAt` is when it last showed activity: a step began or ended, or, for a repo
 * on this machine, its record or log file changed. `gone` is a run whose swamp process no longer exists on this machine.
 */
export type Vitals = { activeAt?: string; gone?: true }

/** A run swamp lists as started and not ended. swamp keeps a run so after its process died. */
export const inFlight = (status: RunStatus): boolean => status === 'running' || status === 'pending'

/** Reads the vitals of the run `runId` of the workflow with id `workflowId`; nothing when they are not known. */
export type ReadVitals = (workflowId: string, runId: string) => Vitals

/** The run with what its files say: the later of the two activity times, and whether its process is gone. */
export function withVitals<R extends Vitals>(run: R, files: Vitals): R {
  const activeAt = [run.activeAt, files.activeAt].filter(Boolean).sort().at(-1)
  return { ...run, ...(activeAt && { activeAt }), ...(files.gone && { gone: true as const }) }
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

/** `input` is the first input's value; `inputs` is the values of the others in one string, for the search. */
export type RecentRun = {
  workflow: string
  runId: RunId
  status: RunStatus
  startedAt: string
  input?: string
  inputs?: string
  durationMs?: number
  failedStep?: string
} & Vitals

export const HISTORY_LENGTH = 10
export const RECENT_LENGTH = 6
// ponytail: the panel filters the 500 newest runs; an older one is not found. Page the history when a repo outgrows it.
export const RUNS_LIMIT = 500

export type LogText = { text: string; truncated: boolean }

export const LOG_LIMIT_BYTES = 15 * 1024

const RUN_STATUSES: readonly RunStatus[] = ['pending', 'running', 'suspended', 'succeeded', 'failed', 'cancelled', 'interrupted']

/** What a person can do to a run from the panel. `again` starts a new run with this run's inputs. */
export type RunAction = 'stop' | 'retry' | 'recover' | 'again'

/**
 * The actions swamp accepts for a run of each status, in the order the buttons are drawn. `retry` is
 * `swamp workflow resume --run`, which takes a failed or a suspended run; an interrupted run needs `recover` first.
 */
const RUN_ACTIONS: Record<RunStatus, readonly RunAction[]> = {
  pending: ['stop'],
  running: ['stop'],
  suspended: ['retry', 'stop'],
  succeeded: ['again'],
  failed: ['retry', 'again'],
  cancelled: ['again'],
  interrupted: ['recover', 'again'],
  unknown: []
}

const allSteps = (run: Run): Step[] => run.jobs.flatMap((j) => j.stages.flat())

/** The actions the run's screen offers. A suspended run with a gate to decide, or one resuming after its gates, is not offered `retry`. */
export function runActions(run: Run): readonly RunAction[] {
  const decides = run.status === 'suspended' && allSteps(run).some((s) => s.status === 'waiting' || s.status === 'resuming')
  return decides ? RUN_ACTIONS[run.status].filter((a) => a !== 'retry') : RUN_ACTIONS[run.status]
}

/**
 * The steps of a failed run that `swamp workflow resume --from` can start again from, each with its job's name: the
 * ones that ran. From a failed step it retries that step; from one that passed before it, that step and all after it.
 * A step skipped after the failure cannot be a start, because the failed step it depends on is not run again.
 */
export function retryFrom(run: Run): Map<Step, string> {
  const from = new Map<Step, string>()
  if (run.status !== 'failed') return from
  for (const job of run.jobs) for (const s of job.stages.flat()) if (s.status === 'failed' || s.status === 'succeeded') from.set(s, job.name)
  return from
}

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

const recentRun = (r: Json, vitals?: ReadVitals): RecentRun => {
  const values = Object.values(inputValues(r.inputs))
  const [runId, status] = [runIdOf(r.runId, 'history entry'), runStatus(r.status)]
  return {
    ...(vitals && inFlight(status) && vitals(str(r.workflowId) ?? '', runId)),
    workflow: str(r.workflowName) ?? '?',
    runId,
    status,
    startedAt: time(r.startedAt) ?? '',
    input: values[0],
    inputs: values.slice(1).join(' ') || undefined,
    durationMs: num(r.duration),
    failedStep: str(r.failedStep)
  }
}

const newestFirst = (a: { startedAt: string }, b: { startedAt: string }) => b.startedAt.localeCompare(a.startedAt)

/** Every run, newest first, at most RUNS_LIMIT. A run in flight carries what `vitals` reads for it. */
export function parseRecent(history: unknown, vitals?: ReadVitals): RecentRun[] {
  return plain(arr(obj(history, 'history').results, 'history.results').map((raw) => recentRun(obj(raw, 'history entry'), vitals)).sort(newestFirst).slice(0, RUNS_LIMIT))
}

export function parseWorkflowList(search: unknown, history: unknown, vitals?: ReadVitals): WorkflowSummary[] {
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
        runs: runs.slice(0, HISTORY_LENGTH).map((r) => recentRun(r, vitals)),
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
  const rawJobs = arr(r.jobs, 'run.jobs').map((j) => obj(j, 'run job'))
  // When a step or job last began or ended, which is all a remote repo tells of a run's activity.
  const rawSteps = rawJobs.flatMap((j) => arr(j.steps, 'run job.steps').map((s) => obj(s, 'run step')))
  const moved = [r, ...rawJobs, ...rawSteps].flatMap((x) => [time(x.startedAt), time(x.completedAt)])
  const activeAt = inFlight(status) ? moved.filter(Boolean).sort().at(-1) : undefined
  return plain({
    id,
    workflow: str(r.workflowName) ?? '?',
    status,
    activeAt,
    startedAt: time(r.startedAt),
    durationMs: num(r.duration),
    inputs,
    by: str(r.initiatedBy),
    jobs: rawJobs.map((job) => {
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

/** One input a workflow declares. `options` are the only values it takes: an enum's, or true and false. `default` is the text the form starts with. */
export type InputField = { name: string; type: string; required: boolean; description?: string; default?: string; options?: string[] }

const fieldText = (value: unknown): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : typeof value === 'string' ? value : JSON.stringify(value)

/** The inputs of a workflow, from the JSON schema `swamp workflow get` prints, in the order declared. */
export function parseInputs(def: unknown): InputField[] {
  const schema = (obj(def, 'workflow').inputs ?? {}) as Json
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return plain(
    Object.entries((schema.properties ?? {}) as Json).map(([name, raw]) => {
      const p = (raw ?? {}) as Json
      const type = str(p.type) ?? 'string'
      const options = Array.isArray(p.enum) ? p.enum.map((v) => fieldText(v) ?? '') : type === 'boolean' ? ['true', 'false'] : undefined
      return { name, type, required: required.has(name), description: text(p.description), default: fieldText(p.default), options }
    })
  )
}

/**
 * The form's text for each input as the value swamp gets: the text itself for a string input, else what it reads as
 * JSON (a number, true, a list), or the text when it is not JSON, which swamp then refuses by name. An empty field is
 * left out, so swamp uses the input's default or says it is required. A name the workflow does not declare is refused.
 */
export function typedInputs(fields: readonly InputField[], values: Readonly<Record<string, string>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    const field = fields.find((f) => f.name === name)
    if (!field) throw new SwampFailure('swamp_error', `the workflow has no input '${name}'`)
    if (value.trim() === '') continue
    out[name] = field.type === 'string' ? value : jsonOr(value)
  }
  return out
}

function jsonOr(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** The inputs a run was started with, as swamp recorded them, for a new run with the same ones. */
export const rawInputs = (run: unknown): Record<string, unknown> => ({ ...((obj(run, 'run').inputs ?? {}) as Json) })

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
