import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, posix } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  parseApprovals,
  parseDecision,
  parseInputs,
  parseLogs,
  parseRecent,
  parseRun,
  parseWorkflowList,
  rawInputs,
  repoKey,
  sshHostOf,
  SwampFailure,
  tidyLogin,
  inFlight,
  typedInputs,
  withVitals,
  type ReadVitals,
  type Repo,
  type RepoDir,
  type Run,
  type RunId,
  type SshHost
} from './domain'
import { inboxRepos, readInbox } from './inbox'
import { LOG, readChunk, type LogAsk } from './log'
import { failurePrompt, firstFailed, type ConnectFault } from './present'
import type { AgentTerminal, Connected } from './protocol'
import { focusPinKey, parsePins, parseWorkspaces, remembered, rememberedLookups, resolveRepo, serversUnread, UNNAMED, type Pins, type Resolution } from './repo'
import {
  expectedOf,
  FACTORY_TYPE,
  itemQuery,
  modelsOfType,
  olderPayloadsQuery,
  parseBoard,
  parseFactories,
  parseWorkItemDetail,
  runsQuery,
  safeName,
  STUDIO_TYPE
} from './stagecraft'
import { copyToClipboard, logReader, runFile, runVitals, startBackground, startStudio, stopStudios, swamp, type Background } from './swamp'
import { parseThemeId, type ThemeId } from './theme'

// A failed run is not kept: `swamp workflow resume --run <id> --from <step>` retries it under the same id.
const finishedRuns = new Map<string, Run>()
// swamp's version per machine: one swamp binary serves every repo on it.
const versions = new Map<string, Promise<string>>()

// ponytail: pins live in a small JSON file because `storage:own` would add a capability.
const pinsFile = (): string => process.env.SWAMPLING_PINS ?? join(homedir(), '.config/swampling/pins.json')

