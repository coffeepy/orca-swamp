import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { isLive } from './domain'

// Stand-ins on PATH for the orca CLI and ssh: orca answers captured JSON with its /home/dev paths moved under
// a temp folder, and ssh runs the remote command string in a local sh, as the remote login shell would. It fails
// like an unreachable host for `down`, and takes a second to connect to `slow`.
const fake = mkdtempSync(join(tmpdir(), 'swampling-fake-'))
const fixture = (name: string) => new URL(`./fixtures/${name}.json`, import.meta.url).pathname
function script(name: string, body: string): string {
  const path = join(fake, 'bin', name)
  mkdirSync(join(fake, 'bin'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
process.env.ORCA_CLI_COMMAND = script(
  'orca',
  `case "$1 $2" in
  "environment list") cat '${fixture('orca.environment-list')}' ;;
  "host list") cat '${fixture('orca.host-list')}' ;;
  "worktree list") sed 's#/home/dev#${fake}/home#g' '${fixture('orca.worktree-list-jarvis')}' ;;
  "terminal show") echo "$4" >> '${fake}/terminal.log'; cat "${fake}/terminal-$4.json" 2>/dev/null ;;
esac`
)
script('ssh', `for a; do host=$prev; last=$a; prev=$a; done; printf '%s\\n' "$*" >> '${fake}/ssh.log'; [ "$host" = down ] && { echo 'ssh: connect to host down port 22: Connection refused' >&2; exit 255; }; [ "$host" = slow ] && sleep 1; HOME='${fake}/home' exec sh -c "$last"`)
process.env.PATH = `${fake}/bin:${process.env.PATH}`

// A local swamp stand-in: answers by the longest key its arguments start with from $FAKE_SWAMP_ANSWERS, and logs
// each call's arguments and process id there. An answer is stdout, or { stdout, stderr, exit, delay } (it exits `delay` ms after printing),
// or a list of those used one per call.
writeFileSync(
  join(fake, 'swamp.cjs'),
  `const fs = require('fs')
const file = process.env.FAKE_SWAMP_ANSWERS
const args = process.argv.slice(2)
if (!file) { console.log('{}'); process.exit(0) }
fs.appendFileSync(file + '.log', JSON.stringify(args) + '\\n')
fs.appendFileSync(file + '.pids', process.pid + '\\n')
const answers = JSON.parse(fs.readFileSync(file, 'utf8'))
const key = Object.keys(answers).filter((k) => args.join(' ').startsWith(k)).sort((a, b) => b.length - a.length)[0]
let a = key === undefined ? '{}' : answers[key]
if (Array.isArray(a)) {
  const counter = file + '.' + Buffer.from(key).toString('hex')
  fs.appendFileSync(counter, 'x')
  a = a[Math.min(fs.statSync(counter).size - 1, a.length - 1)]
}
if (typeof a === 'string') a = { stdout: a }
process.stderr.write(a.stderr ?? '')
process.stdout.write(a.stdout ?? '', () => setTimeout(() => process.exit(a.exit ?? 0), a.delay ?? 0))
`
)
process.env.SWAMPLING_BIN = script('swamp', `ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} '${join(fake, 'swamp.cjs')}' "$@"`)
const main = await import('./worker')

type Answer = string | { stdout?: string; stderr?: string; exit?: number; delay?: number }
/** A local swamp repo whose swamp answers `answers`, and the argument lists swamp was called with so far. */
function localRepo(answers: Record<string, Answer | Answer[]>) {
  const dir = folder('.')
  const file = join(dir, 'answers.json')
  writeFileSync(file, JSON.stringify(answers))
  process.env.FAKE_SWAMP_ANSWERS = file
  const calls = (): string[][] => {
    try {
      return readFileSync(file + '.log', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  const pids = (): number[] => readFileSync(file + '.pids', 'utf8').trim().split('\n').map(Number)
  return { repo: { kind: 'local', dir } as never, calls, pids }
}
const read = (name: string) => readFileSync(fixture(name), 'utf8')

function folder(...repos: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'swampling-'))
  for (const r of repos) {
    mkdirSync(join(root, r), { recursive: true })
    writeFileSync(join(root, r, '.swamp.yaml'), 'swampVersion: test\n')
  }
  return root
}

function host(focused: string, others: string[] = []) {
  return mockHost({
    results: {
      'workspace.readContext': { displayName: 'demo', branch: 'main', terminals: [] },
      'workspace.list': {
        truncated: false,
        workspaces: [
          { id: 'w1', kind: 'folder', name: 'demo', path: focused, branch: 'refs/heads/main', hostId: null },
          ...others.map((path, i) => ({ id: `o${i}`, kind: 'folder', name: 'main', path, branch: 'main', hostId: null }))
        ]
      }
    }
  })
}

test('finds the swamp repo the focused workspace sits in, as swamp does from a subfolder', async () => {
  const repo = folder('.')
  const ws = join(repo, 'packages', 'app')
  mkdirSync(ws, { recursive: true })
  const worker = await mountWorker(main, { host: host(ws) })
  const answer = await worker.request('repo.resolve', {})
  assert.deepEqual(answer.repo, { kind: 'local', dir: repo })
  assert.deepEqual(worker.refusals, [])
})

test('a pin wins over the focused workspace and survives the next resolve', async () => {
  const ws = folder()
  const other = folder('.')
  const worker = await mountWorker(main, { host: host(ws, [other]) })
  const open = await worker.request('repo.resolve', {})
  assert.equal(open.repo, null)
  assert.ok(open.candidates.some((c) => c.repo.dir === other), 'a repo another workspace sits in is offered')
  process.env.SWAMPLING_PINS = join(folder(), 'pins.json')
  const pinned = await worker.request('repo.pin', { repo: { kind: 'local', dir: other } as never })
  assert.deepEqual(pinned.repo, { kind: 'local', dir: other })
  assert.deepEqual((await worker.request('repo.resolve', {})).repo, { kind: 'local', dir: other }, 'the pin survives the next resolve')
})

test('the "Needs you" tab is on until the person turns it off, and the choice survives a restart and a theme change', async () => {
  const dir = folder()
  process.env.SWAMPLING_PINS = join(dir, 'pins.json')
  const first = await mountWorker(main, { host: host(dir) })
  assert.deepEqual(await first.request('inbox.enabled', {}), { on: true })
  assert.deepEqual(await first.request('inbox.enabled', { on: false }), { on: false })
  await first.request('theme.set', { theme: 'peat' })
  const second = await mountWorker(main, { host: host(dir) })
  assert.deepEqual(await second.request('inbox.enabled', {}), { on: false })
  assert.deepEqual(await second.request('theme.get', {}), { theme: 'peat' })
  assert.deepEqual(await second.request('inbox.enabled', { on: true }), { on: true })
})

test('the chosen theme survives a worker restart, and a damaged settings file falls back to Orca', async () => {
  const dir = folder()
  process.env.SWAMPLING_PINS = join(dir, 'pins.json')
  const first = await mountWorker(main, { host: host(dir) })
  assert.deepEqual(await first.request('theme.get', {}), { theme: 'orca' })
  await first.request('theme.set', { theme: 'peat' })
  const second = await mountWorker(main, { host: host(dir) })
  assert.deepEqual(await second.request('theme.get', {}), { theme: 'peat' })
  writeFileSync(join(dir, 'settings.json'), '{"theme": "peat", "pinball": true}')
  assert.deepEqual(await second.request('theme.get', {}), { theme: 'peat' }, 'a key an older version saved is ignored')
  writeFileSync(join(dir, 'settings.json'), '{"theme": "neon"')
  assert.deepEqual(await second.request('theme.get', {}), { theme: 'orca' })
  assert.deepEqual(second.refusals, [])
})

test('a focused workspace Orca does not list is reported, not silently empty', async () => {
  const worker = await mountWorker(main, {
    host: mockHost({
      results: {
        'workspace.readContext': { displayName: 'elsewhere', branch: 'main', terminals: [] },
        'workspace.list': { truncated: false, workspaces: [] }
      }
    })
  })
  const answer = await worker.request('repo.resolve', {})
  assert.equal(answer.repo, null)
  assert.deepEqual(answer.workspace, { name: 'elsewhere', listed: false })
})

test('with the focus on a remote Orca server, its repos are offered, a pick is remembered, and workflows are read there over ssh', async () => {
  const repo = join(fake, 'home/swampling-playground')
  mkdirSync(join(fake, 'home/.local/bin'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, '.swamp.yaml'), 'swampVersion: test\n')
  const answers: Record<string, string> = {
    'workspace list': '{"workspaces":[]}',
    'workflow search': readFileSync(fixture('e2e.workflow-search'), 'utf8'),
    'workflow history': readFileSync(fixture('issue-factory.history-search'), 'utf8'),
    'workflow approvals': readFileSync(fixture('gated.approvals'), 'utf8'),
    version: '{"version":"20261106.235013.0"}'
  }
  writeFileSync(join(fake, 'answers.json'), JSON.stringify(answers))
  const swampBin = join(fake, 'home/.local/bin/swamp')
  writeFileSync(
    swampBin,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} -e 'const a=require(process.argv[1]);const k=Object.keys(a).find(k=>process.argv.slice(2).join(" ").startsWith(k));require("fs").appendFileSync(process.argv[1]+".log",process.cwd()+"\\n");console.log(a[k]??"{}")' '${join(fake, 'answers.json')}' "$@"\n`
  )
  chmodSync(swampBin, 0o755)
  const worker = await mountWorker(main, {
    host: mockHost({
      results: {
        'workspace.readContext': null,
        'workspace.list': { truncated: false, workspaces: [] }
      }
    })
  })
  process.env.SWAMPLING_PINS = join(fake, 'pins.json')
  const offered = await worker.request('repo.resolve', {})
  const playground = { kind: 'ssh', host: 'jarvis', dir: repo }
  assert.equal(offered.repo, null, 'Orca names no workspace, so nothing is chosen for the person')
  assert.deepEqual(offered.remoteHosts, ['jarvis'])
  assert.deepEqual(offered.candidates.find((c) => c.repo.kind === 'ssh')?.repo, playground)
  assert.ok(offered.candidates.every((c) => c.repo.kind === 'ssh'), 'a workspace on a remote host is not offered the repos of this Mac')
  assert.ok(offered.candidates.every((c) => c.repo.kind === 'ssh'), 'a remote focus is offered only remote repos')
  const mac = folder('.')
  writeFileSync(process.env.SWAMPLING_PINS, JSON.stringify({ '@remote-or-none': { kind: 'local', dir: mac } }))
  assert.equal((await worker.request('repo.resolve', {})).repo, null, 'a local repo pinned during a remote focus does not stick to remote workspaces')
  await worker.request('repo.pin', { repo: playground as never })
  const answer = await worker.request('repo.resolve', {})
  assert.deepEqual(answer.repo, playground, 'the pick holds for the next resolve')
  const list = await worker.request('workflows.list', { repo: answer.repo! })
  assert.ok(list.workflows.length > 0, 'workflows come from swamp on the remote host')
  assert.deepEqual(
    list.runs,
    [{ workflow: 'issue-factory', runId: 'ee6e9038-d4ef-432a-815e-7ab33a57f58f', status: 'succeeded', startedAt: '2026-10-26T19:25:08.936Z', input: 'ISSUE-101', inputs: 'fast', durationMs: 3963 }],
    'every run of the repo, with what the search, the time chips and the sorts read'
  )
  assert.equal(list.version, '20261106.235013.0')
  assert.ok(readFileSync(join(fake, 'ssh.log'), 'utf8').includes('jarvis'), 'ssh was asked for the host Orca deployed the server through')
  assert.ok(readFileSync(join(fake, 'answers.json.log'), 'utf8').split('\n').includes(realpathSync(repo)), 'swamp ran in the remote repo folder')
})

test('a workspace Orca names but does not list gets the remote repos: its own by name and branch, or a pick that is remembered', async () => {
  // The test before left a swamp repo and a swamp stand-in under the fake remote home.
  const playground = { kind: 'ssh', host: 'jarvis', dir: join(fake, 'home/swampling-playground') }
  const unlisted = (displayName: string, branch: string) =>
    mountWorker(main, { host: mockHost({ results: { 'workspace.readContext': { displayName, branch, terminals: [] }, 'workspace.list': { truncated: false, workspaces: [] } } }) })
  process.env.SWAMPLING_PINS = join(fake, 'pins-unlisted.json')
  const own = await (await unlisted('master', 'master')).request('repo.resolve', {})
  assert.deepEqual(own.repo, playground, 'the one remote workspace of this name and branch sits in this repo')
  assert.deepEqual(own.workspace, { name: 'master', listed: false })
  assert.deepEqual(own.remoteHosts, ['jarvis'])
  const worker = await unlisted('elsewhere', 'main')
  const offered = await worker.request('repo.resolve', {})
  assert.equal(offered.repo, null, 'no remote workspace has this name, so the person picks')
  assert.deepEqual(offered.candidates.find((c) => c.repo.kind === 'ssh')?.repo, playground)
  assert.ok(offered.candidates.every((c) => c.repo.kind === 'ssh'), 'a workspace on a remote host is not offered the repos of this Mac')
  assert.deepEqual((await worker.request('repo.pin', { repo: playground as never })).repo, playground)
  assert.deepEqual(JSON.parse(readFileSync(process.env.SWAMPLING_PINS, 'utf8')), { elsewhere: playground }, 'the pick is saved for this workspace only')
  assert.deepEqual((await worker.request('repo.resolve', {})).repo, playground, 'the pick holds for the next resolve')
  const asked = readFileSync(join(fake, 'ssh.log'), 'utf8')
  const dir = folder('.')
  assert.equal((await (await mountWorker(main, { host: host(dir) })).request('repo.resolve', {})).repo?.dir, dir)
  assert.equal(readFileSync(join(fake, 'ssh.log'), 'utf8'), asked, 'a listed workspace asks no remote host')
})

const GATED_RUN = '0fdef291-426e-4ec9-a2c0-92bc24c3a7d8' as never
const BROKEN_RUN = '54f9fdbe-ab05-481d-8ee2-02032885af81' as never
const gatedRepo = () =>
  localRepo({
    'workflow get gated': read('gated.def'),
    'workflow get breaks': read('breaks.def'),
    [`workflow history get ${GATED_RUN}`]: read('gated.run-suspended'),
    [`workflow history get ${BROKEN_RUN}`]: read('breaks.run-failed'),
    'workflow approvals': read('gated.approvals'),
    'workflow approve': '{"approved":true,"allGatesDecided":true}',
    'workflow reject': '{"approved":false,"allGatesDecided":true}'
  })
const verbs = (calls: string[][]) => calls.map((c) => c.slice(0, 2).join(' '))
const settle = () => new Promise((r) => setTimeout(r, 300))

test('approving the last gate starts resume for that run; rejecting does not', async () => {
  const { repo, calls } = gatedRepo()
  const worker = await mountWorker(main, { host: host(folder()) })
  const decision = { repo, workflow: 'gated', runId: GATED_RUN, step: 'signoff' }
  await worker.request('gate.decide', { ...decision, decision: 'reject' })
  await settle()
  assert.ok(!verbs(calls()).includes('workflow resume'), 'a reject leaves the run to swamp')
  const run = await worker.request('gate.decide', { ...decision, decision: 'approve', note: 'looks right' })
  assert.equal(run.id, GATED_RUN)
  await settle()
  assert.deepEqual(calls().find((c) => c[1] === 'approve'), ['workflow', 'approve', 'gated', 'signoff', '--run', GATED_RUN, '--reason', 'looks right', '--json', '--no-color'])
  assert.deepEqual(calls().find((c) => c[1] === 'resume')?.slice(0, 4), ['workflow', 'resume', 'gated', '--run'])
})

test('a gate decision other than approve or reject is refused before swamp runs anything', async () => {
  const { repo, calls } = gatedRepo()
  const worker = await mountWorker(main, { host: host(folder()) })
  for (const decision of ['delete', 'cancel', 'resume']) {
    await assert.rejects(worker.request('gate.decide', { repo, workflow: 'gated', runId: GATED_RUN, step: 'signoff', decision: decision as never }), /decision/)
  }
  assert.deepEqual(calls(), [], 'swamp was never asked to run the word the panel sent')
})

test('a blank note is not recorded as the reason, and a note too long for a command line is refused clearly', async () => {
  const { repo, calls } = gatedRepo()
  const worker = await mountWorker(main, { host: host(folder()) })
  const decision = { repo, workflow: 'gated', runId: GATED_RUN, step: 'signoff', decision: 'approve' as const }
  await worker.request('gate.decide', { ...decision, note: '   \n ' })
  assert.ok(!calls().find((c) => c[1] === 'approve')!.includes('--reason'), 'whitespace is no reason')
  await assert.rejects(worker.request('gate.decide', { ...decision, note: 'x'.repeat(2_000_000) }), /note/)
})

test('a run asked for under another workflow is refused instead of drawn with that workflow’s steps', async () => {
  const { repo } = gatedRepo()
  const worker = await mountWorker(main, { host: host(folder()) })
  await assert.rejects(worker.request('run.get', { repo, workflow: 'breaks', runId: GATED_RUN }), /gated/)
  assert.equal((await worker.request('run.get', { repo, workflow: 'breaks', runId: BROKEN_RUN })).status, 'failed')
  await assert.rejects(worker.request('run.get', { repo, workflow: 'gated', runId: BROKEN_RUN }), /breaks/)
})

test('a failed run that was retried under the same id shows its new status, not the failure read before', async () => {
  const { repo } = localRepo({
    'workflow get breaks': read('breaks.def'),
    [`workflow history get ${BROKEN_RUN}`]: [read('breaks.run-failed'), JSON.stringify({ ...JSON.parse(read('breaks.run-failed')), status: 'running' })]
  })
  const worker = await mountWorker(main, { host: host(folder()) })
  const get = () => worker.request('run.get', { repo, workflow: 'breaks', runId: BROKEN_RUN })
  assert.equal((await get()).status, 'failed')
  assert.equal((await get()).status, 'running', '`swamp workflow resume --run <id> --from <step>` keeps the run id')
})

test('malformed panel input gets a clear failure instead of a crash or a silently wrong answer', async () => {
  const { repo, calls } = gatedRepo()
  const worker = await mountWorker(main, { host: host(folder()) })
  const clear = (e: unknown) => {
    const message = (e as Error).message
    assert.ok(!/undefined|Cannot read|is not a function|ERR_/.test(message), message)
    return true
  }
  await assert.rejects(worker.request('workflows.list', {} as never), clear)
  await assert.rejects(worker.request('workflows.list', { repo: { kind: 'local', dir: 'relative/path' } as never }), clear)
  await assert.rejects(worker.request('workflows.list', { repo: { kind: 'ssh', host: '-oProxyCommand=x', dir: '/r' } as never }), clear)
  await assert.rejects(worker.request('logs.get', { repo } as never), clear)
  await assert.rejects(worker.request('run.get', { repo, workflow: '--help' }), clear)
  await assert.rejects(worker.request('gate.decide', { repo, workflow: 'gated', runId: GATED_RUN, decision: 'approve' } as never), clear)
  await assert.rejects(worker.request('workitem.get', { repo } as never), clear)
  await assert.rejects(worker.request('clipboard.copy', {} as never), clear)
  await assert.rejects(worker.request('repo.pin', { repo: { kind: 'local' } } as never), clear)
  assert.deepEqual(calls(), [], 'nothing malformed reached swamp')
})

test('a theme that does not exist is refused and the saved theme stays', async () => {
  process.env.SWAMPLING_PINS = join(folder(), 'pins.json')
  const worker = await mountWorker(main, { host: host(folder()) })
  await worker.request('theme.set', { theme: 'peat' })
  await assert.rejects(worker.request('theme.set', { theme: 'neon' as never }), /neon/)
  assert.deepEqual(await worker.request('theme.get', {}), { theme: 'peat' })
})

test('Send failure types the failed step into the agent terminal, and for a remote repo says why instead', async () => {
  const { repo } = gatedRepo()
  const worker = await mountWorker(main, {
    host: mockHost({
      results: {
        'workspace.readContext': { displayName: 'demo', branch: 'main', terminals: [{ id: 't1', title: 'zsh' }, { id: 't2', title: 'claude' }] },
        'terminal.sendText': { accepted: true }
      }
    })
  })
  assert.deepEqual(await worker.request('failure.send', { repo, workflow: 'breaks', runId: BROKEN_RUN }), { id: 't2', title: 'claude', workspace: 'demo' })
  const sent = worker.host.callsOf('terminal.sendText') as { terminalId: string; text: string }[]
  assert.equal(sent[0].terminalId, 't2')
  assert.ok(sent[0].text.includes('right'), 'the failed step is named')
  await assert.rejects(worker.request('failure.send', { repo: { kind: 'ssh', host: 'jarvis', dir: '/r' } as never, workflow: 'breaks', runId: BROKEN_RUN }), /jarvis/)
  assert.equal(worker.host.callsOf('terminal.sendText').length, 1, 'nothing was typed for the remote run')
  assert.deepEqual(worker.refusals, [])
})

const ITEM = 'data query modelType == "@swamp/stagecraft/work-item" && modelName == "team-4" && !name'
const OLDER = 'data query modelType == "@swamp/stagecraft/work-item" && modelName == "team-4" && ('
const METHOD = 'model @swamp/stagecraft/work-item method run'
const methods = (calls: string[][]) => calls.filter((c) => c.join(' ').startsWith(METHOD)).map((c) => c[4])

test('two presses of Approve on one work item record one approval and one advance', async () => {
  const waiting = read('sc.item-team-4')
  const moved = read('sc.item-team-7')
  const { repo, calls } = localRepo({
    [ITEM]: [waiting, waiting, moved],
    [OLDER]: '{"results":[]}',
    [`${METHOD} approve`]: { stdout: '{}', delay: 300 },
    [`${METHOD} advance`]: '{}'
  })
  const worker = await mountWorker(main, { host: host(folder()) })
  const press = () => worker.request('workitem.decide', { repo, key: 'team-4', gateId: 'plan-approval', decision: 'approve' }).then((r) => r, (e: Error) => e)
  const answers = await Promise.all([press(), press()])
  assert.deepEqual(methods(calls()), ['approve', 'advance'])
  assert.equal(answers.filter((a) => !(a instanceof Error) && a.advanced === 'implement').length, 1, 'one press approved and advanced')
  assert.match(String(answers.find((a) => a instanceof Error)), /not waiting on plan-approval/)
})

test('an advance that fails after the approval is reported with the approved item', async () => {
  const { repo, calls } = localRepo({
    [ITEM]: read('sc.item-team-4'),
    [OLDER]: '{"results":[]}',
    [`${METHOD} approve`]: '{}',
    [`${METHOD} advance`]: { stdout: '{"error":"expected stage plan-review, found implement"}', exit: 1 }
  })
  const worker = await mountWorker(main, { host: host(folder()) })
  const answer = await worker.request('workitem.decide', { repo, key: 'team-4', gateId: 'plan-approval', decision: 'approve', note: 'ship it' })
  assert.equal(answer.item.key, 'team-4')
  assert.equal(answer.advanced, undefined)
  assert.match(answer.advanceError ?? '', /expected stage/)
  const approve = calls().find((c) => c[4] === 'approve')!
  assert.ok(approve.includes('note:json="ship it"'), approve.join(' '))
})

test('a work item decision other than approve or decline is refused, so no other method runs for the person', async () => {
  const { repo, calls } = localRepo({ [ITEM]: read('sc.item-team-4'), [OLDER]: '{"results":[]}' })
  const worker = await mountWorker(main, { host: host(folder()) })
  for (const decision of ['advance', 'grant_override', 'reset']) {
    await assert.rejects(worker.request('workitem.decide', { repo, key: 'team-4', gateId: 'plan-approval', decision: decision as never }), /decision/)
  }
  assert.deepEqual(methods(calls()), [])
})

test('Studio pressed twice starts one studio serve, and one that fails to start is retried on the next press', async () => {
  const { repo, calls } = localRepo({
    'model search': read('sc.models'),
    'model method run studio serve': [
      { stdout: 'error: port 4141 is already in use\n', exit: 1 },
      { stdout: 'studio: http://127.0.0.1:4141/\n', delay: 1500 }
    ]
  })
  const worker = await mountWorker(main, { host: host(folder()) })
  await assert.rejects(worker.request('studio.start', { repo }), /already in use/)
  const [a, b] = await Promise.all([worker.request('studio.start', { repo }), worker.request('studio.start', { repo })])
  assert.deepEqual([a, b], [{ url: 'http://127.0.0.1:4141/' }, { url: 'http://127.0.0.1:4141/' }])
  assert.equal(calls().filter((c) => c.includes('serve')).length, 2, 'one failed start, then one studio for both presses')
  await assert.rejects(worker.request('studio.start', { repo: { kind: 'ssh', host: 'jarvis', dir: '/r' } as never }), /port forward/)
})


test('a resume that fails after the last approval shows its error on the gate and stops the fast refresh', async () => {
  const { repo } = localRepo({
    'workflow get gated': read('gated.def'),
    [`workflow history get ${GATED_RUN}`]: read('gated.run-approved'),
    'workflow approvals': read('gated.approvals'),
    'workflow approve': '{"approved":true,"allGatesDecided":true}',
    'workflow resume': { stderr: '{"error":"run is locked by another swamp process"}', exit: 1 }
  })
  const worker = await mountWorker(main, { host: host(folder()) })
  await worker.request('gate.decide', { repo, workflow: 'gated', runId: GATED_RUN, step: 'signoff', decision: 'approve' })
  await settle()
  const run = await worker.request('run.get', { repo, workflow: 'gated', runId: GATED_RUN })
  const signoff = run.jobs.flatMap((j) => j.stages.flat()).find((s) => s.name === 'signoff')!
  assert.equal(signoff.status, 'failed')
  assert.match(signoff.status === 'failed' ? signoff.error : '', /locked by another swamp process/)
  assert.match(signoff.status === 'failed' ? signoff.error : '', /swamp workflow resume gated --run/)
  assert.equal(isLive(run), false, 'the panel stops refreshing every 2 s')
})

test('stopping the worker stops the studio it started, so the next Studio press finds its port free', async () => {
  const { repo, pids } = localRepo({
    'model search': read('sc.models'),
    'model method run studio serve': { stdout: 'studio: http://127.0.0.1:4141/\n', delay: 60_000 }
  })
  const worker = await mountWorker(main, { host: host(folder()) })
  assert.deepEqual(await worker.request('studio.start', { repo }), { url: 'http://127.0.0.1:4141/' })
  const studioPid = pids().at(-1)!
  await worker.deactivate()
  assert.throws(() => process.kill(studioPid, 0), /ESRCH/)
})

if (process.platform === 'darwin') {
  test('copied text with accents and symbols pastes back unchanged when Orca starts without LANG', async () => {
    // The ruler pasteboard, which nothing uses, keeps the person's clipboard untouched.
    script('pbcopy', 'exec /usr/bin/pbcopy -pboard ruler')
    const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE }
    for (const k of Object.keys(saved)) delete process.env[k]
    try {
      const worker = await mountWorker(main, { host: host(folder()) })
      await worker.request('clipboard.copy', { text: 'café ✓ — ok' })
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
    }
    const pasted = execFileSync('/usr/bin/pbpaste', ['-pboard', 'ruler'], { env: { LANG: 'en_US.UTF-8' }, encoding: 'utf8' })
    assert.equal(pasted, 'café ✓ — ok')
  })
}

test('a swamp command line too long for the system is refused in words, not as spawn E2BIG', async () => {
  const { repo } = localRepo({})
  const worker = await mountWorker(main, { host: host(folder()) })
  await assert.rejects(worker.request('run.get', { repo, workflow: 'w'.repeat(2_000_000) }), (e: unknown) => {
    const message = (e as Error).message
    assert.ok(!/E2BIG/.test(message) && /too long/.test(message), message)
    return true
  })
})

/** Six workspaces named main on branch main, in different folders, the way separate repos' main checkouts are. */
function mains(count = 6) {
  const dirs = Array.from({ length: count }, () => folder())
  const list = { truncated: false, workspaces: dirs.map((path, i) => ({ id: `m${i}`, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })) }
  for (const [i, path] of dirs.entries()) writeFileSync(join(fake, `terminal-term_${i}.json`), JSON.stringify({ ok: true, result: { terminal: { handle: `term_${i}`, worktreeId: `m${i}`, worktreePath: path } } }))
  const focus = (i: number | null, extra: object[] = []) =>
    mockHost({
      results: {
        'workspace.readContext': { displayName: 'main', branch: 'main', terminals: i === null ? [] : [{ id: `term_${i}`, title: 'zsh' }] },
        'workspace.list': { ...list, workspaces: [...list.workspaces, ...extra] }
      }
    })
  return { dirs, focus }
}

test('among six workspaces named main, the focused one is found by its terminal and its own repo is chosen', async () => {
  const { dirs, focus } = mains()
  for (const d of dirs) writeFileSync(join(d, '.swamp.yaml'), 'swampVersion: test\n')
  const worker = await mountWorker(main, { host: focus(3) })
  const answer = await worker.request('repo.resolve', {})
  assert.deepEqual(answer.repo, { kind: 'local', dir: dirs[3] })
  assert.deepEqual(answer.workspace, { name: 'main', listed: true })
})

test('a repo picked in one workspace named main is not chosen in another workspace named main', async () => {
  process.env.SWAMPLING_PINS = join(folder(), 'pins.json')
  const ops = folder('.')
  const { focus } = mains()
  const extra = [{ id: 'ops', kind: 'folder', name: 'ops', path: ops, branch: null, hostId: null }]
  const first = await mountWorker(main, { host: focus(1, extra) })
  assert.deepEqual((await first.request('repo.pin', { repo: { kind: 'local', dir: ops } as never })).repo, { kind: 'local', dir: ops })
  assert.deepEqual((await first.request('repo.resolve', {})).repo, { kind: 'local', dir: ops }, 'the pick holds where it was made')
  const other = await mountWorker(main, { host: focus(4, extra) })
  assert.equal((await other.request('repo.resolve', {})).repo, null, 'another main workspace is not given that pick')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(process.env.SWAMPLING_PINS, 'utf8'))), ['m1'], 'saved under that workspace’s id')
})

test('a repo picked in one of two workspaces that share a folder is not chosen in the other', async () => {
  process.env.SWAMPLING_PINS = join(folder(), 'pins.json')
  const home = folder('a', 'b')
  const ws = (id: string, name: string) => ({ id, kind: 'folder', name, path: home, branch: null, hostId: null })
  for (const id of ['snapper', 'grayling']) {
    writeFileSync(join(fake, `terminal-term_${id}.json`), JSON.stringify({ ok: true, result: { terminal: { handle: `term_${id}`, worktreeId: `home::workspace:${id}`, worktreePath: home } } }))
  }
  const focus = (id: string) =>
    mockHost({
      results: {
        'workspace.readContext': { displayName: id, branch: '', terminals: [{ id: `term_${id}`, title: 'zsh' }] },
        'workspace.list': { truncated: false, workspaces: [ws('home::workspace:snapper', 'snapper'), ws('home::workspace:grayling', 'grayling')] }
      }
    })
  const snapper = await mountWorker(main, { host: focus('snapper') })
  assert.equal((await snapper.request('repo.resolve', {})).repo, null, 'two repos under the folder ask the picker')
  await snapper.request('repo.pin', { repo: { kind: 'local', dir: join(home, 'a') } as never })
  assert.deepEqual((await snapper.request('repo.resolve', {})).repo, { kind: 'local', dir: join(home, 'a') })
  const grayling = await mountWorker(main, { host: focus('grayling') })
  assert.equal((await grayling.request('repo.resolve', {})).repo, null, 'the other workspace on that folder keeps its own choice')
})

test('a pin saved under a workspace name before is still read while that name is unique, and ignored once it is not', async () => {
  process.env.SWAMPLING_PINS = join(folder(), 'pins.json')
  const ops = folder('.')
  writeFileSync(process.env.SWAMPLING_PINS, JSON.stringify({ main: ops, demo: ops }))
  const unique = await mountWorker(main, { host: host(folder()) })
  assert.deepEqual((await unique.request('repo.resolve', {})).repo, { kind: 'local', dir: ops })
  const { focus } = mains()
  const shared = await mountWorker(main, { host: focus(2) })
  assert.equal((await shared.request('repo.resolve', {})).repo, null)
})

test('with several workspaces named main and no terminal to tell them apart, nothing is chosen and the panel is told why', async () => {
  process.env.SWAMPLING_PINS = join(folder(), 'pins.json')
  const { dirs, focus } = mains()
  for (const d of dirs) writeFileSync(join(d, '.swamp.yaml'), 'swampVersion: test\n')
  const worker = await mountWorker(main, { host: focus(null) })
  const answer = await worker.request('repo.resolve', {})
  assert.equal(answer.repo, null)
  assert.deepEqual(answer.workspace, { name: 'main', listed: true, sharedName: 6 })
  assert.deepEqual(answer.candidates.map((c) => c.repo.dir).sort(), [...dirs].sort())
  const picked = await worker.request('repo.pin', { repo: { kind: 'local', dir: dirs[0] } as never })
  assert.deepEqual(picked.repo, { kind: 'local', dir: dirs[0] }, 'the pick is used now')
  assert.equal((await worker.request('repo.resolve', {})).repo, null, 'and not saved for every workspace named main')
})

test('a second resolve starts neither swamp workspace list nor orca terminal show again, and a fresh one starts both', async () => {
  const { dirs, focus } = mains(2)
  writeFileSync(join(dirs[1], '.swamp.yaml'), 'swampVersion: test\n')
  const { calls } = localRepo({ 'workspace list': '{"workspaces":[]}' })
  const shows = () => readFileSync(join(fake, 'terminal.log'), 'utf8').trim().split('\n').length
  const before = shows()
  const started = () => [verbs(calls()).filter((v) => v === 'workspace list').length, shows() - before]
  const worker = await mountWorker(main, { host: focus(1) })
  const first = await worker.request('repo.resolve', {})
  assert.deepEqual(first.repo, { kind: 'local', dir: dirs[1] })
  assert.deepEqual(await worker.request('repo.resolve', {}), first, 'the remembered lookups give the same answer')
  assert.deepEqual(started(), [1, 1], 'the second resolve started no process')
  assert.deepEqual(await worker.request('repo.resolve', { fresh: true }), first)
  assert.deepEqual(started(), [2, 2], 'a fresh resolve reads both again')
})

test('the inbox lists what waits in every workspace repo and the one on screen, remembers the answer, and reads again when asked fresh', async () => {
  const [a, b, onScreen] = [folder('.'), folder('.'), folder('.')]
  const { calls } = localRepo({ 'workspace list': '{"workspaces":[]}', 'workflow approvals': read('gated.approvals'), 'data query': read('sc.runs') })
  process.env.SWAMPLING_PINS = join(folder(), 'pins.json')
  const worker = await mountWorker(main, { host: host(a, [b, join(b, 'packages')]) })
  const reads = () => verbs(calls()).filter((v) => v === 'workflow approvals').length
  const first = await worker.request('inbox.list', {})
  assert.equal(first.repos, 2, 'two workspaces in one repo are one read')
  assert.deepEqual(first.failed, [])
  assert.deepEqual(
    first.items.filter((i) => (i.repo as { dir: string }).dir === a).map((i) => (i.kind === 'gate' ? i.gate.step : i.key)).sort(),
    ['signoff', 'team-4', 'team-5']
  )
  assert.equal(first.items.length, 6)
  assert.deepEqual(await worker.request('inbox.list', {}), first)
  assert.equal(reads(), 2, 'the second ask started no swamp')
  const shown = await worker.request('inbox.list', { repo: { kind: 'local', dir: onScreen } as never })
  assert.equal(shown.repos, 3, 'a repo the panel shows is read although no workspace or pin names it')
  assert.equal(reads(), 5)
  await worker.request('inbox.list', { fresh: true })
  assert.equal(reads(), 8, 'a fresh ask reads every repo again')
  assert.deepEqual(worker.refusals, [])
})

const NAPPER = JSON.stringify({ name: 'napper', jobs: [], inputs: { required: ['label'], properties: { label: { type: 'string' }, seconds: { type: 'integer', default: 30 } } } })
const failedRun = (change: object = {}) => JSON.stringify({ ...JSON.parse(read('breaks.run-failed')), ...change })
const call = (calls: string[][], verb: string) => calls.find((c) => c[1] === verb)

test('Run starts the workflow in the background with each form value as one typed input, and answers the new run', async () => {
  const { repo, calls } = localRepo({
    'workflow get napper': NAPPER,
    'workflow history get napper': ['{"id":"old-run"}', '{"id":"new-run"}'],
    'workflow run': { stdout: '{}', delay: 3000 }
  })
  const worker = await mountWorker(main, { host: host(folder()) })
  assert.deepEqual((await worker.request('workflow.inputs', { repo, workflow: 'napper' })).map((f) => `${f.name}${f.required ? '*' : ''}=${f.default ?? ''}`), ['label*=', 'seconds=30'])
  const label = `@notes.txt'; rm -rf "$HOME" #`
  assert.deepEqual(await worker.request('run.start', { repo, workflow: 'napper', inputs: { label, seconds: '5' } }), { runId: 'new-run' })
  assert.deepEqual(call(calls(), 'run'), ['workflow', 'run', 'napper', '--input', `label:json=${JSON.stringify(label)}`, '--input', 'seconds:json=5', '--json', '--no-color'])
})

test('Run again starts a new run with the inputs swamp recorded for the old one, types kept', async () => {
  const { repo, calls } = localRepo({
    'workflow history get old-run': JSON.stringify({ id: 'old-run', workflowName: 'napper', inputs: { label: 'x', seconds: 5, loud: false } }),
    'workflow history get napper': ['{"id":"old-run"}', '{"id":"new-run"}']
  })
  const worker = await mountWorker(main, { host: host(folder()) })
  assert.deepEqual(await worker.request('run.start', { repo, workflow: 'napper', again: 'old-run' as never }), { runId: 'new-run' })
  assert.deepEqual(call(calls(), 'run'), ['workflow', 'run', 'napper', '--input', 'label:json="x"', '--input', 'seconds:json=5', '--input', 'loud:json=false', '--json', '--no-color'])
  await assert.rejects(worker.request('run.start', { repo, workflow: 'flaky', again: 'old-run' as never }), /belongs to workflow napper/)
})

test('a start swamp refuses shows what swamp said, and one that leaves no new run answers no run id', async () => {
  const refusal = { stderr: '{\n  "error": "Input validation failed:\\n  label is required"\n}\n', exit: 1 }
  const { repo } = localRepo({ 'workflow get napper': NAPPER, 'workflow history get napper': '{"id":"old-run"}', 'workflow run': [refusal, '{}'] })
  const worker = await mountWorker(main, { host: host(folder()) })
  await assert.rejects(worker.request('run.start', { repo, workflow: 'napper' }), /label is required/)
  assert.deepEqual(await worker.request('run.start', { repo, workflow: 'napper', inputs: { label: 'x' } }), {})
})

test('Stop cancels that run by id; Retry resumes it, from one step of one job when asked; Recover runs recover first', async () => {
  const { repo, calls } = localRepo({
    'workflow get breaks': read('breaks.def'),
    [`workflow history get ${BROKEN_RUN}`]: [failedRun(), failedRun({ status: 'running' }), failedRun({ status: 'running' }), failedRun({ status: 'cancelled' })],
    'workflow resume': { stdout: '{}', delay: 3000 }
  })
  const worker = await mountWorker(main, { host: host(folder()) })
  const act = (more: object) => worker.request('run.act', { repo, workflow: 'breaks', runId: BROKEN_RUN, ...more } as never)
  assert.equal((await act({ action: 'retry', from: { job: 'main', step: 'right' } })).status, 'running', 'the answer waits until resume has taken the run')
  assert.deepEqual(call(calls(), 'resume'), ['workflow', 'resume', 'breaks', '--run', BROKEN_RUN, '--from', 'right', '--job', 'main', '--json', '--no-color'])
  await act({ action: 'recover' })
  const after = calls().slice(calls().findIndex((c) => c[1] === 'recover'))
  assert.deepEqual(after[0], ['workflow', 'recover', 'breaks', '--run', BROKEN_RUN, '--acknowledge-unknown', '--json', '--no-color'])
  assert.deepEqual(after.find((c) => c[1] === 'resume'), ['workflow', 'resume', 'breaks', '--run', BROKEN_RUN, '--json', '--no-color'], 'resume follows recover')
  assert.equal((await act({ action: 'stop' })).status, 'cancelled')
  assert.deepEqual(call(calls(), 'cancel'), ['workflow', 'cancel', 'breaks', '--run', BROKEN_RUN, '--json', '--no-color'])
})

test('a retry swamp refuses shows what swamp said; a retried run that fails again is shown, not reported as an error', async () => {
  const refusal = { stderr: '{"error":"Run x is not suspended or failed (status: succeeded)."}', exit: 1 }
  const { repo } = localRepo({
    'workflow get breaks': read('breaks.def'),
    [`workflow history get ${BROKEN_RUN}`]: failedRun(),
    'workflow resume': [refusal, { exit: 1 }],
    'workflow recover': { stderr: '{"error":"Interrupted run x not found"}', exit: 1 }
  })
  const worker = await mountWorker(main, { host: host(folder()) })
  const act = (action: string) => worker.request('run.act', { repo, workflow: 'breaks', runId: BROKEN_RUN, action } as never)
  await assert.rejects(act('retry'), /not suspended or failed/)
  assert.equal((await act('retry')).status, 'failed')
  await assert.rejects(act('recover'), /Interrupted run x not found/)
})

test('run controls refuse a word that is not theirs before swamp runs anything', async () => {
  const { repo, calls } = localRepo({ 'workflow get napper': NAPPER, 'workflow history get napper': '{"id":"old-run"}' })
  const worker = await mountWorker(main, { host: host(folder()) })
  const act = (more: object) => worker.request('run.act', { repo, workflow: 'breaks', runId: BROKEN_RUN, action: 'retry', ...more } as never)
  await assert.rejects(act({ action: 'delete' }), /action/)
  await assert.rejects(act({ action: 'again' }), /action/)
  await assert.rejects(act({ runId: '--all' }), /run id/)
  await assert.rejects(act({ workflow: '--all' }), /workflow/)
  await assert.rejects(act({ from: { job: 'main', step: '--input' } }), /step/)
  await assert.rejects(act({ from: { step: 'right' } }), /job/)
  await assert.rejects(act({ from: 'right' }), /job/)
  await assert.rejects(act({ action: 'stop', from: { job: 'main', step: 'right' } }), /only a retry/)
  const start = (more: object) => worker.request('run.start', { repo, workflow: 'napper', ...more } as never)
  await assert.rejects(start({ workflow: '--last-evaluated' }), /workflow/)
  await assert.rejects(start({ again: '--help' }), /run id/)
  await assert.rejects(start({ inputs: ['label=x'] }), /inputs/)
  await assert.rejects(start({ inputs: { label: 7 } }), /not text/)
  await assert.rejects(worker.request('workflow.inputs', { repo, workflow: '-x' }), /workflow/)
  assert.deepEqual(calls(), [], 'nothing malformed reached swamp')
  await assert.rejects(start({ inputs: { 'label=x --server': 'y' } }), /no input/)
  assert.ok(!verbs(calls()).includes('workflow run'), 'an input the workflow does not declare starts nothing')
})

test('a running run of a local repo whose swamp process died is marked gone on its row and its screen, with no further swamp call', async () => {
  const running = { ...JSON.parse(read('breaks.run-failed')), status: 'running' }
  const { repo, calls } = localRepo({
    'workflow search': JSON.stringify({ results: [{ name: 'breaks', stepCount: 2 }] }),
    'workflow history search': JSON.stringify({ results: [{ runId: BROKEN_RUN, workflowId: 'wf-breaks', workflowName: 'breaks', status: 'running', startedAt: '2026-11-11T10:00:00.000Z' }] }),
    'workflow approvals': JSON.stringify({ approvals: [], expired: [] }),
    'workflow get breaks': read('breaks.def'),
    [`workflow history get ${BROKEN_RUN}`]: ''
  })
  const dir = (repo as { dir: string }).dir
  const file = join(dir, '.swamp/workflow-runs/wf-breaks', `workflow-run-${BROKEN_RUN}.yaml`)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `id: ${BROKEN_RUN}\nstatus: running\npid: ${spawnSync(process.execPath, ['-e', '']).pid}\n`)
  writeFileSync(join(dir, 'answers.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8')), [`workflow history get ${BROKEN_RUN}`]: JSON.stringify({ ...running, path: file }) }))
  const worker = await mountWorker(main, { host: host(folder()) })
  const list = await worker.request('workflows.list', { repo })
  assert.equal(list.runs[0].gone, true)
  assert.equal(list.workflows[0].runs[0].gone, true)
  assert.ok(Date.parse(list.runs[0].activeAt!) > Date.parse('2026-11-11T10:00:00.000Z'))
  const listCalls = calls().length
  assert.equal(listCalls, 4, 'search, history, approvals and version')
  const run = await worker.request('run.get', { repo, workflow: 'breaks', runId: BROKEN_RUN })
  assert.equal(run.gone, true)
  assert.equal(calls().length - listCalls, 2, 'the definition and the run')
  writeFileSync(file, `id: ${BROKEN_RUN}\nstatus: running\npid: ${process.pid}\n`)
  assert.ok(!('gone' in (await worker.request('run.get', { repo, workflow: 'breaks', runId: BROKEN_RUN }))))
})

