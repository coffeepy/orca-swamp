// Workspaces on remote Orca servers, which `workspace.list` does not give plugins. The `orca` CLI
// lists them per server, and names the SSH target Orca deployed each server through.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { addressOf, SwampFailure, sshHostOf, type SshHost } from './domain'

export type RemoteWorkspace = {
  name: string
  branch: string | null
  path: string
  /** The Orca server it lives on. */
  server: string
  /** How ssh reaches that server, or null when it was paired without SSH. */
  host: SshHost | null
}

type Json = Record<string, unknown>
const rows = (raw: unknown, key: string): Json[] => {
  const list = ((raw as { result?: Json } | null)?.result ?? {})[key]
  return Array.isArray(list) ? list.filter((x): x is Json => !!x && typeof x === 'object') : []
}
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/**
 * A saved Orca server. `host` is the SSH host Orca deployed it through. A server paired with a code has none, and
 * carries `code`, with the address Orca connects to when ssh could try it. `unusable` is an SSH host of Orca's whose
 * name is not one the panel hands to ssh.
 */
export type Server = { server: string; host: SshHost | null; code?: { address?: SshHost }; unusable?: string }

export function parseServers(environments: unknown, hosts: unknown): Server[] {
  const sshName = new Map(rows(hosts, 'hosts').flatMap((h): [string, string][] => (h.kind === 'ssh' && str(h.id) && str(h.name) ? [[h.id as string, h.name as string]] : [])))
  return rows(environments, 'environments').flatMap((e): Server[] => {
    const server = str(e.name)
    if (!server) return []
    const target = str((e.orcadDeployment as Json | undefined)?.sshTargetId)
    if (!target) {
      const address = (Array.isArray(e.endpoints) ? e.endpoints : []).flatMap((p: Json | null) => addressOf(p?.endpoint) ?? [])[0]
      return [{ server, host: null, code: { ...(address && { address }) } }]
    }
    const name = sshName.get(target)
    const host = sshHostOf(name)
    return [{ server, host, ...(name && !host && { unusable: name }) }]
  })
}

/** One server's workspaces from `orca worktree list --environment <server> --json`. */
export function parseServerWorkspaces(worktrees: unknown, server: string, host: SshHost | null): RemoteWorkspace[] {
  return rows(worktrees, 'worktrees').flatMap((w) => {
    const name = str(w.displayName)
    const path = str(w.path)
    // ponytail: rows the server reaches through its own SSH targets are skipped; this Mac cannot reach them.
    // A path that is not absolute on a POSIX host (relative, or C:\...) would never reach / in the probe's walk up.
    if (!name || !path?.startsWith('/') || (w.hostId ?? 'local') !== 'local') return []
    return [{ name, branch: str(w.branch), path: posix.normalize(path).replace(/(.)\/$/, '$1'), server, host }]
  })
}

// Orca sets ORCA_CLI_COMMAND where plain `orca` is wrong; otherwise the CLI Orca ships next to the running
// app, then PATH. On Linux `orca` on PATH is usually the GNOME screen reader, so there it is `orca-ide`.
const resources = (process as { resourcesPath?: string }).resourcesPath
const bundled = resources ? join(resources, 'bin', 'orca') : ''
const orcaPath = (): string =>
  process.env.ORCA_CLI_COMMAND ?? (bundled && existsSync(bundled) ? bundled : process.platform === 'linux' ? 'orca-ide' : 'orca')

function orcaCli(args: string[]): Promise<unknown> {
  const cli = orcaPath()
  return new Promise((resolve, reject) => {
    execFile(cli, [...args, '--json'], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error?.killed) return reject(new SwampFailure('timeout', `orca ${args.join(' ')} took longer than 15 s`))
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        return reject(new SwampFailure('orca_cli_missing', `The orca command was not found (looked for ${cli}), so the panel cannot see workspaces on remote Orca servers.`))
      }
      try {
        const answer = JSON.parse(stdout) as { ok?: boolean; error?: { message?: string } }
        if (answer.ok === false) return reject(new SwampFailure('swamp_error', `orca ${args.join(' ')}: ${answer.error?.message ?? 'failed'}`))
        resolve(answer)
      } catch {
        reject(new SwampFailure('swamp_error', `orca ${args.join(' ')} failed: ${error?.message ?? 'its output is not JSON'}`))
      }
    })
  })
}

/** Every saved remote Orca server, every workspace on those that answer, and why the others did not. */
export async function remoteWorkspaces(): Promise<{ servers: Server[]; workspaces: RemoteWorkspace[]; failures: (Server & { error: SwampFailure })[] }> {
  const [environments, hosts] = await Promise.all([orcaCli(['environment', 'list']), orcaCli(['host', 'list'])])
  const servers = parseServers(environments, hosts)
  const failures: (Server & { error: SwampFailure })[] = servers.flatMap((s) =>
    s.unusable === undefined ? [] : [{ ...s, error: new SwampFailure('swamp_error', `Orca reaches the server ${s.server} through an SSH host named '${s.unusable}', which Swampling cannot use: an SSH name may hold letters, digits and . _ - @ : % + only.`) }]
  )
  const lists = await Promise.all(
    servers.map((s) =>
      orcaCli(['worktree', 'list', '--environment', s.server]).then(
        (w) => parseServerWorkspaces(w, s.server, s.host),
        (e: SwampFailure) => {
          failures.push({ ...s, error: new SwampFailure('server_unreachable', `Could not list the workspaces on Orca server ${s.server}: ${e.message}`) })
          return []
        }
      )
    )
  )
  return { servers, workspaces: lists.flat(), failures }
}

/**
 * The workspace a terminal belongs to, by its Orca id and folder: readContext's terminal ids are the handles the CLI
 * knows. Several workspaces can share a folder (a home folder opened as two workspaces), but never an id.
 */
export async function terminalWorkspace(handle: string): Promise<{ id: string | null; folder: string | null }> {
  const answer = await orcaCli(['terminal', 'show', '--terminal', handle])
  const terminal = (answer as { result?: { terminal?: Json } } | null)?.result?.terminal
  return { id: str(terminal?.worktreeId), folder: str(terminal?.worktreePath) }
}
