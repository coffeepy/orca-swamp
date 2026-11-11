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
 * For a focused workspace on a remote Orca server, Orca answers readContext with null (1.4.253) or with a
 * name it does not list (later versions). With null, nothing tells a plugin which workspace it is, so the
 * panel offers the repos of every remote workspace and remembers the pick under this one key.
 */
export const UNNAMED = '@remote-or-none'

type RemoteChoices = {
  candidates: RepoChoice[]
  hosts: SshHost[]
  /** Each remote workspace with the repo at or above its folder, to match a focused workspace Orca names but does not list. */
  workspaces?: { name: string; branch: string | null; repo: Repo | null }[]
  /** Hosts whose repos could not all be read just now; undefined when the servers could not be listed at all. */
  unread?: SshHost[]
  problem?: Resolution['problem']
}

async function remoteChoices(): Promise<RemoteChoices> {
  const { servers, workspaces, failures } = await remoteWorkspaces()
  const hosts = [...new Set(servers.flatMap((s) => (s.host ? [s.host] : [])))]
  const spaces: NonNullable<RemoteChoices['workspaces']> = []
  const probes = await Promise.all(
    hosts.map((h) => {
      const mine = workspaces.filter((w) => w.host === h)
      return probeRemote(h, mine.map((w) => w.path)).then(({ above, registry }) => {
        mine.forEach((w, i) => {
          const dir = above[i]
          spaces.push({ name: w.name, branch: w.branch, repo: dir ? { kind: 'ssh', host: h, dir } : null })
        })
        return remoteRepos(h, above, registry)
      }, (e: SwampFailure) => e)
    })
  )
  const failed = [...probes.filter((p): p is SwampFailure => p instanceof Error), ...failures.map((f) => f.error)][0]
  const sshless = servers.find((s) => !s.host)
  const problem = failed
    ? { code: failed.code ?? 'swamp_error', message: failed.message }
    : sshless && !hosts.length
      ? { code: 'host_unreachable' as const, message: `${sshless.server} is an Orca server paired without SSH, so the panel has no way to run swamp there.` }
      : undefined
  const unread = [...hosts.filter((_, i) => probes[i] instanceof Error), ...failures.flatMap((f) => (f.host ? [f.host] : []))]
  return { candidates: probes.flatMap((p) => (p instanceof Error ? [] : p)), hosts, unread, workspaces: spaces, ...(problem && { problem }) }
}

const askRemote = (): Promise<RemoteChoices> =>
  remoteChoices().catch((e: SwampFailure): RemoteChoices => ({ candidates: [], hosts: [], problem: { code: e.code ?? 'swamp_error', message: e.message } }))

/**
 * `read`, remembered: the first ask waits for it; later asks get the last answer at once, and an answer older than
 * `ms` is read again behind them. A `fresh` ask waits for a new read. A failure, or an answer `keep` turns down, is
 * not remembered.
 */
export function remembered<T>(ms: number, read: () => Promise<T>, keep: (value: T) => boolean = () => true): (fresh?: boolean) => Promise<T> {
  let last: { value: T; at: number } | undefined
  let reading: Promise<T> | undefined
  // ponytail: a fresh ask joins a read already under way instead of starting a second process.
  const again = (): Promise<T> =>
    (reading ??= read()
      .then(
        (value) => {
          last = keep(value) ? { value, at: Date.now() } : undefined
          return value
        },
        (e) => {
          last = undefined
          throw e
        }
      )
      .finally(() => (reading = undefined)))
  return (fresh = false) => {
    if (fresh || !last) return again()
    if (Date.now() - last.at > ms) again().catch(() => {})
    return Promise.resolve(last.value)
  }
}

/** The slow lookups behind a resolution. The worker remembers them between asks; `fresh` reads again. */
export type Lookups = {
  terminal: (handle: string, fresh?: boolean) => ReturnType<typeof terminalWorkspace>
  remote: (fresh?: boolean) => Promise<RemoteChoices>
}

const direct: Lookups = { terminal: terminalWorkspace, remote: askRemote }

const REMOTE_FRESH_MS = 60_000

export function rememberedLookups(): Lookups {
  // ponytail: one entry per terminal seen in the worker's life; a terminal never moves to another workspace.
  const terminals = new Map<string, Awaited<ReturnType<typeof terminalWorkspace>>>()
  return {
    terminal: async (handle, fresh) => {
      const known = fresh ? undefined : terminals.get(handle)
      if (known) return known
      const found = await terminalWorkspace(handle)
      if (found.id || found.folder) terminals.set(handle, found)
      return found
    },
    remote: remembered(REMOTE_FRESH_MS, askRemote, (r) => !r.problem)
  }
}

/**
 * An ssh pin is tried while its host cannot be asked, so a host that is down for a minute keeps it;
 * once the host answers without it, or is no longer paired, it is not.
 */