const LOG_RUN = '7c1f0a52-3b6e-4d18-9a47-5e2d8c90b113' as never
/** A local repo whose swamp names the workflow of LOG_RUN, with that run's record and log on disk. */
function logRepo(log: string | undefined, workflowId = 'wf-bake') {
  const made = localRepo({ [`workflow history get ${LOG_RUN}`]: JSON.stringify({ id: LOG_RUN, workflowId, workflowName: 'bake', status: 'running' }) })
  const dir = (made.repo as { dir: string }).dir
  const record = join(dir, '.swamp/workflow-runs/wf-bake', `workflow-run-${LOG_RUN}.yaml`)
  mkdirSync(join(record, '..'), { recursive: true })
  const logFile = record.replace(/\.yaml$/, '.log')
  if (log !== undefined) {
    writeFileSync(record, `id: ${LOG_RUN}\nstatus: running\n`)
    writeFileSync(logFile, log)
  }
  return { ...made, record, logFile }
}
const logLineAt = (n: number) => `2026-11-11T10:00:${String(n).padStart(2, '0')}.000Z [INF] model·method·run·bake-mix·execute: tick ${n}\n`

test('log.tail reads a run\'s log file from the cursor: only the new lines each time, with one swamp call to find the file', async () => {
  const { repo, calls, record, logFile } = logRepo(logLineAt(1) + logLineAt(2))
  const worker = await mountWorker(main, { host: host(folder()) })
  const first = await worker.request('log.tail', { repo, runId: LOG_RUN })
  assert.deepEqual(first.lines.map((l) => l.text), ['tick 1', 'tick 2'])
  assert.deepEqual(first.lines[0], { pos: 0, at: '2026-11-11T10:00:01.000Z', level: 'info', tag: 'bake-mix·execute', text: 'tick 1' })
  assert.equal(first.done, false)
  writeFileSync(logFile, logLineAt(1) + logLineAt(2) + logLineAt(3))
  const second = await worker.request('log.tail', { repo, runId: LOG_RUN, after: first.next })
  assert.deepEqual(second.lines.map((l) => l.text), ['tick 3'])
  assert.ok(second.next > first.next)
  writeFileSync(record, `id: ${LOG_RUN}\nstatus: succeeded\n`)
  const last = await worker.request('log.tail', { repo, runId: LOG_RUN, after: second.next })
  assert.deepEqual([last.lines, last.next, last.done], [[], second.next, true])
  assert.deepEqual(verbs(calls()), ['workflow history'], 'the workflow id is asked for once')
})

