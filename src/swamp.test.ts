import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { SwampFailure, type Repo, type RepoDir, type RunId, type SshHost } from './domain'
import { probeRemote, sshTryCommand, startResume, swamp } from './swamp'

// A stand-in `ssh` on PATH logs its argv, then hands the command string to the remote person's login shell
// ($LOGIN_SHELL) with stdin attached, as sshd does. The remote home holds a stand-in swamp that answers what it got.
const fake = mkdtempSync(join(tmpdir(), 'orca-swamp-ssh-'))
const remoteHome = join(fake, 'remote-home')
const argvLog = join(fake, 'ssh.argv')
mkdirSync(join(fake, 'bin'), { recursive: true })
mkdirSync(join(remoteHome, '.local/bin'), { recursive: true })

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

executable(
  join(fake, 'bin/ssh'),
  `for a; do last=$a; done
{ printf '%s\\0' "$@"; printf '\\036'; } >> '${argvLog}'
if [ "$FAKE_SSH" = unreachable ]; then echo "ssh: connect to host x port 22: Connection refused" >&2; exit 255; fi
cd '${remoteHome}' && HOME='${remoteHome}' exec "\${LOGIN_SHELL:-sh}" -c "\${BANNER:+echo $BANNER; }$last"`
)

const node = JSON.stringify(process.execPath)
const swampBody = (record: string) => `case "$FAKE_SWAMP" in
  noisy) printf 'ControlSocket /x already exists, disabling multiplexing\\r\\n{\\n  "error": "Workflow not found: nope"\\n}\\n' >&2; exit 1 ;;
  silent) exit 3 ;;
  stdin) cat >/dev/null ;;
  slow) sleep 1 ;;
esac
ELECTRON_RUN_AS_NODE=1 exec ${node} -e 'const s=JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)});require("fs").appendFileSync(${JSON.stringify(record)},s+"\\n");console.log(s)' -- "$@"`
executable(join(remoteHome, '.local/bin/swamp'), swampBody(join(fake, 'remote-swamp.log')))
process.env.PATH = `${join(fake, 'bin')}:${process.env.PATH}`

const box = 'box' as SshHost
const remoteRepo = (dir: string): Repo => ({ kind: 'ssh', host: box, dir: dir as RepoDir })
const sshCalls = (): string[][] => (existsSync(argvLog) ? readFileSync(argvLog, 'utf8').split('\x1e').filter(Boolean).map((c) => c.split('\0').slice(0, -1)) : [])

function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  const set = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) x === undefined ? delete process.env[k] : (process.env[k] = x)
  }
  set(vars)
  return run().finally(() => set(saved))
}

async function failure(p: Promise<unknown>): Promise<SwampFailure> {
  try {
    await p
  } catch (e) {
    return e as SwampFailure
  }
  throw new Error('expected a failure')
}

const NOTE = `line one\nline two! it's "quoted" $(touch /tmp/orca-swamp-pwned) \`id\` \\ back\\\\slash $HOME *`
const shells = ['sh', 'bash', 'zsh', 'tcsh', 'csh'].filter((s) => {
  try {
    execFileSync('sh', ['-c', `command -v ${s}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

for (const shell of shells) {
  test(`a gate note with newlines, ! and quotes reaches swamp whole when the remote login shell is ${shell}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "repo with 'quote' $x-"))
    const answer = (await withEnv({ LOGIN_SHELL: shell }, () =>
      swamp(remoteRepo(dir), { cmd: 'decide', verb: 'reject', workflow: 'gated', runId: 'r-1' as RunId, step: 'signoff', reason: NOTE })
    )) as { cwd: string; args: string[] }
    assert.deepEqual(answer.args, ['workflow', 'reject', 'gated', 'signoff', '--run', 'r-1', '--reason', NOTE, '--json', '--no-color'])
    assert.ok(answer.cwd.endsWith(dir.split('/').at(-1)!), 'swamp runs in the repo folder')
    assert.ok(!existsSync('/tmp/orca-swamp-pwned'), 'no part of the note ran as a command')
  })
}

test('a login shell that prints a banner does not break reading swamp output or finding repos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-swamp-banner-'))
  writeFileSync(join(dir, '.swamp.yaml'), 'swampVersion: test\n')
  mkdirSync(join(dir, 'sub'))
  await withEnv({ BANNER: 'Welcome to box' }, async () => {
    const answer = (await swamp(remoteRepo(dir), { cmd: 'version' })) as { args: string[] }
    assert.deepEqual(answer.args, ['version', '--json', '--no-color'])
    const probe = await probeRemote(box, [join(dir, 'sub'), '/'])
    assert.deepEqual(probe.above, [dir, null])
    assert.deepEqual((probe.registry as { args: string[] }).args, ['workspace', 'list', '--json', '--no-color'])
  })
})

test("swamp's error message shows even behind ssh's own notices on stderr", async () => {
  const e = await failure(withEnv({ FAKE_SWAMP: 'noisy' }, () => swamp(remoteRepo(remoteHome), { cmd: 'workflow.get', workflow: 'nope' })))
  assert.equal(e.code, 'swamp_error')
  assert.equal(e.message, 'Workflow not found: nope')
})

test('swamp failing without a word says it exited, not the ssh command line', async () => {
  const e = await failure(withEnv({ FAKE_SWAMP: 'silent' }, () => swamp(remoteRepo(remoteHome), { cmd: 'version' })))
  assert.equal(e.code, 'swamp_error')
  assert.ok(!e.message.includes('BatchMode') && e.message.includes('3'), e.message)
})