function sshPin(pinned: Repo | undefined, remote: RemoteChoices, candidates: RepoChoice[]): Repo | null {
  if (pinned?.kind !== 'ssh') return null
  const unread = !remote.unread || remote.unread.includes(pinned.host)
  return candidates.find((c) => repoKey(c.repo) === repoKey(pinned))?.repo ?? (unread ? pinned : null)
}

const shortBranch = (b: string | null | undefined) => (b ?? '').replace(/^refs\/heads\//, '')

/**
 * The focused workspace: its Orca id and folder when one of its terminals names them, or when one listed workspace
 * has its name and branch; `named` is those listed workspaces.
 */
async function focus(orca: OrcaWorkerApi, look: Lookups, fresh?: boolean) {
  const [context, list] = await Promise.all([orca.host.call('workspace.readContext'), orca.host.call('workspace.list')])
  if (!context) return { context, list, named: [], folder: null, id: null }
  const named = list.workspaces.filter((w) => w.name === context.displayName && (w.branch === null || shortBranch(w.branch) === shortBranch(context.branch)))
  const handle = context.terminals[0]?.id
  const fromTerminal = handle ? await look.terminal(handle, fresh).catch(() => null) : null
  const only = named.length === 1 ? named[0] : undefined
  const folder = canonical(fromTerminal?.folder ?? only?.path ?? '')
  return { context, list, named, folder, id: fromTerminal?.id ?? only?.id ?? null }
}

/**
 * Where a pick for the focused workspace is saved: its Orca id, so a pick stays with that one workspace even
 * when another shares its folder; its folder when Orca gives no id; its name when Orca does not list it;
 * UNNAMED when Orca names none; null when several workspaces share its name and nothing tells them apart.
 */
export async function focusPinKey(orca: OrcaWorkerApi, look: Lookups = direct): Promise<string | null> {
  const { context, named, folder, id } = await focus(orca, look)
  return !context ? UNNAMED : (id ?? folder ?? (named.length > 1 ? null : context.displayName))
}

/**
 * `registry` may still be on its way: swamp's registry is read while Orca and the remote hosts are asked, and waited for only where local repos are picked.
 * `picked` is a repo the person chose that could not be saved, used for this answer only.
 */
export async function resolveRepo(
  orca: OrcaWorkerApi,
  registry: SwampWorkspace[] | Promise<SwampWorkspace[]>,
  pins: Pins,
  { picked, look = direct, fresh }: { picked?: Repo; look?: Lookups; fresh?: boolean } = {}
): Promise<Resolution> {
  const { context, list, named, folder, id } = await focus(orca, look, fresh)
  // Orca names a workspace on a remote Orca server but does not list it, and its terminals name no folder.
  if (context && !folder && named.length === 0) {
    const pinned = picked ?? pins[context.displayName]
    const remote = await look.remote(fresh)
    // With a remote host paired, this workspace is on one, so only remote repos may answer it and this Mac's
    // are not offered. With none, local repos are offered instead.
    const local = remote.hosts.length ? undefined : pickRepo([], list.workspaces.map((w) => w.path), await registry, pinned)
    const candidates = local?.candidates ?? remote.candidates
    // With one remote workspace of this name and branch, the repo at or above its folder is this workspace's.
    const same = (remote.workspaces ?? []).filter((w) => w.name === context.displayName && shortBranch(w.branch) === shortBranch(context.branch))
    const repo = local?.repo ?? sshPin(pinned, remote, candidates) ?? (same.length === 1 ? same[0].repo : null)
    return { repo, candidates, workspace: { name: context.displayName, listed: false }, remoteHosts: remote.hosts, ...(remote.problem && { problem: remote.problem }) }
  }
  if (context) {
    const focused = folder ? [folder] : []
    const others = list.workspaces.map((w) => w.path).filter((p) => canonical(p) !== folder)
    // Pins older versions saved under the folder or the name hold only while no other listed workspace shares it.
    const ownFolder = folder && list.workspaces.filter((w) => canonical(w.path) === folder).length <= 1 ? pins[folder] : undefined
    const pinned = picked ?? (id ? pins[id] : undefined) ?? ownFolder ?? (named.length <= 1 ? pins[context.displayName] : undefined)
    const sharedName = !folder && named.length > 1 ? named.length : undefined
    const workspace = { name: context.displayName, listed: !!folder || named.length > 0, ...(sharedName && { sharedName }) }
    return { ...pickRepo(focused, others, await registry, pinned), workspace }
  }
  const others = list.workspaces.map((w) => w.path)
  const pinned = pins[UNNAMED]
  const remote = await look.remote(fresh)
  // No workspace from Orca means a remote one is focused, so only remote repos may answer it; a local
  // pick here would stick to every remote workspace. With no remote hosts, local repos are offered instead.
  const local = remote.hosts.length ? undefined : pickRepo([], others, await registry, pinned)
  const candidates = local?.candidates ?? remote.candidates
  const repo = local?.repo ?? sshPin(pinned, remote, candidates)
  return { repo, candidates, remoteHosts: remote.hosts, ...(remote.problem && { problem: remote.problem }) }
}