test('log.tail refuses what is not a run id, a byte offset or a limit, before any file or swamp is touched', async () => {
  const { repo, calls } = logRepo(logLineAt(1))
  const worker = await mountWorker(main, { host: host(folder()) })
  const ask = (more: object) => worker.request('log.tail', { repo, runId: LOG_RUN, ...more } as never)
  for (const after of [-1, 1.5, '5', null, Number.MAX_SAFE_INTEGER + 2]) await assert.rejects(ask({ after }), /not a byte offset/)
  await assert.rejects(ask({ before: -3 }), /not a byte offset/)
  await assert.rejects(ask({ after: 0, before: 9 }), /not both/)
  await assert.rejects(ask({ limit: 'all' }), /not a number/)
  for (const runId of ['../../../etc/passwd', 'a/b', '--help', '', 'x'.repeat(65), 'a b']) await assert.rejects(ask({ runId }), /run id|not a name/)
  await assert.rejects(worker.request('log.tail', { repo: { kind: 'local', dir: 'relative' } as never, runId: LOG_RUN }), /repo/)
  assert.deepEqual(calls(), [])
})

test('log.tail clamps the limit: a tiny one still answers whole lines and a huge one stays under the cap', async () => {
  const { repo, logFile } = logRepo(Array.from({ length: 59 }, (_, i) => logLineAt(i)).join(''))
  const worker = await mountWorker(main, { host: host(folder()) })
  const tiny = await worker.request('log.tail', { repo, runId: LOG_RUN, after: 0, limit: 1 })
  assert.ok(tiny.lines.length >= 5 && tiny.next <= 1024, `a limit of 1 reads 1 KiB, and read ${tiny.next} bytes`)
  writeFileSync(logFile, logLineAt(1).repeat(8000))
  const huge = await worker.request('log.tail', { repo, runId: LOG_RUN, after: 0, limit: 1e12 })
  assert.ok(huge.next <= 256 * 1024 && huge.next > 200 * 1024, `a huge limit reads 256 KiB, and read ${huge.next} bytes`)
  assert.ok(huge.size > huge.next)
  const newest = await worker.request('log.tail', { repo, runId: LOG_RUN })
  assert.ok(newest.next - newest.from <= 48 * 1024 && newest.from > 0, 'a first read tails the newest 48 KiB')
})

