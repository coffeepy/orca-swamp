// Which swamp repo does the focused Orca workspace mean? Found the way swamp finds one: the
// .swamp.yaml at or above a folder, plus the repos swamp's own workspace registry tracks.
// readContext has no path, but its terminal ids are the handles `orca terminal show` answers with the workspace's
// folder. A workspace with no terminal is matched by name and branch, and several matches are left to the person.
// A workspace on a remote Orca server is not in workspace.list; it is found through the orca CLI and probed over SSH.
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { repoKey, SwampFailure, type FailureCode, type Repo, type RepoDir, type SshHost } from './domain'
import { remoteWorkspaces, terminalWorkspace } from './remote'
import { probeRemote } from './swamp'

export type RepoChoice = { repo: Repo; label: string }
export type Resolution = {
  repo: Repo | null
  candidates: RepoChoice[]
  /**
   * The focused workspace; `listed` is false when Orca names it but does not list it. `sharedName` counts the
   * listed workspaces with its name and branch when it has no terminal to tell which of them it is.
   */
  workspace?: { name: string; listed: boolean; sharedName?: number }
  /** With no workspace named (the focus is on a remote Orca server, or nowhere): the hosts whose repos are offered. */
  remoteHosts?: SshHost[]
  /** Why remote repos could not be read, for the panel to say. */
  problem?: { code: FailureCode; message: string }
}
export type SwampWorkspace = { name: string; path: string; folder?: string }
export type Pins = Record<string, Repo>

function isRepo(dir: string): dir is RepoDir {
  return existsSync(join(dir, '.swamp.yaml'))
}

export function repoAbove(dir: string): RepoDir | null {
  for (let d = dir; ; d = dirname(d)) {
    if (isRepo(d)) return d
    if (dirname(d) === d) return null
  }
}

/** An absolute folder with no trailing slash or `..`, or null for a relative one, which would resolve against the worker's folder. */
const canonical = (dir: string): string | null => (isAbsolute(dir) ? resolve(dir) : null)

const within = (path: string, dir: string, s = sep) => path === dir || path.startsWith(dir.endsWith(s) ? dir : dir + s)

export function parseWorkspaces(raw: unknown): SwampWorkspace[] {
  const list = (raw as { workspaces?: unknown } | null)?.workspaces
  if (!Array.isArray(list)) return []
  return list.flatMap((w) =>
    typeof w?.name === 'string' && typeof w?.path === 'string'
      ? [{ name: w.name, path: w.path, ...(typeof w.folder === 'string' && { folder: w.folder }) }]
      : []
  )
}

/** Pins as the pins file holds them: a bare path is a local repo, as older versions wrote. */
export function parsePins(raw: unknown): Pins {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw).flatMap(([k, v]): [string, Repo][] => {
      if (typeof v === 'string' && isAbsolute(v)) return [[k, { kind: 'local', dir: v as RepoDir }]]
      if (v?.kind === 'local' && typeof v.dir === 'string' && isAbsolute(v.dir)) return [[k, { kind: 'local', dir: v.dir }]]
      if (v?.kind === 'ssh' && typeof v.dir === 'string' && v.dir.startsWith('/') && typeof v.host === 'string' && v.host && !v.host.startsWith('-')) {
        return [[k, { kind: 'ssh', host: v.host, dir: v.dir }]]
      }
      return []
    })
  )
}


/** The repo when exactly one belongs to the workspace or one is pinned, and every repo the picker offers. */
function choose(matched: Repo[], all: Repo[], names: Map<string, string>, pinned?: Repo): Pick<Resolution, 'repo' | 'candidates'> {
  const unique = (list: Repo[]) => [...new Map(list.map((r) => [repoKey(r), r])).values()]
  const mine = unique(matched)
  const offered = unique([...mine, ...all])
  if (pinned && !offered.some((r) => repoKey(r) === repoKey(pinned))) offered.unshift(pinned)
  const label = (r: Repo) => `${names.get(repoKey(r)) ?? posix.basename(r.dir)} · ${posix.basename(posix.dirname(r.dir))}`
  return { repo: pinned ?? (mine.length === 1 ? mine[0] : null), candidates: offered.map((repo) => ({ repo, label: label(repo) })) }
}

