import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { parseServers, parseServerWorkspaces } from './remote'
import { remoteCommand } from './swamp'
import type { SshHost } from './domain'

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

test('each saved Orca server is reached through the ssh host Orca deployed it with, or not at all', () => {
  assert.deepEqual(parseServers(fx('orca.environment-list'), fx('orca.host-list')), [
    { server: 'jarvis', host: 'jarvis' },
    { server: 'cloudbox', host: null }
  ])
})

test("a server's workspaces carry their name, branch and path on that server", () => {
  const list = parseServerWorkspaces(fx('orca.worktree-list-jarvis'), 'jarvis', 'jarvis' as SshHost)
  assert.deepEqual(list[0], {
    name: 'factory-v3',
    branch: 'refs/heads/factory-v3',
    path: '/home/dev/orca/workspaces/shop/factory-v3',
    server: 'jarvis',
    host: 'jarvis'
  })
  assert.equal(list.length, 3)
})

// On the host, `sh -s` reads the script from ssh's stdin. Running the same script with `sh -c`, and with
// bash and zsh for hosts whose sh is one of them, against a stand-in swamp that prints what it received,
// shows each argument arrives whole.
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'swampling-home-'))
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  const swamp = join(home, '.local/bin/swamp')
  writeFileSync(swamp, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(1)}))' -- "$@"\n`)
  chmodSync(swamp, 0o755)
  return home
}

const NASTY = [`it's "fine"`, '$(touch /tmp/swampling-pwned)', '`id`', 'two\nlines', '; rm -rf ~', '$HOME', '*', '-n', '\\', '']

for (const shell of ['sh', 'bash', 'zsh']) {
  test(`every swamp argument reaches the remote swamp unchanged through ${shell}`, () => {
    const home = fakeHome()
    const dir = mkdtempSync(join(tmpdir(), "repo with 'quote' $x-"))
    const args = ['workflow', 'reject', 'gated', 'signoff', '--reason', ...NASTY]
    const out = execFileSync(shell, ['-c', remoteCommand(dir, args)], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
    const seen = JSON.parse(out)
    assert.deepEqual(seen.args, args)
    assert.equal(seen.cwd.endsWith(dir.split('/').at(-1)!), true, 'swamp runs in the repo folder')
  })
}

test('a host without swamp says so with exit 127, which the panel reports as swamp missing there', () => {
  const home = mkdtempSync(join(tmpdir(), 'swampling-empty-'))
  let failure: { status?: number; stderr?: string } = {}
  try {
    execFileSync('sh', ['-c', remoteCommand(home, ['version'])], { env: { PATH: '/usr/bin:/bin', HOME: home, SHELL: '/bin/sh' }, encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    failure = e as typeof failure
  }
  assert.equal(failure.status, 127)
  assert.ok(String(failure.stderr).includes('swampling: swamp is not installed'))
})

test('the probe names the repo at or above the folder, then the registry', () => {
  const home = fakeHome()
  const repo = mkdtempSync(join(tmpdir(), 'swampling-probe-'))
  writeFileSync(join(repo, '.swamp.yaml'), 'swampVersion: test\n')
  mkdirSync(join(repo, 'a/b'), { recursive: true })
  const out = execFileSync('sh', ['-c', remoteCommand(join(repo, 'a/b'), [], 'probe')], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  const [first, ...rest] = out.split('\n')
  assert.equal(first, repo)
  assert.deepEqual(JSON.parse(rest.join('\n')).args, ['workspace', 'list', '--json', '--no-color'])
})

test('a resume that fails on the host within its first seconds exits with its error, and one still running exits 0', () => {
  const home = mkdtempSync(join(tmpdir(), 'swampling-resume-'))
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  const swamp = join(home, '.local/bin/swamp')
  const run = () => {
    try {
      execFileSync('sh', ['-c', remoteCommand(home, ['workflow', 'resume', 'gated'], 'detach')], { env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: 'pipe' })
      return { status: 0, stderr: '' }
    } catch (e) {
      return e as { status: number; stderr: string }
    }
  }
  writeFileSync(swamp, `#!/bin/sh\necho '{"error":"run is locked"}' >&2\nexit 1\n`)
  chmodSync(swamp, 0o755)
  const failed = run()
  assert.equal(failed.status, 1)
  assert.ok(failed.stderr.includes('run is locked'), failed.stderr)
  writeFileSync(swamp, `#!/bin/sh\nsleep 30\n`)
  const started = Date.now()
  assert.equal(run().status, 0)
  assert.ok(Date.now() - started < 15_000, 'ssh is not held for the whole resume')
})