test('log.tail builds the file path from ids it checks, and says so when the run keeps no files in the repo', async () => {
  const outside = logRepo(logLineAt(1), '../../../../outside')
  const worker = await mountWorker(main, { host: host(folder()) })
  await assert.rejects(worker.request('log.tail', { repo: outside.repo, runId: LOG_RUN }), /named no workflow/)
  const none = logRepo(undefined)
  await assert.rejects(worker.request('log.tail', { repo: none.repo, runId: LOG_RUN }), /outside the repo/)
})

// A workspace on a server Orca does not list, with the remote home's swamp registry naming `repos`. The stand-in
// ssh answers for any login but `down`, from the one fake remote home.
async function remoteWorkspace(context: { displayName: string; branch: string; terminals: [] } | null, repos: string[], run: (w: { worker: Awaited<ReturnType<typeof mountWorker>>; host: ReturnType<typeof mockHost>; dir: string; pins: () => Record<string, unknown>; logins: () => unknown; sshCalls: () => number }) => Promise<void>) {
  const dir = folder()
  const [answers, pinsWere] = [join(fake, 'answers.json'), process.env.SWAMPLING_PINS]
  const before = readFileSync(answers, 'utf8')
  process.env.SWAMPLING_PINS = join(dir, 'pins.json')
  writeFileSync(answers, JSON.stringify({ ...JSON.parse(before), 'workspace list': JSON.stringify({ workspaces: repos.map((path) => ({ name: path.split('/').pop(), path, folder: 'ok' })) }) }))
  try {
    const host = mockHost({ results: { 'workspace.readContext': context, 'workspace.list': { truncated: false, workspaces: [] } } })
    const read = (file: string) => {
      try {
        return JSON.parse(readFileSync(join(dir, file), 'utf8'))
      } catch {
        return {}
      }
    }
    await run({ worker: await mountWorker(main, { host }), host, dir, pins: () => read('pins.json'), logins: () => read('settings.json').sshHosts, sshCalls: () => readFileSync(join(fake, 'ssh.log'), 'utf8').split('\n').length })
  } finally {
    writeFileSync(answers, before)
    process.env.SWAMPLING_PINS = pinsWere
  }
}
const playground = join(fake, 'home/swampling-playground')
const onLab = (dir: string) => ({ kind: 'ssh', host: 'lab-box', dir })
const factoryFixes = { displayName: 'factory-fixes', branch: 'main', terminals: [] as [] }