/** The pins file as it is written: entries this version cannot read are kept as they are on a rewrite. */
function rawPins(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(pinsFile(), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const readPins = (): Pins => parsePins(rawPins())

function writePins(raw: Record<string, unknown>): Pins {
  mkdirSync(dirname(pinsFile()), { recursive: true })
  writeFileSync(pinsFile(), JSON.stringify(raw, null, 2))
  return parsePins(raw)
}

const settingsFile = (): string => join(dirname(pinsFile()), 'settings.json')

/** `inbox` is whether the panel shows the "Needs you" tab and reads every repo for it. `sshHosts` are the SSH logins the person added. */
type Settings = { theme: ThemeId; inbox: boolean; sshHosts: SshHost[] }

function readSettings(): Settings {
  try {
    const saved = JSON.parse(readFileSync(settingsFile(), 'utf8')) as { theme?: unknown; inbox?: unknown; sshHosts?: unknown } | null
    const hosts = Array.isArray(saved?.sshHosts) ? saved.sshHosts.flatMap((h) => sshHostOf(h) ?? []) : []
    return { theme: parseThemeId(saved?.theme), inbox: saved?.inbox !== false, sshHosts: [...new Set(hosts)] }
  } catch {
    return { theme: 'orca', inbox: true, sshHosts: [] }
  }
}

function saveSettings(change: Partial<Settings>): Settings {
  const settings = { ...readSettings(), ...change }
  mkdirSync(dirname(settingsFile()), { recursive: true })
  // The file names the logins only while there are some, so it reads as 0.5.0 wrote it for a person with none.
  writeFileSync(settingsFile(), JSON.stringify({ ...settings, sshHosts: settings.sshHosts.length ? settings.sshHosts : undefined }, null, 2))
  return settings
}

// The panel's input crosses a trust boundary: what it names lands on a swamp command line.
const refuse = (message: string): never => {
  throw new SwampFailure('swamp_error', message)
}

/** A word that becomes a swamp argument; one starting with - would be read as an option. */
function word<T extends string = string>(value: unknown, what: string): T {
  if (typeof value !== 'string' || !value.trim()) return refuse(`the panel sent no ${what}`)
  if (value.startsWith('-')) return refuse(`${what} '${value}' is not a name`)
  return value as T
}

function repoOf(value: unknown): Repo {
  return parsePins({ repo: value }).repo ?? refuse('the panel sent no repo, or one that is not an absolute folder')
}

function hostOf(value: unknown): SshHost {
  return sshHostOf(value) ?? refuse(`'${String(value)}' is not an SSH login`)
}

/** A folder on a remote host as the probe takes it: a full path, or one under `~`, with no trailing slash, `..` or control character. */
function remoteDirOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null
  const dir = posix.normalize(value.trim()).replace(/(.)\/$/, '$1')
  return /^(\/|~$|~\/)/.test(dir) ? dir : null
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  return allowed.includes(value as T) ? (value as T) : refuse(`${what} '${String(value)}' is not one of ${allowed.join(', ')}`)
}

// Well under Linux's 128 KiB limit on one argument, which the ssh command line for a remote repo is.
const NOTE_LIMIT = 10_000

function noteOf(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const note = typeof value === 'string' ? value.trim() : refuse('the note is not text')
  if (note.length > NOTE_LIMIT) refuse(`the note is ${note.length} characters; keep it under ${NOTE_LIMIT}`)
  return note || undefined
}

/** The form's values: one text per input name. The names are checked against the workflow's own inputs before use. */
function textsOf(value: unknown): Record<string, string> {
  const texts = value === undefined ? {} : value
  if (typeof texts !== 'object' || texts === null || Array.isArray(texts)) return refuse('the inputs are not a set of named values')
  for (const [name, text] of Object.entries(texts)) {
    if (typeof text !== 'string') refuse(`the input '${name}' is not text`)
    if (text.length > NOTE_LIMIT) refuse(`the input '${name}' is ${text.length} characters; keep it under ${NOTE_LIMIT}`)
  }
  return texts as Record<string, string>
}

/** An input's name is the start of one `name:json=value` argument, so it may not hold the characters that end the name. */
function inputNames(inputs: Record<string, unknown>): Record<string, unknown> {
  for (const name of Object.keys(inputs)) if (!/^[\w.-]+$/.test(name)) refuse(`the input name '${name}' has a character swamp's --input cannot carry`)
  return inputs
}

/** A byte offset into a run's log. */
function offsetOf(value: unknown, what: string): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : refuse(`${what} '${String(value)}' is not a byte offset`)
}

function logAskOf(after: unknown, before: unknown): LogAsk {
  if (after !== undefined && before !== undefined) refuse('a log read is after an offset or before one, not both')
  return after !== undefined ? { after: offsetOf(after, 'after') } : before !== undefined ? { before: offsetOf(before, 'before') } : {}
}

function logLimitOf(value: unknown, ask: LogAsk): number {
  if (value === undefined) return 'after' in ask ? LOG.chunkBytes : LOG.firstBytes
  if (typeof value !== 'number' || Number.isNaN(value)) refuse('the log limit is not a number of bytes')
  return Math.min(LOG.maxBytes, Math.max(LOG.minBytes, Math.floor(value as number)))
}

// The workflow id of each run read in this worker's life: with the run's id it names the run's files.
const workflowIds = new Map<string, string>()

const START_WAIT_MS = 10_000
const START_POLL_MS = 500

/**
 * Starts `run` or `resume` in the background, then asks `shows` twice a second until it answers what the start was
 * for, swamp ends, or 10 s pass. `shows` hears whether swamp has ended. What swamp says when it refuses is thrown; a
 * swamp that ends with an error and no words has run the workflow to a failed end, which the run itself shows.
 */