test('a remote repo folder that is gone is reported as not a swamp repo', async () => {
  const e = await failure(swamp(remoteRepo(join(fake, 'gone')), { cmd: 'version' }))
  assert.equal(e.code, 'not_a_swamp_repo')
  assert.ok(e.message.includes(join(fake, 'gone')), e.message)
})

test('an unreachable host is reported as unreachable with the command to try', async () => {
  const e = await failure(withEnv({ FAKE_SSH: 'unreachable' }, () => swamp(remoteRepo(remoteHome), { cmd: 'version' })))
  assert.equal(e.code, 'host_unreachable')
  assert.ok(e.message.includes('Connection refused') && e.message.includes(sshTryCommand(box)), e.message)
})

test('a host name starting with a dash is passed to ssh as the host, never as an option', async () => {
  await failure(swamp({ kind: 'ssh', host: '-oProxyCommand=touch x' as SshHost, dir: remoteHome as RepoDir }, { cmd: 'version' })).catch(() => {})
  const argv = sshCalls().at(-1)!
  assert.equal(argv[argv.indexOf('-oProxyCommand=touch x') - 1], '--')
})

test('the ssh command shown to try is safe to paste for any host name', () => {
  const marker = join(fake, 'pasted')
  const host = `-oProxyCommand=x $(touch ${marker}) \`touch ${marker}\`` as SshHost
  const words = execFileSync('sh', ['-c', `ssh() { printf '%s\\n' "$@"; }; ${sshTryCommand(host)}`], { encoding: 'utf8' }).trim().split('\n')
  assert.ok(!existsSync(marker), 'pasting it ran nothing')
  assert.deepEqual(words.slice(-3), ['--', host, 'true'])
})

test('connection sharing lives in the home folder, and is left off where its socket path would pass the 104-byte limit', async () => {
  const controlPath = async (home: string) => {
    await withEnv({ HOME: home }, () => swamp(remoteRepo(remoteHome), { cmd: 'version' }))
    return sshCalls().at(-1)!.find((a) => a.startsWith('ControlPath='))?.slice('ControlPath='.length)
  }
  const short = mkdtempSync('/tmp/oh-')
  assert.equal(await controlPath(short), `${short}/.config/orca-swamp/ssh/%C`)
  const long = mkdtempSync(join(tmpdir(), 'a-home-folder-long-enough-to-overflow-'))
  // ssh binds `<ControlPath>.<16 random characters>` first, and macOS caps a socket path at 103 bytes.
  const path = await controlPath(long)
  assert.ok(!path || Buffer.byteLength(path.replace('%C', 'h'.repeat(40))) + 17 <= 103, path)
})

test('a socket folder that cannot be created or written still lets swamp run', async () => {
  const blocked = mkdtempSync(join(tmpdir(), 'orca-swamp-home-'))
  writeFileSync(join(blocked, '.config'), 'a file where the folder should be')
  const readOnly = mkdtempSync(join(tmpdir(), 'orca-swamp-home-'))
  mkdirSync(join(readOnly, '.config/orca-swamp/ssh'), { recursive: true })
  chmodSync(join(readOnly, '.config/orca-swamp/ssh'), 0o500)
  for (const home of [blocked, readOnly]) {
    const answer = (await withEnv({ HOME: home }, () => swamp(remoteRepo(remoteHome), { cmd: 'version' }))) as { args: string[] }
    assert.deepEqual(answer.args, ['version', '--json', '--no-color'])
    assert.ok(!sshCalls().at(-1)!.some((a) => a.startsWith(`ControlPath=${home}`)), 'ssh is not pointed at a folder it cannot write')
  }
})

test('resume on a remote host starts in the background and ssh returns before it finishes', async () => {
  const log = join(fake, 'remote-swamp.log')
  writeFileSync(log, '')
  const errors: Error[] = []
  const started = Date.now()
  await withEnv({ FAKE_SWAMP: 'slow' }, async () => {
    startResume(remoteRepo(remoteHome), 'gated', 'r-9' as RunId, (e) => errors.push(e))
    while (!readFileSync(log, 'utf8') && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 50))
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')).args, ['workflow', 'resume', 'gated', '--run', 'r-9', '--json', '--no-color'])
})

const localSwamp = join(fake, 'local-swamp')
executable(localSwamp, swampBody(join(fake, 'local-swamp.log')))

test('a local repo folder that is gone is reported as not a swamp repo, not swamp missing', async () => {
  const e = await failure(withEnv({ ORCA_SWAMP_BIN: localSwamp }, () => swamp({ kind: 'local', dir: join(fake, 'gone') as RepoDir }, { cmd: 'version' })))
  assert.equal(e.code, 'not_a_swamp_repo')
  assert.ok(e.message.includes(join(fake, 'gone')), e.message)
})

test('swamp installed in ~/.local/bin after the worker started is found', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-swamp-home-'))
  await withEnv({ HOME: home, ORCA_SWAMP_BIN: undefined, PATH: '/usr/bin:/bin' }, async () => {
    assert.equal((await failure(swamp({ kind: 'local', dir: home as RepoDir }, { cmd: 'version' }))).code, 'swamp_not_found')
    mkdirSync(join(home, '.local/bin'), { recursive: true })
    executable(join(home, '.local/bin/swamp'), swampBody(join(fake, 'local-swamp.log')))
    const answer = (await swamp({ kind: 'local', dir: home as RepoDir }, { cmd: 'version' })) as { args: string[] }
    assert.deepEqual(answer.args, ['version', '--json', '--no-color'])
  })
})