test('Connect asks the login before it saves it: what is no login, or does not answer, is answered as a fault with nothing saved and no ssh started', async () => {
  await remoteWorkspace(null, [playground], async ({ worker, logins }) => {
    const add = (host: unknown) => worker.request('hosts.add', { host } as never)
    for (const host of ['-oProxyCommand=id', 'lab box', '$(id)', 'lab;id', 'ssh -oProxyCommand=id lab']) assert.equal((await add(host)).ok === false && (await add(host) as { fault: string }).fault, 'not-a-login', host)
    for (const host of ['', '   ', 7]) assert.deepEqual(await add(host), { ok: false, fault: 'empty', login: '' })
    assert.ok(!readFileSync(join(fake, 'ssh.log'), 'utf8').includes('ProxyCommand'), 'ssh is never started for what is not a login')
    assert.deepEqual(await add('down'), { ok: false, fault: 'no-answer', login: 'down', said: 'ssh: connect to host down port 22: Connection refused' })
    assert.equal(logins(), undefined, 'nothing was saved')

    const added = await add('ssh lab-box')
    assert.ok(added.ok && added.login === 'lab-box', 'a login pasted with ssh in front is read as the login')
    assert.deepEqual(logins(), ['lab-box'])
    assert.deepEqual(added.resolution.logins, ['lab-box'])
    assert.deepEqual(added.resolution.candidates.find((c) => c.repo.kind === 'ssh' && c.repo.host === 'lab-box')?.repo, onLab(playground))
    assert.equal(added.resolution.repo, null, 'Orca names no workspace, so the person picks even among one')
    const again = await add('ws://lab-box:6768')
    assert.ok(again.ok && again.login === 'lab-box', 'the address as Orca shows it is read as the login')
    assert.deepEqual(logins(), ['lab-box'], 'a login added twice is listed once')
  })
})