export function pickRepo(focused: string[], others: string[], registered: SwampWorkspace[], pinned?: Repo): Pick<Resolution, 'repo' | 'candidates'> {
  const tracked = registered.flatMap((w) => {
    const path = canonical(w.path)
    return path && isRepo(path) ? [{ ...w, path }] : []
  })
  const local = (dir: string): Repo => ({ kind: 'local', dir: dir as RepoDir })
  const found = (path: string): Repo[] => {
    const dir = canonical(path)
    if (!dir) return []
    const above = repoAbove(dir)
    return [...(above ? [above] : []), ...tracked.filter((w) => within(w.path, dir)).map((w) => w.path)].map(local)
  }
  const pinnedDir = pinned?.kind === 'local' ? canonical(pinned.dir) : null
  const valid = pinnedDir && isRepo(pinnedDir) ? local(pinnedDir) : undefined
  const names = new Map(tracked.map((w) => [w.path, w.name]))
  return choose(focused.flatMap(found), [...others.flatMap(found), ...tracked.map((w) => local(w.path))], names, valid)
}

/** The repos swamp would find on a remote host: one at or above each workspace folder, and its registry's. */
export function remoteRepos(host: SshHost, above: (string | null)[], registry: unknown): RepoChoice[] {
  const tracked = parseWorkspaces(registry).filter((w) => w.folder === undefined || w.folder === 'ok')
  const at = (dir: string): Repo => ({ kind: 'ssh', host, dir: dir as RepoDir })
  const names = new Map(tracked.map((w) => [repoKey(at(w.path)), w.name]))
  return choose([], [...above.flatMap((d) => (d ? [at(d)] : [])), ...tracked.map((w) => at(w.path))], names).candidates
}

/**
 * Orca answers readContext with null when the focused workspace is on a remote Orca server (1.4.253 resolves
 * the focus against this machine's runtime only), and nothing else tells a plugin which one it is. So the
 * panel offers the repos of every remote workspace and remembers the pick under this one key.
 */
export const UNNAMED = '@remote-or-none'

type RemoteChoices = {
  candidates: RepoChoice[]
  hosts: SshHost[]
  /** Hosts whose repos could not all be read just now; undefined when the servers could not be listed at all. */
  unread?: SshHost[]
  problem?: Resolution['problem']
}

async function remoteChoices(): Promise<RemoteChoices> {
  const { servers, workspaces, failures } = await remoteWorkspaces()
  const hosts = [...new Set(servers.flatMap((s) => (s.host ? [s.host] : [])))]
  const probes = await Promise.all(
    hosts.map((h) =>
      probeRemote(h, workspaces.filter((w) => w.host === h).map((w) => w.path)).then(({ above, registry }) => remoteRepos(h, above, registry), (e: SwampFailure) => e)
    )
  )
  const failed = [...probes.filter((p): p is SwampFailure => p instanceof Error), ...failures.map((f) => f.error)][0]
  const sshless = servers.find((s) => !s.host)
  const problem = failed
    ? { code: failed.code ?? 'swamp_error', message: failed.message }
    : sshless && !hosts.length
      ? { code: 'host_unreachable' as const, message: `${sshless.server} is an Orca server paired without SSH, so the panel has no way to run swamp there.` }
      : undefined
  const unread = [...hosts.filter((_, i) => probes[i] instanceof Error), ...failures.flatMap((f) => (f.host ? [f.host] : []))]
  return { candidates: probes.flatMap((p) => (p instanceof Error ? [] : p)), hosts, unread, ...(problem && { problem }) }
}

