import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SwampFailure, type Repo, type RepoDir, type RunId, type SshHost } from './domain'
import { studioUrl, WORK_ITEM_TYPE, type Expected } from './stagecraft'

// swamp's installer puts it in ~/.local/bin, which Orca's worker PATH may lack; otherwise PATH finds it.
// Looked up on every call, so a swamp installed while Orca runs is found without a reload.
function swampBin(): string {
  const installed = join(homedir(), '.local/bin/swamp')
  return process.env.ORCA_SWAMP_BIN ?? (existsSync(installed) ? installed : 'swamp')
}

const READ_TIMEOUT_MS = 20_000
const DECIDE_TIMEOUT_MS = 60_000
const STUDIO_START_MS = 30_000

export type Command =
  | { cmd: 'version' }
  | { cmd: 'workspaces' }
  | { cmd: 'workflow.search' }
  | { cmd: 'workflow.get'; workflow: string }
  | { cmd: 'history.search' }
  | { cmd: 'history.get'; workflow: string; runId?: RunId }
  | { cmd: 'history.logs'; runId: RunId }
  | { cmd: 'approvals' }
  | { cmd: 'decide'; verb: 'approve' | 'reject'; workflow: string; runId: RunId; step: string; reason?: string }
  | { cmd: 'types.stagecraft' }
  | { cmd: 'models' }
  | { cmd: 'model.get'; name: string }
  | { cmd: 'model.create'; type: string; name: string }
  | { cmd: 'data.query'; predicate: string }
  | { cmd: 'work-item'; method: 'approve' | 'decline' | 'advance'; key: string; inputs: Record<string, string>; expected: Expected }

function argv(c: Command): string[] {
  switch (c.cmd) {
    case 'version':
      return ['version']
    case 'workspaces':
      return ['workspace', 'list']
    case 'workflow.search':
      return ['workflow', 'search']
    case 'workflow.get':
      return ['workflow', 'get', c.workflow]
    case 'history.search':
      return ['workflow', 'history', 'search']
    case 'history.get':
      return ['workflow', 'history', 'get', c.runId ?? c.workflow]
    case 'history.logs':
      return ['workflow', 'history', 'logs', c.runId]
    case 'approvals':
      return ['workflow', 'approvals']
    case 'decide':
      return ['workflow', c.verb, c.workflow, c.step, '--run', c.runId, ...(c.reason ? ['--reason', c.reason] : [])]
    case 'types.stagecraft':
      return ['model', 'type', 'search', 'stagecraft']
    case 'models':
      return ['model', 'search']
    case 'model.get':
      return ['model', 'get', c.name]
    case 'model.create':
      return ['model', 'create', c.type, c.name]
    case 'data.query':
      return ['data', 'query', c.predicate]
    case 'work-item': {
      const { stage, cycle, era } = c.expected
      // Values go as JSON, because swamp reads a plain value that starts with @ as a file path.
      const inputs = { ...c.inputs, expectedStage: stage, expectedCycle: cycle, expectedEra: era }
      return ['model', WORK_ITEM_TYPE, 'method', 'run', c.method, c.key, ...Object.entries(inputs).flatMap(([k, v]) => ['--input', `${k}:json=${JSON.stringify(v)}`])]
    }
  }
}