test('Find repo takes a folder on a saved login with one ssh call, picks the repo at or above it, and names a folder that is wrong', async () => {
  await remoteWorkspace(null, [], async ({ worker, pins, logins, sshCalls, dir }) => {
    const find = (folderTyped: unknown, host = 'lab-box') => worker.request('hosts.add', { host, dir: folderTyped } as never)
    const empty = await worker.request('hosts.add', { host: 'lab-box' })
    assert.ok(empty.ok && !empty.resolution.candidates.some((c) => c.repo.kind === 'ssh' && c.repo.host === 'lab-box'), 'swamp lists no repo there')
    const asked = sshCalls()
    for (const bad of ['srv/factory', '~other/x', '/srv/fac\ntory', '', 7]) assert.deepEqual(await find(bad), { ok: false, fault: 'folder-not-path', login: 'lab-box' }, JSON.stringify(bad))
    assert.equal(sshCalls(), asked, 'a folder that is no full path starts no ssh')
    assert.deepEqual(await find(join(fake, 'home/no-repo-here')), { ok: false, fault: 'folder-no-repo', login: 'lab-box', folder: join(fake, 'home/no-repo-here') })
    assert.deepEqual(await find('/srv/x', 'new-box'), { ok: false, fault: 'folder-no-repo', login: 'new-box', folder: '/srv/x' })
    assert.deepEqual(logins(), ['lab-box', 'new-box'], 'a login that answers is saved even when the folder is wrong')

    const unread = { odd: { kind: 'ssh', host: 'lab box', dir: '/srv/x' }, later: { kind: 'tunnel', via: ['a', 1] }, mac: '/Users/dev/repo' }
    writeFileSync(join(dir, 'pins.json'), JSON.stringify(unread))
    mkdirSync(join(playground, 'deep/er'), { recursive: true })
    const before = sshCalls()
    const picked = await find('~/swampling-playground/deep/er/')
    assert.equal(sshCalls() - before, 1, 'one ssh call finds the repo and answers')
    assert.ok(picked.ok)
    assert.deepEqual(picked.resolution.repo, onLab(playground), 'a folder under ~ finds the repo at or above it')
    assert.deepEqual(pins(), { ...unread, '@remote-or-none': onLab(playground) }, 'pins this version cannot read are kept as they were')

    await assert.rejects(worker.request('hosts.remove', { host: '-x' }), /not an SSH login/)
    const removed = await worker.request('hosts.remove', { host: 'lab-box' })
    assert.equal(removed.unpicked, 1)
    assert.equal(removed.resolution.repo, null, 'the repo picked on the removed login is no longer used')
    assert.deepEqual(removed.resolution.logins, ['new-box'])
    assert.deepEqual(pins(), unread)
    assert.deepEqual(logins(), ['new-box'])
    assert.equal((await worker.request('hosts.remove', { host: 'new-box' })).unpicked, 0)
    assert.equal(logins(), undefined, 'the settings file names no login again')
  })
})