async function started<T>(repo: Repo, command: Background, shows: (ended: boolean) => Promise<T | undefined>): Promise<T | undefined> {
  let exit: { error?: SwampFailure } | undefined
  startBackground(repo, command, (error) => (exit = { error }))
  for (let waited = 0; waited < START_WAIT_MS; waited += START_POLL_MS) {
    await new Promise((r) => setTimeout(r, START_POLL_MS))
    const ended = exit as { error?: SwampFailure } | undefined
    if (ended?.error && !ended.error.silent) throw ended.error
    const shown = await shows(!!ended).catch(() => undefined)
    if (shown !== undefined || ended) return shown
  }
  return undefined
}

const latestRunId = (repo: Repo, workflow: string): Promise<string | undefined> =>
  swamp(repo, { cmd: 'history.get', workflow }).then(
    (raw) => String((raw as { id?: unknown } | null)?.id ?? '') || undefined,
    // A workflow that never ran has no latest run, which swamp reports as an error.
    () => undefined
  )

async function getRun(repo: Repo, workflow: string, runId?: RunId): Promise<Run> {
  const key = `${repoKey(repo)}\0${runId}`
  const cached = runId && finishedRuns.get(key)
  if (cached) return sameWorkflow(cached, workflow)
  const [def, raw] = await Promise.all([
    swamp(repo, { cmd: 'workflow.get', workflow }),
    swamp(repo, { cmd: 'history.get', workflow, runId })
  ])
  const suspended = (raw as { status?: unknown }).status === 'suspended'
  const gates = suspended ? parseApprovals(await swamp(repo, { cmd: 'approvals' })) : []
  const parsed = sameWorkflow(parseRun(def, raw, gates), workflow)
  const workflowId = (raw as { workflowId?: unknown }).workflowId
  if (typeof workflowId === 'string') workflowIds.set(`${repoKey(repo)}\0${parsed.id}`, workflowId)
  // Read for a run in flight on this machine; a remote repo's run keeps the step times alone.
  const file = (raw as { path?: unknown }).path
  const run = repo.kind === 'local' && inFlight(parsed.status) && typeof file === 'string' ? withVitals(parsed, runVitals(file)) : parsed
  if (run.status === 'succeeded' || run.status === 'cancelled') finishedRuns.set(`${repoKey(repo)}\0${run.id}`, run)
  const failedResume = resumeFailures.get(`${repoKey(repo)}\0${run.id}`)
  return failedResume ? withFailedResume(run, failedResume) : run
}

// ponytail: one entry per run whose resume failed in this worker's life; a worker restart shows it resuming again.
const resumeFailures = new Map<string, string>()

/** A run whose resume failed shows the error on its approved gates instead of "resuming", which the panel polls fast. */
const withFailedResume = (run: Run, error: string): Run => ({
  ...run,
  jobs: run.jobs.map((j) => ({ ...j, stages: j.stages.map((st) => st.map((s) => (s.status === 'resuming' ? { ...s, status: 'failed' as const, error } : s))) }))
})

// swamp finds a run by its id alone, so a run of another workflow would be drawn with this one's steps.
const sameWorkflow = (run: Run, workflow: string): Run =>
  run.workflow === workflow ? run : refuse(`run ${run.id} belongs to workflow ${run.workflow}, not ${workflow}`)

const now = () => new Date().toISOString()

async function workItem(repo: Repo, key: string) {
  const latest = await swamp(repo, { cmd: 'data.query', predicate: itemQuery(key) })
  const older = olderPayloadsQuery(key, latest)
  return parseWorkItemDetail(latest, now(), older && (await swamp(repo, { cmd: 'data.query', predicate: older })))
}

// One studio per repo for the worker's life; deactivate stops them.
const studios = new Map<string, Promise<string>>()