// swamp prints its error as a JSON object on stderr, which may follow other lines (ssh's notices, warnings).
function jsonError(text: string): string | undefined {
  const at = text.search(/^\{/m)
  try {
    const error = at < 0 ? undefined : (JSON.parse(text.slice(at)) as { error?: unknown } | null)?.error
    return error == null ? undefined : String(error)
  } catch {}
}

function exitFailure(error: Error & { code?: unknown }, stdout: string, stderr: string): SwampFailure {
  const said = typeof error.code === 'number' ? `swamp exited with code ${error.code} without saying why` : error.message
  const message = jsonError(stderr) ?? jsonError(stdout) ?? (stderr.trim() || said)
  return new SwampFailure(message.startsWith('Not a swamp repository') ? 'not_a_swamp_repo' : 'swamp_error', message)
}

function spawnFailure(e: NodeJS.ErrnoException, dir: string): SwampFailure {
  // A missing working folder fails the spawn with the same ENOENT as a missing program.
  if (e.code === 'ENOENT' && !existsSync(dir)) return new SwampFailure('not_a_swamp_repo', `Not a swamp repository: ${dir} does not exist`)
  if (e.code === 'ENOENT') return new SwampFailure('swamp_not_found', `swamp not found (looked for ${swampBin()})`)
  if (e.code === 'E2BIG') return new SwampFailure('swamp_error', 'the swamp command is too long for this system to run; shorten the name or text the panel sent')
  return new SwampFailure('swamp_error', e.message)
}

/** Quotes one word for a POSIX shell (sh, bash, zsh; not csh or fish). */
export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

// Finds swamp the way the local lookup does: its installer's ~/.local/bin, else PATH, else the login shell's PATH.
// The login shell's answer is its last line, since its startup files may print first.
const FIND_SWAMP = `s="$HOME/.local/bin/swamp"; [ -x "$s" ] || s=$(command -v swamp 2>/dev/null) || s=$("\${SHELL:-sh}" -lc 'command -v swamp' 2>/dev/null | tail -n 1); [ -x "$s" ] || { echo "orca-swamp: swamp is not installed on $(uname -n)" >&2; exit 127; }`
const CD = `cd -- "$1" 2>/dev/null || { echo "orca-swamp: no folder $1 on $(uname -n)" >&2; exit 1; }`

/**
 * The POSIX sh script that runs swamp on a remote host: `set --` gives it the repo folder and swamp's
 * arguments as quoted positional words, so no value is ever read as shell code.
 */
export function remoteCommand(dir: string, args: string[], mode: 'run' | 'detach' | 'probe' = 'run'): string {
  const body = {
    run: `${FIND_SWAMP}; ${CD}; shift; exec "$s" "$@"`,
    // Waits up to 10 s, so a resume that fails at once exits with its error; one still running is left to finish.
    detach: `${FIND_SWAMP}; ${CD}; shift; e=$(mktemp); nohup "$s" "$@" >/dev/null 2>"$e" </dev/null & p=$!; i=0; while kill -0 $p 2>/dev/null && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done; if kill -0 $p 2>/dev/null; then rm -f "$e"; exit 0; fi; wait $p; c=$?; cat "$e" >&2; rm -f "$e"; exit $c`,
    // For each folder, one line naming the repo at or above it as swamp finds it; then swamp's workspace registry.
    probe: `for d; do while [ ! -f "$d/.swamp.yaml" ]; do [ "$d" = / ] && { d=; break; }; d=$(dirname -- "$d"); done; printf '%s\\n' "$d"; done; ${FIND_SWAMP}; cd && "$s" workspace list --json --no-color`
  }[mode]
  return `set -- ${[dir, ...args].map(shq).join(' ')}\n${body}\n`
}

// Connection reuse: the first call opens a master connection that later calls share for a minute.
// ssh first binds `<ControlPath>.<16 random characters>`, and macOS caps a socket path at 103 bytes.
// ponytail: a home folder past 22 characters, or a socket folder ssh cannot write, connects without sharing.
function sshOptions(): string[] {
  const dir = join(homedir(), '.config/orca-swamp/ssh')
  const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
  if (Buffer.byteLength(`${dir}/${'h'.repeat(40)}.${'r'.repeat(16)}`) > 103) return options
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    accessSync(dir, constants.W_OK)
  } catch {
    return options
  }
  return [...options, '-o', 'ControlMaster=auto', '-o', `ControlPath=${dir}/%C`, '-o', 'ControlPersist=60']
}