test('a login with one repo gives it to a workspace Orca names, and to no workspace when there are several repos or no name', async () => {
  const second = join(fake, 'home/second-repo')
  mkdirSync(second, { recursive: true })
  writeFileSync(join(second, '.swamp.yaml'), 'swampVersion: test\n')
  await remoteWorkspace(factoryFixes, [playground], async ({ worker, pins }) => {
    const added = await worker.request('hosts.add', { host: 'lab-box' })
    assert.ok(added.ok)
    assert.deepEqual(added.resolution.repo, onLab(playground))
    assert.deepEqual(pins(), { 'factory-fixes': onLab(playground) }, "the pick is saved under the workspace's own name")
    assert.deepEqual((await worker.request('repo.resolve', {})).repo, onLab(playground))
  })
  await remoteWorkspace(factoryFixes, [playground, second], async ({ worker, pins }) => {
    const added = await worker.request('hosts.add', { host: 'lab-box' })
    assert.ok(added.ok && added.resolution.repo === null, 'with two repos the person picks')
    assert.deepEqual(pins(), {})
  })
  await remoteWorkspace(null, [playground], async ({ worker, pins }) => {
    const added = await worker.request('hosts.add', { host: 'lab-box' })
    assert.ok(added.ok && added.resolution.repo === null)
    assert.deepEqual(pins(), {}, 'nothing is saved under the key all unnamed remote workspaces share')
  })
})

