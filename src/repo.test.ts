import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import type { Repo, SshHost } from './domain'
import { parsePins, parseWorkspaces, pickRepo, remembered, rememberedLookups, remoteRepos, resolveRepo } from './repo'

function repo(root: string, ...parts: string[]): string {
  const dir = join(root, ...parts)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.swamp.yaml'), 'swampVersion: test\n')
  return dir
}

const root = () => mkdtempSync(join(tmpdir(), 'swampling-repo-'))

test('a registered repo deep below the workspace is found, an unregistered one is not', () => {
  const ws = root()
  const deep = repo(ws, 'rest-api', 'tools', 'factory')
  repo(ws, 'stray')
  const answer = pickRepo([ws], [], [{ name: 'acme-factory', path: deep }])
  assert.deepEqual(answer.repo, { kind: 'local', dir: deep })
  assert.equal(answer.candidates[0].label, 'acme-factory · tools')
})

test('two repos for one workspace ask the picker', () => {
  const ws = repo(root())
  const nested = repo(ws, 'factory')
  const answer = pickRepo([ws], [], [{ name: 'factory', path: nested }])
  assert.equal(answer.repo, null)
  assert.deepEqual(answer.candidates.map((c) => c.repo.dir), [ws, nested])
})

test('registered repos elsewhere are offered but never chosen', () => {
  const elsewhere = repo(root())
  const answer = pickRepo([root()], [], [{ name: 'ops', path: elsewhere }, { name: 'gone', path: join(root(), 'missing') }])
  assert.equal(answer.repo, null)
  assert.deepEqual(answer.candidates.map((c) => c.repo.dir), [elsewhere])
})

test('parseWorkspaces keeps only entries with a name and a path', () => {
  assert.deepEqual(parseWorkspaces({ workspaces: [{ name: 'a', path: '/a' }, { name: 1 }, null] }), [{ name: 'a', path: '/a' }])
  assert.deepEqual(parseWorkspaces({ workspaces: [{ name: 'b', path: '/b', folder: 'missing' }] }), [{ name: 'b', path: '/b', folder: 'missing' }])
  assert.deepEqual(parseWorkspaces({ error: 'x' }), [])
})

const jarvis = 'jarvis' as SshHost
const registry = {
  workspaces: [
    { name: 'shop-factory', path: '/home/dev/orca/workspaces/shop/factory-v3', folder: 'ok' },
    { name: 'ops', path: '/home/dev/ops', folder: 'ok' },
    { name: 'gone', path: '/home/dev/gone', folder: 'missing' }
  ]
}

test("a remote host offers each workspace's repo once, plus registry repos whose folder still exists", () => {
  const ws = '/home/dev/orca/workspaces/shop/factory-v3'
  const offered = remoteRepos(jarvis, [ws, null, ws], registry)
  assert.deepEqual(offered.map((c) => c.repo), [
    { kind: 'ssh', host: 'jarvis', dir: ws },
    { kind: 'ssh', host: 'jarvis', dir: '/home/dev/ops' }
  ])
  assert.equal(offered[0].label, 'shop-factory · shop', 'the registry name labels the repo')
})

test('pins written before remote support still load as local repos; a host that ssh would read as an option is dropped', () => {
  assert.deepEqual(
    parsePins({ old: '/Users/dev/repo', '@remote-or-none': { kind: 'ssh', host: 'jarvis', dir: '/home/dev/p' }, bad: { kind: 'ssh', host: '-oProxyCommand=x', dir: '/' } }),
    { old: { kind: 'local', dir: '/Users/dev/repo' }, '@remote-or-none': { kind: 'ssh', host: 'jarvis', dir: '/home/dev/p' } }
  )
})

test('a workspace path with a trailing slash finds its repo once and chooses it', () => {
  const ws = root()
  const deep = repo(ws, 'tools', 'factory')
  const answer = pickRepo([`${deep}/`], [`${ws}/`], [{ name: 'factory', path: deep }])
  assert.deepEqual(answer.repo, { kind: 'local', dir: deep })
  assert.deepEqual(answer.candidates.map((c) => c.repo.dir), [deep])
})