/** The exact command a person can run in a terminal to see why ssh failed. */
export const sshTryCommand = (host: SshHost): string => `ssh -o BatchMode=yes -- ${/^[\w.@:%+=-]+$/.test(host) ? host : shq(host)} true`

// Printed before the script runs, so lines the remote login shell's startup files print can be dropped.
const MARK = 'orca-swamp:output'

type Exec = { stdout: string; stderr: string }

/**
 * Runs the script with `sh -s` on the host, fed on stdin: the login shell sees only `sh -s`, so a
 * csh, tcsh or fish login shell, whose quoting differs from sh's, never parses a value.
 */
function sshExec(host: SshHost, script: string, timeout: number): Promise<Exec> {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', [...sshOptions(), '--', host, 'sh -s'], { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, rawStdout, stderr) => {
      const at = rawStdout.indexOf(`${MARK}\n`)
      const stdout = at < 0 ? rawStdout : rawStdout.slice(at + MARK.length + 1)
      const code = (error as { code?: unknown } | null)?.code
      if (error?.killed) return reject(new SwampFailure('timeout', `swamp on ${host} took longer than ${timeout / 1000} s`))
      if (code === 255) {
        const why = stderr.trim().split('\n').at(-1) || 'ssh failed'
        return reject(new SwampFailure('host_unreachable', `Could not reach ${host} over SSH: ${why}. The panel connects without a password or key prompt; run \`${sshTryCommand(host)}\` in a terminal to see why.`))
      }
      const ours = stderr.split('\n').find((l) => l.startsWith('orca-swamp: '))?.slice('orca-swamp: '.length)
      if (code === 127 && ours?.startsWith('swamp is not installed')) return reject(new SwampFailure('swamp_not_found', ours))
      if (code === 1 && ours?.startsWith('no folder')) return reject(new SwampFailure('not_a_swamp_repo', `Not a swamp repository: ${ours}`))
      if (error) return reject(exitFailure(error, stdout, stderr))
      resolve({ stdout, stderr })
    })
    // ssh that cannot connect exits without reading the script.
    child.stdin?.on('error', () => {})
    child.stdin?.end(`printf '%s\\n' ${MARK}\n${script}`)
  })
}

function localExec(dir: RepoDir, args: string[], timeout: number): Promise<Exec> {
  return new Promise((resolve, reject) => {
    try {
      execFile(swampBin(), args, { cwd: dir, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if ((error as NodeJS.ErrnoException | null)?.syscall?.startsWith('spawn')) {
          return reject(spawnFailure(error as NodeJS.ErrnoException, dir))
        }
        if (error?.killed) return reject(new SwampFailure('timeout', `swamp took longer than ${timeout / 1000} s`))
        if (error) return reject(exitFailure(error, stdout, stderr))
        resolve({ stdout, stderr })
      })
    } catch (e) {
      // Node throws some spawn errors, such as E2BIG, instead of passing them to the callback.
      reject(spawnFailure(e as NodeJS.ErrnoException, dir))
    }
  })
}

/** Runs swamp in the repo, on this machine or over SSH, and answers its parsed JSON. */
export async function swamp(repo: Repo, command: Command): Promise<unknown> {
  const timeout = command.cmd === 'decide' || command.cmd === 'work-item' ? DECIDE_TIMEOUT_MS : READ_TIMEOUT_MS
  const args = [...argv(command), '--json', '--no-color']
  const out = repo.kind === 'local' ? await localExec(repo.dir, args, timeout) : await sshExec(repo.host, remoteCommand(repo.dir, args), timeout)
  try {
    return JSON.parse(out.stdout)
  } catch {
    throw new SwampFailure('parse_error', 'swamp printed output that is not JSON')
  }
}