test('a workspace switch while Connect waits for ssh does not move the pick to the workspace switched to', async () => {
  const other = { displayName: 'other', branch: 'main', terminals: [] as [] }
  await remoteWorkspace(factoryFixes, [playground], async ({ worker, host, pins }) => {
    const finding = worker.request('hosts.add', { host: 'slow', dir: playground })
    await new Promise((r) => setTimeout(r, 300))
    host.respond('workspace.readContext', other)
    await finding
    assert.deepEqual(pins(), { 'factory-fixes': { kind: 'ssh', host: 'slow', dir: playground } }, 'the folder the person named is picked for the workspace they named it in')
  })
  await remoteWorkspace(factoryFixes, [playground], async ({ worker, host, pins }) => {
    const adding = worker.request('hosts.add', { host: 'slow' })
    await new Promise((r) => setTimeout(r, 300))
    host.respond('workspace.readContext', other)
    const added = await adding
    assert.ok(added.ok && added.resolution.repo === null)
    assert.deepEqual(pins(), {}, 'no repo is picked for a workspace the person has left')
  })
})

test('Change SSH login moves the picks to the new login where it has the repo, and removing a login Orca itself uses keeps its picks', async () => {
  await remoteWorkspace(factoryFixes, [], async ({ worker, pins, logins, dir }) => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ sshHosts: ['old-box', 'jarvis'] }))
    const gone = { kind: 'ssh', host: 'old-box', dir: join(fake, 'home/deleted') }
    writeFileSync(join(dir, 'pins.json'), JSON.stringify({ 'factory-fixes': { kind: 'ssh', host: 'old-box', dir: playground }, elsewhere: gone, kept: { kind: 'ssh', host: 'jarvis', dir: playground } }))
    const changed = await worker.request('hosts.add', { host: 'lab-box', replaces: 'old-box' })
    assert.ok(changed.ok)
    assert.deepEqual(changed.resolution.repo, onLab(playground), 'this workspace shows its repo through the new login')
    assert.deepEqual(logins(), ['jarvis', 'lab-box'])
    assert.deepEqual(pins(), { 'factory-fixes': onLab(playground), kept: { kind: 'ssh', host: 'jarvis', dir: playground } })
    assert.equal((await worker.request('hosts.remove', { host: 'jarvis' })).unpicked, 0)
    assert.deepEqual(pins().kept, { kind: 'ssh', host: 'jarvis', dir: playground }, 'jarvis is still the SSH host of a paired server')
  })
})
