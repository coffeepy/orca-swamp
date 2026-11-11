import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import type { Repo, SshHost } from './domain'
import { parsePins, parseWorkspaces, pickRepo, remoteRepos, resolveRepo } from './repo'

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
// and otherwise runs the remote command in a local sh, as the remote login shell would.
const cli = mkdtempSync(join(tmpdir(), 'swampling-cli-'))
function script(name: string, body: string): void {
  mkdirSync(join(cli, 'bin'), { recursive: true })
  writeFileSync(join(cli, 'bin', name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(cli, 'bin', name), 0o755)
}
script('orca', `f='${cli}'/$(printf '%s' "$1-$2-$4" | tr -c 'a-zA-Z0-9-' _).json; [ -f "$f" ] && exec cat "$f"; echo '{"ok":false,"error":{"message":"Unknown Orca server"}}'; exit 1`)
script('ssh', `for a; do host=$prev; last=$a; prev=$a; done; [ "$host" = down ] && { echo 'ssh: connect to host down port 22: Connection refused' >&2; exit 255; }; HOME='${cli}/home' exec sh -c "$last"`)
process.env.ORCA_CLI_COMMAND = join(cli, 'bin', 'orca')
process.env.PATH = `${join(cli, 'bin')}:${process.env.PATH}`
mkdirSync(join(cli, 'home/.local/bin'), { recursive: true })
writeFileSync(join(cli, 'home/.local/bin/swamp'), `#!/bin/sh\ncat '${cli}/registry.json' 2>/dev/null || echo '{"workspaces":[]}'\n`)
chmodSync(join(cli, 'home/.local/bin/swamp'), 0o755)

type Server = { name: string; host?: string; worktrees?: { displayName: string; path: string }[] }
function servers(list: Server[], registry: unknown = { workspaces: [] }): void {
  for (const f of readdirSync(cli)) if (f.endsWith('.json')) rmSync(join(cli, f))
  const result = (body: unknown) => JSON.stringify({ ok: true, result: body })
  writeFileSync(join(cli, 'environment-list-.json'), result({ environments: list.map((s) => ({ name: s.name, ...(s.host && { orcadDeployment: { sshTargetId: `id-${s.host}` } }) })) }))
  writeFileSync(join(cli, 'host-list-.json'), result({ hosts: list.flatMap((s) => (s.host ? [{ kind: 'ssh', id: `id-${s.host}`, name: s.host }] : [])) }))
  for (const s of list) {
    if (s.worktrees) writeFileSync(join(cli, `worktree-list-${s.name}.json`), result({ worktrees: s.worktrees.map((w) => ({ ...w, hostId: 'local' })) }))
  }
  writeFileSync(join(cli, 'registry.json'), JSON.stringify(registry))
}
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
  assert.equal((await resolveRepo(remoteFocus, [], pin('retired', '/srv/old'))).repo, null, 'a host no longer paired is not tried')
  assert.equal((await resolveRepo(remoteFocus, [], pin('up', join(dir, 'deleted')))).repo, null, 'a repo the reachable host no longer has is not tried')
})

test('with the orca command missing, the panel says so and offers local repos', async () => {
  const saved = process.env.ORCA_CLI_COMMAND
  process.env.ORCA_CLI_COMMAND = join(cli, 'no-such-orca')
  try {
    const answer = await resolveRepo(remoteFocus, [], {})
    assert.equal(answer.problem?.code, 'orca_cli_missing')
    assert.deepEqual(answer.remoteHosts, [])
  } finally {
    process.env.ORCA_CLI_COMMAND = saved
  }
})
