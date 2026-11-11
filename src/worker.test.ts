import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { isLive } from './domain'

// Stand-ins on PATH for the orca CLI and ssh: orca answers captured JSON with its /home/dev paths moved under
// a temp folder, and ssh runs the remote command string in a local sh, as the remote login shell would.
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
script('ssh', `for a; do last=$a; done; printf '%s\\n' "$*" >> '${fake}/ssh.log'; HOME='${fake}/home' exec sh -c "$last"`)
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