async function studio(repo: Repo): Promise<string> {
  if (repo.kind === 'ssh') {
    // ponytail: no port forward; add `ssh -L` with cleanup when people ask for Studio on remote hosts.
    throw new SwampFailure('swamp_error', `Studio would run its web server on ${repo.host}, which this Mac cannot open without a port forward. The board, plans and gates here work the same.`)
  }
  const models = await swamp(repo, { cmd: 'models' })
  const name = modelsOfType(models, STUDIO_TYPE)[0] ?? 'studio'
  if (!modelsOfType(models, FACTORY_TYPE).length) throw new SwampFailure('swamp_error', 'this repo has no StageCraft factory to show')
  if (!modelsOfType(models, STUDIO_TYPE).length) await swamp(repo, { cmd: 'model.create', type: STUDIO_TYPE, name })
  return startStudio(repo.dir, name, () => studios.delete(repoKey(repo)))
}

const AGENT_TITLE = /\b(claude|codex|gemini|opencode|cursor|aider|agent)\b/i

async function agentTerminal(orca: OrcaWorkerApi): Promise<AgentTerminal | null> {
  const context = await orca.host.call('workspace.readContext')
  const terminals = context?.terminals ?? []
  const t = terminals.find((x) => AGENT_TITLE.test(x.title ?? '')) ?? terminals[0]
  return t ? { id: t.id, title: t.title || 'Terminal', workspace: context!.displayName } : null
}

// ponytail: one map entry per work item ever decided in this worker's life.
const deciding = new Map<string, Promise<unknown>>()

/** Runs one decision per work item at a time, so a second press sees what the first one did. */
function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const turn = (deciding.get(key) ?? Promise.resolve()).then(fn, fn)
  deciding.set(key, turn.catch(() => {}))
  return turn
}

async function decide(repo: Repo, key: string, gateId: string, decision: 'approve' | 'decline', note: string | undefined) {
  const { item } = await workItem(repo, key)
  const exit = item.waiting?.exits.find((x) => x.gateIds.includes(gateId))
  if (!exit) throw new SwampFailure('swamp_error', `${key} is not waiting on ${gateId} now`)
  // The press is the person's explicit word for this gate; the journal names them.
  const person = { onBehalfOf: userInfo().username }
  const expected = expectedOf(item)
  await swamp(repo, { cmd: 'work-item', method: decision, key, inputs: { gateId, ...person, ...(note && { note }) }, expected })
  let advanced: string | undefined
  let advanceError: string | undefined
  if (decision === 'approve' && exit.gateIds.length === 1) {
    const inputs = { transition: exit.transition, ...person, ...(exit.manual && { confirm: 'true' }) }
    try {
      await swamp(repo, { cmd: 'work-item', method: 'advance', key, inputs, expected })
      advanced = exit.to
    } catch (e) {
      advanceError = (e as Error).message
    }
  }
  return { ...(await workItem(repo, key)), ...(advanced && { advanced }), ...(advanceError && { advanceError }) }
}

const REGISTRY_FRESH_MS = 30_000
const INBOX_FRESH_MS = 30_000