/** What swamp would find on a remote host for each folder: the repo at or above it, and its workspace registry. */
export async function probeRemote(host: SshHost, dirs: string[]): Promise<{ above: (RepoDir | null)[]; registry: unknown }> {
  const [first = '/', ...rest] = dirs
  const { stdout } = await sshExec(host, remoteCommand(first, rest, 'probe'), READ_TIMEOUT_MS)
  const lines = stdout.split('\n')
  let registry: unknown = null
  try {
    registry = JSON.parse(lines.slice(dirs.length).join('\n'))
  } catch {}
  return { above: lines.slice(0, dirs.length).map((l) => (l || null) as RepoDir | null), registry }
}

/** Starts `swamp workflow resume` so it outlives the worker; `onError` hears it fail to start or exit with an error. */
export function startResume(repo: Repo, workflow: string, runId: RunId, onError: (e: SwampFailure) => void): void {
  const args = ['workflow', 'resume', workflow, '--run', runId, '--json', '--no-color']
  if (repo.kind === 'ssh') {
    // The remote shell backgrounds resume with nohup, so resume outlives ssh.
    sshExec(repo.host, remoteCommand(repo.dir, args, 'detach'), READ_TIMEOUT_MS).catch(onError)
    return
  }
  // swamp's error goes to a file rather than a pipe, so resume can still write it once the worker is gone.
  // ponytail: a worker that stops mid-resume leaves this small file in the temp folder.
  const errorFile = join(mkdtempSync(join(tmpdir(), 'orca-swamp-resume-')), 'stderr')
  const fd = openSync(errorFile, 'w')
  const child = spawn(swampBin(), args, { cwd: repo.dir, detached: true, stdio: ['ignore', 'ignore', fd] })
  closeSync(fd)
  const done = () => rmSync(dirname(errorFile), { recursive: true, force: true })
  child.on('error', (e) => {
    done()
    onError(spawnFailure(e, repo.dir))
  })
  child.on('exit', (code) => {
    const stderr = readFileSync(errorFile, 'utf8')
    done()
    if (code !== 0) onError(exitFailure(Object.assign(new Error(`swamp was stopped by ${child.signalCode}`), { code: code ?? undefined }), '', stderr))
  })
  child.unref()
}

const studios = new Set<ChildProcess>()

/** Stops every `studio serve` this worker started, so the next worker can bind its port. */
export async function stopStudios(): Promise<void> {
  await Promise.all(
    [...studios].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once('exit', () => resolve())
          child.kill()
          setTimeout(resolve, 3000).unref()
        })
    )
  )
}

/** Starts `studio serve` in the repo and answers the URL it logs. It runs until the worker stops it or exits. */
export function startStudio(repo: RepoDir, model: string, onExit: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(swampBin(), ['model', 'method', 'run', model, 'serve', '--no-color'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    studios.add(child)
    let output = ''
    let found = false
    const timer = setTimeout(() => {
      child.kill()
      reject(new SwampFailure('timeout', `studio serve logged no URL in ${STUDIO_START_MS / 1000} s`))
    }, STUDIO_START_MS)
    const hear = (chunk: Buffer) => {
      // Once the URL is known, only the last 2000 characters are kept, for the last line when studio stops.
      output = found ? (output + chunk.toString()).slice(-2000) : output + chunk.toString()
      const url = found ? undefined : studioUrl(output)
      if (url) {
        found = true
        clearTimeout(timer)
        resolve(url)
      }
    }
    child.stdout.on('data', hear)
    child.stderr.on('data', hear)
    child.on('error', (e) => {
      studios.delete(child)
      clearTimeout(timer)
      reject(spawnFailure(e, repo))
    })
    child.on('exit', () => {
      studios.delete(child)
      clearTimeout(timer)
      onExit()
      reject(new SwampFailure('swamp_error', `studio serve stopped: ${output.trim().split('\n').at(-1) ?? ''}`))
    })
  })
}

export function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // pbcopy reads its input in the locale's encoding, so with no LANG it takes UTF-8 bytes as Mac Roman.
    const child = execFile('pbcopy', [], { env: { ...process.env, LANG: 'en_US.UTF-8' } }, (error) => (error ? reject(error) : resolve()))
    child.stdin?.end(text)
  })
}