const shortBranch = (b: string | null | undefined) => (b ?? '').replace(/^refs\/heads\//, '')

/**
 * The focused workspace: its Orca id and folder when one of its terminals names them, or when one listed workspace
 * has its name and branch; `named` is those listed workspaces.
 */
async function focus(orca: OrcaWorkerApi) {
  const [context, list] = await Promise.all([orca.host.call('workspace.readContext'), orca.host.call('workspace.list')])
  if (!context) return { context, list, named: [], folder: null, id: null }
  const named = list.workspaces.filter((w) => w.name === context.displayName && (w.branch === null || shortBranch(w.branch) === shortBranch(context.branch)))
  const handle = context.terminals[0]?.id
  const fromTerminal = handle ? await terminalWorkspace(handle).catch(() => null) : null
  const only = named.length === 1 ? named[0] : undefined
  const folder = canonical(fromTerminal?.folder ?? only?.path ?? '')
  return { context, list, named, folder, id: fromTerminal?.id ?? only?.id ?? null }
}

/**
 * Where a pick for the focused workspace is saved: its Orca id, so a pick stays with that one workspace even
 * when another shares its folder; its folder when Orca gives no id; its name when Orca does not list it;
 * UNNAMED when Orca names none; null when several workspaces share its name and nothing tells them apart.
 */
export async function focusPinKey(orca: OrcaWorkerApi): Promise<string | null> {
  const { context, named, folder, id } = await focus(orca)
  return !context ? UNNAMED : (id ?? folder ?? (named.length > 1 ? null : context.displayName))
}

/** `picked` is a repo the person chose that could not be saved, used for this answer only. */
export async function resolveRepo(orca: OrcaWorkerApi, registered: SwampWorkspace[], pins: Pins, picked?: Repo): Promise<Resolution> {
  const { context, list, named, folder, id } = await focus(orca)
  if (context) {
    const focused = folder ? [folder] : []
    const others = list.workspaces.map((w) => w.path).filter((p) => canonical(p) !== folder)
    // Pins older versions saved under the folder or the name hold only while no other listed workspace shares it.
    const ownFolder = folder && list.workspaces.filter((w) => canonical(w.path) === folder).length <= 1 ? pins[folder] : undefined
    const pinned = picked ?? (id ? pins[id] : undefined) ?? ownFolder ?? (named.length <= 1 ? pins[context.displayName] : undefined)
    const sharedName = !folder && named.length > 1 ? named.length : undefined
    const workspace = { name: context.displayName, listed: !!folder || named.length > 0, ...(sharedName && { sharedName }) }
    return { ...pickRepo(focused, others, registered, pinned), workspace }
  }
  const others = list.workspaces.map((w) => w.path)
  const pinned = pins[UNNAMED]
  const remote = await remoteChoices().catch((e: SwampFailure): RemoteChoices => ({ candidates: [], hosts: [], problem: { code: e.code ?? 'swamp_error', message: e.message } }))
  // No workspace from Orca means a remote one is focused, so only remote repos may answer it; a local
  // pick here would stick to every remote workspace. With no remote hosts, local repos are offered instead.
  const local = remote.hosts.length ? undefined : pickRepo([], others, registered, pinned)
  const candidates = local?.candidates ?? remote.candidates
  // An ssh pin is tried while its host cannot be asked, so a host that is down for a minute keeps it;
  // once the host answers without it, or is no longer paired, it is not.
  const ssh = pinned?.kind === 'ssh' ? pinned : undefined
  const unread = (h: SshHost) => !remote.unread || remote.unread.includes(h)
  const repo = local?.repo ?? (ssh && (candidates.find((c) => repoKey(c.repo) === repoKey(ssh))?.repo ?? (unread(ssh.host) ? ssh : null))) ?? null
  return { repo, candidates, remoteHosts: remote.hosts, ...(remote.problem && { problem: remote.problem }) }
}