export default function activate(orca: OrcaWorkerApi): void {
  // Remembered for this worker's life: each lookup starts a process, which takes seconds on a busy Mac.
  const look = rememberedLookups()
  const readRegistry = remembered(REGISTRY_FRESH_MS, () => swamp({ kind: 'local', dir: homedir() as RepoDir }, { cmd: 'workspaces' }).then(parseWorkspaces))
  const registry = (fresh?: boolean) => readRegistry(fresh).catch(() => [])

  const resolve = async (pins: Pins, more: { picked?: Repo; fresh?: boolean; added?: SshHost[] } = {}): Promise<Resolution> => {
    const added = more.added ?? readSettings().sshHosts
    const answer = await resolveRepo(orca, registry(more.fresh), pins, { ...more, look, added })
    return { ...answer, ...(added.length && { logins: added }), sshUser: userInfo().username }
  }

  orca.panels.handle('repo.resolve', async (input) => resolve(readPins(), { fresh: input?.fresh === true }))

  /** Remembers `repo` as the focused workspace's and resolves again. */
  async function pin(repo: Repo) {
    const { key } = await focusPinKey(orca, look)
    // With several workspaces of this name and nothing to tell them apart, a saved pick would follow the person to all of them.
    // So would a repo of this Mac saved for "no workspace named" while Orca cannot say whether a remote server is paired.
    const unsure = key === UNNAMED && repo.kind === 'local' && serversUnread(await look.remote())
    if (key === null || unsure) return resolve(readPins(), { picked: repo })
    return resolve(writePins({ ...rawPins(), [key]: repo }))
  }

  orca.panels.handle('repo.pin', async (input) => pin(repoOf(input?.repo)))

  orca.panels.handle('hosts.add', async (input): Promise<Connected> => {
    const typed = typeof input?.host === 'string' ? tidyLogin(input.host) : ''
    const fault = (fault: ConnectFault, more: { said?: string; folder?: string } = {}): Connected => ({ ok: false, fault, login: typed, ...more })
    const login = sshHostOf(typed)
    if (!login) return fault(typed ? 'not-a-login' : 'empty')
    const dir = input.dir === undefined ? undefined : remoteDirOf(input.dir)
    if (dir === null) return fault('folder-not-path')
    const replaces = input.replaces === undefined ? undefined : hostOf(input.replaces)
    // Where a pick goes is settled now: the person may focus another workspace while ssh connects.
    const [focus, before] = [await focusPinKey(orca, look), readPins()]
    const old = focus.key === null ? undefined : before[focus.key]
    // A changed login is asked for the folder of this workspace's repo, so the pick can move to it.
    const moved = old?.kind === 'ssh' && old.host === replaces ? old.dir : undefined
    // Orca's servers are asked meanwhile, so the answer below waits for ssh once.
    const [found] = await Promise.all([look.host(login, dir ?? moved, true), look.remote().catch(() => undefined)])
    if (found instanceof Error) {
      if (found.code === 'swamp_not_found') return fault('swamp-missing')
      return found.ssh ? fault(found.ssh.cause, { said: found.ssh.said }) : refuse(found.message)
    }
    if (dir && !found.at) {
      // The login answered, so it is kept; the folder is the one thing to put right.
      saveSettings({ sshHosts: [...new Set([...readSettings().sshHosts, login])] })
      return fault('folder-no-repo', { folder: dir })
    }
    const logins = [...new Set([...readSettings().sshHosts.filter((h) => h !== replaces), login])]
    const raw = rawPins()
    let repinned = false
    if (replaces && replaces !== login) {
      // Picks on the old login move to the same folder on the new one when it has that repo, and are dropped when not.
      for (const [key, repo] of Object.entries(parsePins(raw))) {
        if (repo.kind !== 'ssh' || repo.host !== replaces) continue
        repinned = true
        if (found.choices.some((c) => c.repo.dir === repo.dir)) raw[key] = { ...repo, host: login }
        else delete raw[key]
      }
      look.forget(replaces)
    }
    let answer = await resolve(parsePins(raw), { added: logins })
    // A repo is picked for the person when they named its folder, or when the login has one repo and the workspace
    // has none and its own key: under the key all unnamed remote workspaces share, the person picks.
    const only = found.choices.length === 1 && focus.key !== UNNAMED && !answer.repo ? found.choices[0].repo : undefined
    const pick = dir ? found.at : only
    const still = (await focusPinKey(orca, look)).key === focus.key
    if (pick && focus.unlisted && (dir || still)) {
      if (focus.key !== null) [raw[focus.key], repinned] = [pick, true]
      if (still) answer = { ...answer, repo: pick }
    }
    // Saved last, in one step: an add that failed anywhere above saved nothing.
    saveSettings({ sshHosts: logins })
    if (repinned) writePins(raw)
    return { ok: true, login, resolution: answer }
  })

  orca.panels.handle('hosts.remove', async (input) => {
    const host = hostOf(input?.host)
    const logins = readSettings().sshHosts
    const raw = rawPins()
    // A server Orca itself reaches over SSH through this host still uses it, so its picks stay. They also stay while
    // Orca's server list cannot be read, when that cannot be told.
    const remote = await look.remote()
    const mine = logins.includes(host) && !serversUnread(remote) && !remote.hosts.includes(host)
    const gone = mine ? Object.entries(parsePins(raw)).flatMap(([key, repo]) => (repo.kind === 'ssh' && repo.host === host ? [key] : [])) : []
    for (const key of gone) delete raw[key]
    if (gone.length) writePins(raw)
    saveSettings({ sshHosts: logins.filter((h) => h !== host) })
    look.forget(host)
    return { resolution: await resolve(parsePins(raw)), unpicked: gone.length }
  })

  orca.panels.handle('workflows.list', async (input) => {
    const repo = repoOf(input?.repo)
    const machine = repo.kind === 'ssh' ? repo.host : 'local'
    const version = versions.get(machine) ?? swamp(repo, { cmd: 'version' }).then((v) => String((v as { version?: unknown }).version ?? ''))
    versions.set(machine, version)
    version.catch(() => versions.delete(machine))
    const [search, history, approvals, v] = await Promise.all([
      swamp(repo, { cmd: 'workflow.search' }),
      swamp(repo, { cmd: 'history.search' }),
      swamp(repo, { cmd: 'approvals' }),
      version.catch(() => '')
    ])
    // Files of the runs in flight, read from this machine's disk: no swamp call, and none at all for a remote repo.
    const vitals: ReadVitals | undefined = repo.kind === 'local' ? (workflowId, runId) => runVitals(runFile(repo.dir, workflowId, runId)) : undefined
    return {
      workflows: parseWorkflowList(search, history, vitals),
      gates: parseApprovals(approvals),
      runs: parseRecent(history, vitals),
      version: v
    }
  })

  orca.panels.handle('run.get', async (input) =>
    getRun(repoOf(input?.repo), word(input.workflow, 'workflow'), input.runId === undefined ? undefined : word<RunId>(input.runId, 'run id'))
  )

  orca.panels.handle('logs.get', async (input) => {
    const [repo, runId] = [repoOf(input?.repo), word<RunId>(input.runId, 'run id')]
    const logTag = input.logTag === undefined ? undefined : word(input.logTag, 'log tag')
    return parseLogs(await swamp(repo, { cmd: 'history.logs', runId }), logTag)
  })

  orca.panels.handle('log.tail', async (input) => {
    const [repo, runId] = [repoOf(input?.repo), word<RunId>(input.runId, 'run id')]
    if (!/^[\w-]{1,64}$/.test(runId)) refuse(`'${runId}' is not a run id`)
    const ask = logAskOf(input.after, input.before)
    const limit = logLimitOf(input.limit, ask)
    const key = `${repoKey(repo)}\0${runId}`
    const workflowId = workflowIds.get(key) ?? String(((await swamp(repo, { cmd: 'history.get', workflow: runId, runId })) as { workflowId?: unknown } | null)?.workflowId ?? '')
    // The path is built from the two ids, which `runFile` checks; the panel never names a file.
    const record = runFile(repo.dir, workflowId, runId) || refuse(`swamp named no workflow for run ${runId}`)
    workflowIds.set(key, workflowId)
    return readChunk(logReader(repo, record), ask, limit)
  })

  orca.panels.handle('gate.decide', async (input) => {
    const repo = repoOf(input?.repo)
    const [workflow, runId, step] = [word(input.workflow, 'workflow'), word<RunId>(input.runId, 'run id'), word(input.step, 'step')]
    const decision = oneOf(input.decision, ['approve', 'reject'] as const, 'decision')
    const answer = await swamp(repo, { cmd: 'decide', verb: decision, workflow, runId, step, reason: noteOf(input.note) })
    if (decision === 'approve' && parseDecision(answer).allGatesDecided) {
      const key = `${repoKey(repo)}\0${runId}`
      resumeFailures.delete(key)
      startBackground(repo, { cmd: 'resume', workflow, runId }, (e) => {
        if (!e) return
        orca.log(`swamp resume ${runId} failed: ${e.message}`)
        resumeFailures.set(key, `Approved, but \`swamp workflow resume ${workflow} --run ${runId}\` failed: ${e.message}. Run it in a terminal to try again.`)
      })
    }
    return getRun(repo, workflow, runId)
  })

  orca.panels.handle('workflow.inputs', async (input) =>
    parseInputs(await swamp(repoOf(input?.repo), { cmd: 'workflow.get', workflow: word(input.workflow, 'workflow') }))
  )

  orca.panels.handle('run.start', async (input) => {
    const [repo, workflow] = [repoOf(input?.repo), word(input.workflow, 'workflow')]
    const again = input.again === undefined ? undefined : word<RunId>(input.again, 'run id')
    const texts = textsOf(input.inputs)
    const [inputs, before] = await Promise.all([
      again
        ? swamp(repo, { cmd: 'history.get', workflow, runId: again }).then((raw) => {
            // swamp finds a run by its id alone, and another workflow's inputs are not this one's.
            const of = (raw as { workflowName?: unknown } | null)?.workflowName
            return of === workflow ? rawInputs(raw) : refuse(`run ${again} belongs to workflow ${String(of)}, not ${workflow}`)
          })
        : swamp(repo, { cmd: 'workflow.get', workflow }).then((def) => typedInputs(parseInputs(def), texts)),
      latestRunId(repo, workflow)
    ])
    const runId = await started(repo, { cmd: 'run', workflow, inputs: inputNames(inputs) }, async () => {
      const latest = await latestRunId(repo, workflow)
      return latest !== before ? (latest as RunId) : undefined
    })
    return runId ? { runId } : {}
  })

  orca.panels.handle('run.act', async (input) => {
    const [repo, workflow, runId] = [repoOf(input?.repo), word(input.workflow, 'workflow'), word<RunId>(input.runId, 'run id')]
    const action = oneOf(input.action, ['stop', 'retry', 'recover'] as const, 'action')
    const from = input.from === undefined ? undefined : { job: word(input.from?.job, 'job'), step: word(input.from?.step, 'step') }
    if (from && action !== 'retry') refuse(`only a retry starts from a step, not ${action}`)
    if (action === 'stop') {
      await swamp(repo, { cmd: 'cancel', workflow, runId })
      return getRun(repo, workflow, runId)
    }
    if (action === 'recover') await swamp(repo, { cmd: 'recover', workflow, runId })
    resumeFailures.delete(`${repoKey(repo)}\0${runId}`)
    // Until resume takes the run, it reads as it does now: failed, or suspended after a recover.
    const before = (await getRun(repo, workflow, runId)).status
    const moved = await started(repo, { cmd: 'resume', workflow, runId, from }, async (ended) => {
      const run = await getRun(repo, workflow, runId)
      return ended || run.status !== before ? run : undefined
    })
    return moved ?? getRun(repo, workflow, runId)
  })

  orca.panels.handle('agent.terminal', () => agentTerminal(orca))

  orca.panels.handle('failure.send', async (input) => {
    const repo = repoOf(input?.repo)
    const [workflow, runId] = [word(input.workflow, 'workflow'), word<RunId>(input.runId, 'run id')]
    if (repo.kind === 'ssh') {
      refuse(`Send failure types into a terminal on this Mac, and this run is on ${repo.host}, whose terminals Orca does not name. Copy the retry command instead.`)
    }
    const [run, target] = await Promise.all([getRun(repo, workflow, runId), agentTerminal(orca)])
    const step = firstFailed(run)
    if (!step) throw new SwampFailure('swamp_error', `run ${runId} has no failed step`)
    if (!target) throw new SwampFailure('swamp_error', 'the focused workspace has no terminal')
    const { accepted } = await orca.host.call('terminal.sendText', { terminalId: target.id, text: failurePrompt(run, step) })
    if (!accepted) throw new SwampFailure('swamp_error', `${target.title} did not accept the text`)
    return target
  })

  // ponytail: one entry per repo the panel showed in this worker's life.
  const shown = new Map<string, Repo>()
  // Each swamp call ends within its own read timeout, so one slow repo holds the answer for that long at most.
  const inbox = remembered(INBOX_FRESH_MS, async () => {
    const [list, tracked] = await Promise.all([orca.host.call('workspace.list').catch(() => ({ workspaces: [] })), registry()])
    const repos = inboxRepos(list.workspaces.map((w) => w.path), tracked, readPins(), [...shown.values()])
    return readInbox(repos, (repo) => Promise.all([swamp(repo, { cmd: 'approvals' }), swamp(repo, { cmd: 'data.query', predicate: runsQuery() })]), now())
  })

  orca.panels.handle('inbox.list', async (input) => {
    const repo = input?.repo === undefined ? undefined : repoOf(input.repo)
    // A repo the panel shows for the first time may be in no pin or registry, so the remembered answer may lack it.
    const first = !!repo && !shown.has(repoKey(repo))
    if (repo) shown.set(repoKey(repo), repo)
    return inbox(input?.fresh === true || first)
  })

  orca.panels.handle('factories.list', async (input) => {
    const repo = repoOf(input?.repo)
    const [types, models, runs] = await Promise.all([
      swamp(repo, { cmd: 'types.stagecraft' }),
      swamp(repo, { cmd: 'models' }),
      swamp(repo, { cmd: 'data.query', predicate: runsQuery() })
    ])
    return parseFactories(types, models, runs, now())
  })

  orca.panels.handle('factory.board', async (input) => {
    const [repo, factory] = [repoOf(input?.repo), word(input.factory, 'factory')]
    const [model, runs] = await Promise.all([
      swamp(repo, { cmd: 'model.get', name: safeName(factory, 'factory') }),
      swamp(repo, { cmd: 'data.query', predicate: runsQuery(factory) })
    ])
    return parseBoard(model, runs, now())
  })

  orca.panels.handle('workitem.get', async (input) => workItem(repoOf(input?.repo), word(input.key, 'work item')))

  orca.panels.handle('workitem.decide', async (input) => {
    const [repo, key, gateId] = [repoOf(input?.repo), word(input.key, 'work item'), word(input.gateId, 'gate')]
    const decision = oneOf(input.decision, ['approve', 'decline'] as const, 'decision')
    const note = noteOf(input.note)
    return oneAtATime(`${repoKey(repo)}\0${key}`, () => decide(repo, key, gateId, decision, note))
  })


  orca.panels.handle('studio.start', async (input) => {
    const repo = repoOf(input?.repo)
    let url = studios.get(repoKey(repo))
    if (!url) {
      url = studio(repo)
      studios.set(repoKey(repo), url)
      url.catch(() => studios.delete(repoKey(repo)))
    }
    return { url: await url }
  })

  orca.panels.handle('theme.get', () => ({ theme: readSettings().theme }))

  orca.panels.handle('theme.set', (input) => {
    const saved = parseThemeId(input?.theme)
    if (saved !== input?.theme) refuse(`there is no theme '${String(input?.theme)}'`)
    return { theme: saveSettings({ theme: saved }).theme }
  })

  orca.panels.handle('inbox.enabled', (input) => {
    if (input?.on !== undefined && typeof input.on !== 'boolean') refuse('on is not true or false')
    return { on: (input?.on === undefined ? readSettings() : saveSettings({ inbox: input.on })).inbox }
  })

  orca.panels.handle('clipboard.copy', async (input) => {
    await copyToClipboard(typeof input?.text === 'string' ? input.text : refuse('the panel sent no text to copy'))
    orca.log('the panel frame could not write the clipboard, so the worker copied with pbcopy')
    return { copied: true as const }
  })
}

export async function deactivate(): Promise<void> {
  await stopStudios()
}
