import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  parseApprovals,
  parseDecision,
  parseLogs,
  parseRecent,
  parseRun,
  parseWorkflowList,
  RECENT_LENGTH,
  repoKey,
  SwampFailure,
  type Repo,
  type RepoDir,
  type Run,
  type RunId
} from './domain'
import { inboxRepos, readInbox } from './inbox'
import { failurePrompt, firstFailed } from './present'
import type { AgentTerminal } from './protocol'
import { focusPinKey, parsePins, parseWorkspaces, remembered, rememberedLookups, resolveRepo, type Pins } from './repo'
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
import { copyToClipboard, startResume, startStudio, stopStudios, swamp } from './swamp'
import { parseThemeId, type ThemeId } from './theme'

// A failed run is not kept: `swamp workflow resume --run <id> --from <step>` retries it under the same id.
const finishedRuns = new Map<string, Run>()
// swamp's version per machine: one swamp binary serves every repo on it.
const versions = new Map<string, Promise<string>>()

// ponytail: pins live in a small JSON file because `storage:own` would add a capability.
const pinsFile = (): string => process.env.SWAMPLING_PINS ?? join(homedir(), '.config/swampling/pins.json')

function readPins(): Pins {
  try {
    return parsePins(JSON.parse(readFileSync(pinsFile(), 'utf8')))
  } catch {
    return {}
  }
}

const settingsFile = (): string => join(dirname(pinsFile()), 'settings.json')

/** `inbox` is whether the panel shows the "Needs you" tab and reads every repo for it. */
type Settings = { theme: ThemeId; inbox: boolean }

function readSettings(): Settings {
  try {
    const saved = JSON.parse(readFileSync(settingsFile(), 'utf8')) as { theme?: unknown; inbox?: unknown } | null
    return { theme: parseThemeId(saved?.theme), inbox: saved?.inbox !== false }
  } catch {
    return { theme: 'orca', inbox: true }
  }
}

function saveSettings(change: Partial<Settings>): Settings {
  const settings = { ...readSettings(), ...change }
  mkdirSync(dirname(settingsFile()), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
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
  const run = sameWorkflow(parseRun(def, raw, gates), workflow)
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

  orca.panels.handle('repo.resolve', async (input) => {
    const fresh = input?.fresh === true
    return resolveRepo(orca, registry(fresh), readPins(), { look, fresh })
  })

  orca.panels.handle('repo.pin', async (input) => {
    const repo = repoOf(input?.repo)
    const key = await focusPinKey(orca, look)
    // With several workspaces of this name and nothing to tell them apart, a saved pick would follow the person to all of them.
    if (key === null) return resolveRepo(orca, registry(), readPins(), { picked: repo, look })
    const pins = { ...readPins(), [key]: repo }
    mkdirSync(dirname(pinsFile()), { recursive: true })
    writeFileSync(pinsFile(), JSON.stringify(pins, null, 2))
    return resolveRepo(orca, registry(), pins, { look })
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
    return {
      workflows: parseWorkflowList(search, history),
      gates: parseApprovals(approvals),
      recent: parseRecent(history).slice(0, RECENT_LENGTH),
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

  orca.panels.handle('gate.decide', async (input) => {
    const repo = repoOf(input?.repo)
    const [workflow, runId, step] = [word(input.workflow, 'workflow'), word<RunId>(input.runId, 'run id'), word(input.step, 'step')]
    const decision = oneOf(input.decision, ['approve', 'reject'] as const, 'decision')
    const answer = await swamp(repo, { cmd: 'decide', verb: decision, workflow, runId, step, reason: noteOf(input.note) })
    if (decision === 'approve' && parseDecision(answer).allGatesDecided) {
      const key = `${repoKey(repo)}\0${runId}`
      resumeFailures.delete(key)
      startResume(repo, workflow, runId, (e) => {
        orca.log(`swamp resume ${runId} failed: ${e.message}`)
        resumeFailures.set(key, `Approved, but \`swamp workflow resume ${workflow} --run ${runId}\` failed: ${e.message}. Run it in a terminal to try again.`)
      })
    }
    return getRun(repo, workflow, runId)
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
