import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { SwampFailure, type Repo, type RepoDir, type RunId, type SshHost } from './domain'
import { probeRemote, runFile, runVitals, startBackground, swamp } from './swamp'

// A stand-in `ssh` on PATH logs its argv, then hands the command string to the remote person's login shell
// ($LOGIN_SHELL) with stdin attached, as sshd does. The remote home holds a stand-in swamp that answers what it got.
const fake = mkdtempSync(join(tmpdir(), 'swampling-ssh-'))
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

const NOTE = `line one\nline two! it's "quoted" $(touch /tmp/swampling-pwned) \`id\` \\ back\\\\slash $HOME *`
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
    assert.ok(!existsSync('/tmp/swampling-pwned'), 'no part of the note ran as a command')
  })
}

test('a login shell that prints a banner does not break reading swamp output or finding repos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swampling-banner-'))
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

test('an unreachable host is reported in plain words with why, and with no command that cannot ask a question', async () => {
  const e = await failure(withEnv({ FAKE_SSH: 'unreachable' }, () => swamp(remoteRepo(remoteHome), { cmd: 'version' })))
  assert.equal(e.code, 'host_unreachable')
  assert.deepEqual(e.ssh, { login: box, cause: 'no-answer', said: 'ssh: connect to host x port 22: Connection refused' })
  assert.ok(e.message.startsWith(`${box} did not answer on the SSH port.`) && e.message.endsWith('ssh said: ssh: connect to host x port 22: Connection refused'), e.message)
  assert.ok(!/BatchMode|`|\.\./.test(e.message), e.message)
})

test('a host name starting with a dash is passed to ssh as the host, never as an option', async () => {
  await failure(swamp({ kind: 'ssh', host: '-oProxyCommand=touch x' as SshHost, dir: remoteHome as RepoDir }, { cmd: 'version' })).catch(() => {})
  const argv = sshCalls().at(-1)!
  assert.equal(argv[argv.indexOf('-oProxyCommand=touch x') - 1], '--')
})

test('connection sharing lives in the home folder, and is left off where its socket path would pass the 104-byte limit', async () => {
  const controlPath = async (home: string) => {
    await withEnv({ HOME: home }, () => swamp(remoteRepo(remoteHome), { cmd: 'version' }))
    return sshCalls().at(-1)!.find((a) => a.startsWith('ControlPath='))?.slice('ControlPath='.length)
  }
  const short = mkdtempSync('/tmp/oh-')
  assert.equal(await controlPath(short), `${short}/.config/swampling/ssh/%C`)
  const long = mkdtempSync(join(tmpdir(), 'a-home-folder-long-enough-to-overflow-'))
  // ssh binds `<ControlPath>.<16 random characters>` first, and macOS caps a socket path at 103 bytes.
  const path = await controlPath(long)
  assert.ok(!path || Buffer.byteLength(path.replace('%C', 'h'.repeat(40))) + 17 <= 103, path)
})

test('a socket folder that cannot be created or written still lets swamp run', async () => {
  const blocked = mkdtempSync(join(tmpdir(), 'swampling-home-'))
  writeFileSync(join(blocked, '.config'), 'a file where the folder should be')
  const readOnly = mkdtempSync(join(tmpdir(), 'swampling-home-'))
  mkdirSync(join(readOnly, '.config/swampling/ssh'), { recursive: true })
  chmodSync(join(readOnly, '.config/swampling/ssh'), 0o500)
  for (const home of [blocked, readOnly]) {
    const answer = (await withEnv({ HOME: home }, () => swamp(remoteRepo(remoteHome), { cmd: 'version' }))) as { args: string[] }
    assert.deepEqual(answer.args, ['version', '--json', '--no-color'])
    assert.ok(!sshCalls().at(-1)!.some((a) => a.startsWith(`ControlPath=${home}`)), 'ssh is not pointed at a folder it cannot write')
  }
})

test('resume on a remote host starts in the background and ssh returns before it finishes', async () => {
  const log = join(fake, 'remote-swamp.log')
  writeFileSync(log, '')
  const errors: unknown[] = []
  const started = Date.now()
  await withEnv({ FAKE_SWAMP: 'slow' }, async () => {
    startBackground(remoteRepo(remoteHome), { cmd: 'resume', workflow: 'gated', runId: 'r-9' as RunId, from: { job: 'main', step: 'sign off' } }, (e) => e && errors.push(e))
    while (!readFileSync(log, 'utf8') && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 50))
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')).args, ['workflow', 'resume', 'gated', '--run', 'r-9', '--from', 'sign off', '--job', 'main', '--json', '--no-color'])
})

test('a run started on a remote host gets each input as one argument, whatever shell code its value holds', async () => {
  const log = join(fake, 'remote-swamp.log')
  writeFileSync(log, '')
  const inputs = { issue: `'; touch ${join(fake, 'pwned')}; echo '`, note: '$(touch pwned) `id` @/etc/passwd\nline two', count: 3, tags: ['a b', 'c'] }
  const exits: unknown[] = []
  startBackground(remoteRepo(remoteHome), { cmd: 'run', workflow: 'deploy', inputs }, (e) => exits.push(e))
  const started = Date.now()
  while (!exits.length && Date.now() - started < 15_000) await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(exits, [undefined], 'the start reported no failure')
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')).args, [
    'workflow', 'run', 'deploy',
    '--input', `issue:json=${JSON.stringify(inputs.issue)}`,
    '--input', `note:json=${JSON.stringify(inputs.note)}`,
    '--input', 'count:json=3',
    '--input', 'tags:json=["a b","c"]',
    '--json', '--no-color'
  ])
  assert.ok(!existsSync(join(fake, 'pwned')) && !existsSync(join(remoteHome, 'pwned')), 'no input value ran as shell code')
})

const localSwamp = join(fake, 'local-swamp')
executable(localSwamp, swampBody(join(fake, 'local-swamp.log')))

test('a local repo folder that is gone is reported as not a swamp repo, not swamp missing', async () => {
  const e = await failure(withEnv({ SWAMPLING_BIN: localSwamp }, () => swamp({ kind: 'local', dir: join(fake, 'gone') as RepoDir }, { cmd: 'version' })))
  assert.equal(e.code, 'not_a_swamp_repo')
  assert.ok(e.message.includes(join(fake, 'gone')), e.message)
})

test('swamp installed in ~/.local/bin after the worker started is found', async () => {
  const home = mkdtempSync(join(tmpdir(), 'swampling-home-'))
  await withEnv({ HOME: home, SWAMPLING_BIN: undefined, PATH: '/usr/bin:/bin' }, async () => {
    assert.equal((await failure(swamp({ kind: 'local', dir: home as RepoDir }, { cmd: 'version' }))).code, 'swamp_not_found')
    mkdirSync(join(home, '.local/bin'), { recursive: true })
    executable(join(home, '.local/bin/swamp'), swampBody(join(fake, 'local-swamp.log')))
    const answer = (await swamp({ kind: 'local', dir: home as RepoDir }, { cmd: 'version' })) as { args: string[] }
    assert.deepEqual(answer.args, ['version', '--json', '--no-color'])
  })
})

test('a background swamp that refuses says why, and one that ends with an error and no words is marked as such', async () => {
  const exit = (mode: string) =>
    withEnv({ SWAMPLING_BIN: localSwamp, FAKE_SWAMP: mode }, async () => {
      const exits: (SwampFailure | undefined)[] = []
      startBackground({ kind: 'local', dir: fake as RepoDir }, { cmd: 'run', workflow: 'w', inputs: {} }, (e) => exits.push(e))
      // The started swamp does not keep this process alive, so the wait does.
      while (!exits.length) await new Promise((r) => setTimeout(r, 20))
      return exits[0]
    })
  const refused = await exit('noisy')
  assert.equal(refused?.message, 'Workflow not found: nope')
  assert.equal(refused?.silent, undefined)
  const ended = await exit('silent')
  assert.equal(ended?.silent, true, 'swamp run exits with an error and no words when the run itself fails')
  assert.equal(await exit(''), undefined)
})

/** A run record as swamp writes it, naming `pid` as its owner, with its log beside it; each file last changed at the time given. */
function runFiles(pid: number, changed: { yaml: string; log?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'swampling-run-'))
  const file = runFile(dir, 'wf-1', 'run-1')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `id: run-1\nstatus: running\njobs:\n  - jobName: main\n    steps:\n      - stepName: nap\n        output:\n          pid: 1\ntags: {}\npid: ${pid}\nlogFile: x\n`)
  utimesSync(file, new Date(changed.yaml), new Date(changed.yaml))
  if (changed.log) {
    writeFileSync(file.replace(/\.yaml$/, '.log'), 'a line\n')
    utimesSync(file.replace(/\.yaml$/, '.log'), new Date(changed.log), new Date(changed.log))
  }
  return file
}

test('a run whose swamp process is alive is not gone, and its last activity is the later of its record and its log', () => {
  const file = runFiles(process.pid, { yaml: '2026-11-11T10:00:00.000Z', log: '2026-11-11T10:07:00.000Z' })
  assert.deepEqual(runVitals(file), { activeAt: '2026-11-11T10:07:00.000Z' })
  assert.deepEqual(runVitals(runFiles(process.pid, { yaml: '2026-11-11T10:02:00.000Z' })), { activeAt: '2026-11-11T10:02:00.000Z' })
})

test('a run whose swamp process no longer exists is gone; a process of another user is alive', () => {
  const ended = spawnSync(process.execPath, ['-e', '']).pid!
  assert.deepEqual(runVitals(runFiles(ended, { yaml: '2026-11-11T10:00:00.000Z' })), { activeAt: '2026-11-11T10:00:00.000Z', gone: true })
  // pid 1 belongs to root, so the check is refused rather than answered "no such process".
  assert.ok(!('gone' in runVitals(runFiles(1, { yaml: '2026-11-11T10:00:00.000Z' }))))
})

test('a record that is not there, or an id that is not a plain name, gives no vitals instead of an error', () => {
  assert.deepEqual(runVitals(join(tmpdir(), 'swampling-none', 'workflow-run-x.yaml')), {})
  assert.equal(runFile('/repo', '../..', 'run-1'), '')
  assert.deepEqual(runVitals(runFile('/repo', 'wf', '../../etc/passwd')), {})
})