test('a workspace with a relative or empty path never resolves against the worker folder', () => {
  assert.deepEqual(pickRepo(['', '.', 'repo'], [], []).candidates, [])
})

test('a pins file that is an array, or a pin with a relative folder or empty host, loads no pin', () => {
  assert.deepEqual(parsePins(['/Users/dev/repo']), {})
  assert.deepEqual(parsePins({ a: 'repo', b: { kind: 'local', dir: '' }, c: { kind: 'ssh', host: '', dir: '/p' }, d: { kind: 'ssh', host: 'jarvis', dir: 'p' } }), {})
})

// Stand-ins on PATH for the orca CLI and ssh. orca answers the JSON files a test writes into `cli`, and
// fails like the real one for a server it has no file for; ssh fails like an unreachable host for `down`,
// and otherwise runs the remote command in a local sh, as the remote login shell would. Each logs its calls.
const cli = mkdtempSync(join(tmpdir(), 'swampling-cli-'))
function script(name: string, body: string): void {
  mkdirSync(join(cli, 'bin'), { recursive: true })
  writeFileSync(join(cli, 'bin', name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(cli, 'bin', name), 0o755)
}
script('orca', `echo "$1 $2 $4" >> '${cli}/orca.log'; f='${cli}'/$(printf '%s' "$1-$2-$4" | tr -c 'a-zA-Z0-9-' _).json; [ -f "$f" ] && exec cat "$f"; echo '{"ok":false,"error":{"message":"Unknown Orca server"}}'; exit 1`)
script('ssh', `for a; do host=$prev; last=$a; prev=$a; done; echo "$host" >> '${cli}/ssh.log'; [ "$host" = down ] && { echo 'ssh: connect to host down port 22: Connection refused' >&2; exit 255; }; HOME='${cli}/home' exec sh -c "$last"`)
process.env.ORCA_CLI_COMMAND = join(cli, 'bin', 'orca')
process.env.PATH = `${join(cli, 'bin')}:${process.env.PATH}`
mkdirSync(join(cli, 'home/.local/bin'), { recursive: true })
writeFileSync(join(cli, 'home/.local/bin/swamp'), `#!/bin/sh\ncat '${cli}/registry.json' 2>/dev/null || echo '{"workspaces":[]}'\n`)
chmodSync(join(cli, 'home/.local/bin/swamp'), 0o755)

type Server = { name: string; host?: string; address?: string; worktrees?: { displayName: string; path: string }[] }
const calls = (log: 'orca' | 'ssh'): string[] => {
  try {
    return readFileSync(join(cli, `${log}.log`), 'utf8').trim().split('\n')
  } catch {
    return []
  }
}
function servers(list: Server[], registry: unknown = { workspaces: [] }): void {
  for (const f of readdirSync(cli)) if (f.endsWith('.json') || f.endsWith('.log')) rmSync(join(cli, f))
  const result = (body: unknown) => JSON.stringify({ ok: true, result: body })
  writeFileSync(join(cli, 'environment-list-.json'), result({ environments: list.map((s) => ({ name: s.name, ...(s.host && { orcadDeployment: { sshTargetId: `id-${s.host}` } }), ...(s.address && { endpoints: [{ endpoint: `ws://${s.address}:6768` }] }) })) }))
  writeFileSync(join(cli, 'host-list-.json'), result({ hosts: list.flatMap((s) => (s.host ? [{ kind: 'ssh', id: `id-${s.host}`, name: s.host }] : [])) }))
  for (const s of list) {
    if (s.worktrees) writeFileSync(join(cli, `worktree-list-${s.name}.json`), result({ worktrees: s.worktrees.map((w) => ({ ...w, hostId: 'local' })) }))
  }
  writeFileSync(join(cli, 'registry.json'), JSON.stringify(registry))
}
const focusWith = (context: unknown, folders: string[] = []) =>
  ({ host: { call: async (m: string) => (m === 'workspace.readContext' ? context : { workspaces: folders.map((path, i) => ({ id: `w${i}`, name: `w${i}`, path, branch: null })), truncated: false }) } }) as never
const remoteFocus = { host: { call: async (m: string) => (m === 'workspace.readContext' ? null : { workspaces: [], truncated: false }) } } as never

test('a relative or Windows path in a server\'s workspace list does not hang that host\'s probe', async () => {
  const dir = repo(root())
  servers([{ name: 'box', host: 'box', worktrees: [{ displayName: 'a', path: 'relative/dir' }, { displayName: 'b', path: 'C:\\\\Users\\\\dev\\\\repo' }, { displayName: 'c', path: dir }] }])
  const started = Date.now()
  const answer = await resolveRepo(remoteFocus, [], {})
  assert.ok(Date.now() - started < 10_000, 'the probe answers without waiting for its timeout')
  assert.equal(answer.problem, undefined)
  assert.deepEqual(answer.candidates.map((c) => c.repo), [{ kind: 'ssh', host: 'box', dir }])
})

test("a server's workspace path with a trailing slash is offered once next to its registry entry", async () => {
  const dir = repo(root())
  servers([{ name: 'box', host: 'box', worktrees: [{ displayName: 'a', path: `${dir}/` }] }], { workspaces: [{ name: 'shop', path: dir, folder: 'ok' }] })
  const answer = await resolveRepo(remoteFocus, [], {})
  assert.deepEqual(answer.candidates.map((c) => c.repo), [{ kind: 'ssh', host: 'box', dir }])
})

test('a server whose workspaces cannot be listed is reported, and its registry repos are still offered', async () => {
  const dir = repo(root())
  servers([{ name: 'box', host: 'box' }], { workspaces: [{ name: 'shop', path: dir, folder: 'ok' }] })
  const answer = await resolveRepo(remoteFocus, [], {})
  assert.deepEqual(answer.remoteHosts, ['box'])
  assert.deepEqual(answer.candidates.map((c) => c.repo), [{ kind: 'ssh', host: 'box', dir }])
  assert.ok(answer.problem?.message.includes('box'), `the problem names the server: ${answer.problem?.message}`)
})

test('one unreachable host is reported while the reachable one still offers its repos', async () => {
  const dir = repo(root())
  servers([{ name: 'up', host: 'up', worktrees: [{ displayName: 'a', path: dir }] }, { name: 'down', host: 'down', worktrees: [{ displayName: 'b', path: '/srv/b' }] }])
  const answer = await resolveRepo(remoteFocus, [], {})
  assert.deepEqual(answer.candidates.map((c) => c.repo), [{ kind: 'ssh', host: 'up', dir }])
  assert.equal(answer.problem?.code, 'host_unreachable')
})

test('a remote pin is kept while its host is unreachable, and dropped once the host is unpaired or the repo is gone', async () => {
  const dir = repo(root())
  const pin = (host: string, d: string) => ({ '@remote-or-none': { kind: 'ssh', host, dir: d } as Repo })
  servers([{ name: 'up', host: 'up', worktrees: [{ displayName: 'a', path: dir }] }, { name: 'down', host: 'down', worktrees: [] }])
  assert.deepEqual((await resolveRepo(remoteFocus, [], pin('down', '/srv/b'))).repo, { kind: 'ssh', host: 'down', dir: '/srv/b' })
  assert.deepEqual((await resolveRepo(remoteFocus, [], pin('up', dir))).repo, { kind: 'ssh', host: 'up', dir })
  assert.equal((await resolveRepo(remoteFocus, [], pin('up', join(dir, 'deleted')))).repo, null, 'a repo the reachable host no longer has is not tried')
})

const named = { displayName: 'factory', branch: 'main', terminals: [] }

test('with every server reached over SSH, a pin to a host no server names is dropped without a word and its host is never asked', async () => {
  const dir = repo(root())
  servers([{ name: 'up', host: 'up', worktrees: [{ displayName: 'a', path: dir }] }])
  const retired: Repo = { kind: 'ssh', host: 'down' as SshHost, dir: '/srv/old' as never }
  for (const [focus, pins] of [[remoteFocus, { '@remote-or-none': retired }], [focusWith(named), { factory: retired }]] as const) {
    const answer = await resolveRepo(focus, [], pins)
    assert.equal(answer.repo, null)
    assert.equal(answer.problem, undefined, 'a server the person no longer uses is not their problem')
    assert.deepEqual(answer.candidates.map((c) => c.repo), [{ kind: 'ssh', host: 'up', dir }])
  }
  assert.ok(!calls('ssh').includes('down'), `ssh was started for: ${calls('ssh')}`)
})

// A server paired with a code: Orca names it, with no SSH host to reach it through.
const lab = { name: 'lab', address: '203.0.113.7', worktrees: [] }
const labBox = 'lab-box' as SshHost
const tracked = (dir: string) => ({ workspaces: [{ name: 'factory', path: dir, folder: 'ok' }] })

test('a server paired with a code is named with the address Orca connects to, and one that is offline says which', async () => {
  servers([lab])
  assert.deepEqual((await resolveRepo(remoteFocus, [], {})).sshless, [{ name: 'lab', address: '203.0.113.7' }])
  servers([{ name: 'lab' }])
  const offline = await resolveRepo(remoteFocus, [], {})
  assert.deepEqual(offline.sshless, [{ name: 'lab' }])
  assert.equal(offline.problem?.code, 'server_unreachable')
  assert.equal(offline.problem?.server, 'lab')
})

test('with a server paired with a code, a hand-written ssh pin is asked: it holds when its host has the repo, and is dropped without a word when not', async () => {
  const dir = repo(root())
  const pinned: Repo = { kind: 'ssh', host: labBox, dir: dir as never }
  servers([lab])
  const unnamed = await resolveRepo(remoteFocus, [], { '@remote-or-none': pinned })
  assert.deepEqual(unnamed.repo, pinned)
  assert.equal(unnamed.problem, undefined)
  assert.deepEqual((await resolveRepo(focusWith(named), [], { factory: pinned })).repo, pinned)
  assert.equal((await resolveRepo(remoteFocus, [], { '@remote-or-none': { ...pinned, dir: join(dir, 'deleted') as never } })).repo, null)

  const look = rememberedLookups()
  const gone = { '@remote-or-none': { kind: 'ssh', host: 'down', dir: '/srv/factory' } as Repo }
  const offline = await resolveRepo(remoteFocus, [], gone, { look })
  assert.equal(offline.repo, null, 'a pin to a host that is gone does not hold every remote workspace on an error')
  assert.equal(offline.problem, undefined)
  assert.deepEqual(offline.remoteHosts, [])
  await resolveRepo(remoteFocus, [], gone, { look })
  assert.equal(calls('ssh').filter((h) => h === 'down').length, 1, 'a host that did not answer is not asked again on the next workspace switch')
})

test('with the orca command missing, no server can be paired: the panel says so, offers the repos of this Mac and uses a local pick', async () => {
  const saved = process.env.ORCA_CLI_COMMAND
  process.env.ORCA_CLI_COMMAND = join(cli, 'no-such-orca')
  try {
    const mac = repo(root())
    const answer = await resolveRepo(focusWith(null, [mac]), [], { '@remote-or-none': { kind: 'local', dir: mac } as Repo })
    assert.equal(answer.problem?.code, 'orca_cli_missing')
    assert.deepEqual(answer.candidates.map((c) => c.repo), [{ kind: 'local', dir: mac }])
    assert.deepEqual(answer.repo, { kind: 'local', dir: mac })
  } finally {
    process.env.ORCA_CLI_COMMAND = saved
  }
})

test("while Orca's server list cannot be read, the repos of this Mac are offered but a local pick is not used", async () => {
  const mac = repo(root())
  servers([])
  rmSync(join(cli, 'environment-list-.json'))
  const answer = await resolveRepo(focusWith(null, [mac]), [], { '@remote-or-none': { kind: 'local', dir: mac } as Repo })
  assert.ok(answer.problem, 'the failure is said')
  assert.deepEqual(answer.candidates.map((c) => c.repo), [{ kind: 'local', dir: mac }])
  assert.equal(answer.repo, null, 'a remote workspace may be focused, and a repo of this Mac is not its repo')
})

test('a login the person added offers the repos of its swamp registry, and keeps a pick while it does not answer', async () => {
  const dir = repo(root())
  servers([lab], tracked(dir))
  const answer = await resolveRepo(remoteFocus, [], {}, { added: [labBox] })
  assert.deepEqual(answer.candidates.map((c) => c.repo), [{ kind: 'ssh', host: 'lab-box', dir }])
  assert.deepEqual(answer.remoteHosts, ['lab-box'])
  assert.equal(answer.problem, undefined)
  const pinned: Repo = { kind: 'ssh', host: 'down' as SshHost, dir: '/srv/factory' as never }
  const down = await resolveRepo(remoteFocus, [], { '@remote-or-none': pinned }, { added: ['down' as SshHost] })
  assert.deepEqual(down.repo, pinned, 'an added login that is down for a minute keeps its pick, as a paired host does')
  assert.equal(down.problem?.code, 'host_unreachable')
  assert.deepEqual(down.problem?.ssh, { login: 'down', cause: 'no-answer', said: 'ssh: connect to host down port 22: Connection refused' })
})

test("while Orca's server list cannot be read, a pick on an added login still follows what that login answers", async () => {
  const dir = repo(root())
  servers([lab], tracked(dir))
  rmSync(join(cli, 'environment-list-.json'))
  const pin = (host: string, d: string) => ({ '@remote-or-none': { kind: 'ssh', host, dir: d } as Repo })
  assert.deepEqual((await resolveRepo(remoteFocus, [], pin('lab-box', dir), { added: [labBox] })).repo, { kind: 'ssh', host: 'lab-box', dir })
  assert.equal((await resolveRepo(remoteFocus, [], pin('lab-box', join(dir, 'deleted')), { added: [labBox] })).repo, null, 'the login answered, and the repo is not there')
  assert.deepEqual((await resolveRepo(remoteFocus, [], pin('down', '/srv/b'), { added: ['down' as SshHost] })).repo, { kind: 'ssh', host: 'down', dir: '/srv/b' })
  assert.deepEqual((await resolveRepo(remoteFocus, [], pin('elsewhere', '/srv/b'))).repo, { kind: 'ssh', host: 'elsewhere', dir: '/srv/b' }, 'a host that may be a paired one, and was not asked, keeps its pick')
})

test('with a server paired without SSH, a remote workspace is not offered the repos of this Mac', async () => {
  const mac = repo(root())
  servers([lab])
  const pinned = { '@remote-or-none': { kind: 'local', dir: mac } as Repo, factory: { kind: 'local', dir: mac } as Repo }
  for (const context of [null, named]) {
    const answer = await resolveRepo(focusWith(context, [mac]), [{ name: 'mac', path: mac }], pinned)
    assert.deepEqual(answer.candidates, [])
    assert.equal(answer.repo, null, 'a local repo pinned earlier is not used either')
    assert.deepEqual(answer.sshless, [{ name: 'lab', address: '203.0.113.7' }])
  }
  servers([])
  const none = await resolveRepo(focusWith(null, [mac]), [], {})
  assert.deepEqual(none.candidates.map((c) => c.repo), [{ kind: 'local', dir: mac }], 'with no remote server paired at all, they are offered')
})

test('an answer that names a problem is given again for a few seconds, so a server that is off does not hold every workspace switch', async () => {
  servers([{ name: 'lab' }])
  const look = rememberedLookups()
  assert.equal((await resolveRepo(remoteFocus, [], {}, { look })).problem?.code, 'server_unreachable')
  const asked = calls('orca').length
  assert.equal((await resolveRepo(remoteFocus, [], {}, { look })).problem?.code, 'server_unreachable')
  assert.equal(calls('orca').length, asked, 'the second answer started no orca command')
  await resolveRepo(remoteFocus, [], {}, { look, fresh: true })
  assert.ok(calls('orca').length > asked, 'Retry and Refresh read again')

  let [time, reads] = [0, 0]
  const read = remembered(60_000, async () => ({ problem: ++reads < 3 }), (v) => v.problem, () => time)
  await read()
  time = 9_000
  assert.equal((await read(), reads), 1, 'within 10 s the problem is answered again')
  time = 11_000
  assert.equal((await read(), reads), 2, 'after 10 s it is read again')
  time = 30_000
  assert.equal((await read(), reads), 3)
  time = 50_000
  assert.equal((await read(), reads), 3, 'an answer with no problem stays')
})
