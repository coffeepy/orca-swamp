// Which swamp repo does the focused Orca workspace mean? Found the way swamp finds one: the
// .swamp.yaml at or above a folder, plus the repos swamp's own workspace registry tracks.
// readContext has no path, but its terminal ids are the handles `orca terminal show` answers with the workspace's
// folder. A workspace with no terminal is matched by name and branch, and several matches are left to the person.
// A workspace on a remote Orca server is not in workspace.list; it is found through the orca CLI and probed over SSH.
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { repoKey, sshHostOf, SwampFailure, type FailureCode, type Repo, type RepoDir, type SshFault, type SshHost } from './domain'
import { remoteWorkspaces, terminalWorkspace } from './remote'
import { probeRemote } from './swamp'

export type RepoChoice = { repo: Repo; label: string }
/** A server Orca reaches with a pairing code: Orca names it and gives no SSH host. `address` is where Orca connects to it, offered as the SSH login to try. */
export type CodeServer = { name: string; address?: SshHost }
/** Why remote repos could not be read. `server` is the Orca server that did not answer; `ssh` is set when ssh itself failed. */
export type Problem = { code: FailureCode; message: string; server?: string; ssh?: SshFault }
export type Resolution = {
  repo: Repo | null
  candidates: RepoChoice[]
  /**
   * The focused workspace; `listed` is false when Orca names it but does not list it. `sharedName` counts the
   * listed workspaces with its name and branch when it has no terminal to tell which of them it is.
   */
  workspace?: { name: string; listed: boolean; sharedName?: number }
  /** For a workspace Orca does not list (it is on a remote Orca server, or the focus is nowhere): the hosts whose repos are offered. */
  remoteHosts?: SshHost[]
  /** The SSH logins the person added, which the gear menu lists. */
  logins?: SshHost[]
  sshless?: CodeServer[]
  /** The user name ssh logs in with when a login names none: this Mac's. */
  sshUser?: string
  problem?: Problem
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
      const host = sshHostOf(v?.host)
      return v?.kind === 'ssh' && typeof v.dir === 'string' && v.dir.startsWith('/') && host ? [[k, { kind: 'ssh', host, dir: v.dir }]] : []
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

export type RemoteChoices = {
  candidates: RepoChoice[]
  hosts: SshHost[]
  /** Each remote workspace with the repo at or above its folder, to match a focused workspace Orca names but does not list. */
  workspaces?: { name: string; branch: string | null; repo: Repo | null }[]
  /** Hosts whose repos could not all be read just now; undefined when the servers could not be listed at all. */
  unread?: SshHost[]
  /** Whether any remote server is paired; undefined when the servers could not be listed at all. */
  paired?: boolean
  sshless?: CodeServer[]
  problem?: Problem
}

const problemOf = (e: SwampFailure, server?: string): Problem => ({ code: e.code ?? 'swamp_error', message: e.message, ...(server && { server }), ...(e.ssh && { ssh: e.ssh }) })

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
  const down = probes.find((p): p is SwampFailure => p instanceof Error)
  const problem = down ? problemOf(down) : failures[0] && problemOf(failures[0].error, failures[0].server)
  const unread = [...hosts.filter((_, i) => probes[i] instanceof Error), ...failures.flatMap((f) => (f.host ? [f.host] : []))]
  const sshless = servers.flatMap((s): CodeServer[] => (s.code ? [{ name: s.server, ...s.code }] : []))
  return { candidates: probes.flatMap((p) => (p instanceof Error ? [] : p)), hosts, unread, workspaces: spaces, paired: servers.length > 0, sshless, ...(problem && { problem }) }
}

/** What a host asked directly offers: the repos of its swamp registry, and with a folder the repo at or above it, as `at`. */
export type HostRepos = { choices: RepoChoice[]; at: Repo | null }

const askHost = (host: SshHost, dir?: string): Promise<HostRepos | SwampFailure> =>
  probeRemote(host, dir ? [dir] : []).then(
    ({ above, registry }): HostRepos => ({ choices: remoteRepos(host, above, registry), at: above[0] ? { kind: 'ssh', host, dir: above[0] } : null }),
    (e: SwampFailure) => e
  )

const askRemote = (): Promise<RemoteChoices> => remoteChoices().catch((e: SwampFailure): RemoteChoices => ({ candidates: [], hosts: [], problem: problemOf(e) }))

/** Orca's server list could not be read, though its CLI is there: whether a remote server is paired is not known. */
export const serversUnread = (remote: RemoteChoices): boolean => remote.paired === undefined && remote.problem?.code !== 'orca_cli_missing'

// An answer that carries a problem is answered again for this long, so a workspace switch does not wait on a server that is off.
const PROBLEM_MS = 10_000

/**
 * `read`, remembered: the first ask waits for it; later asks get the last answer at once, and an answer older than
 * `ms` is read again behind them. A `fresh` ask waits for a new read. A failure is not remembered, and an answer
 * `briefly` names is dropped after PROBLEM_MS.
 */
export function remembered<T>(ms: number, read: () => Promise<T>, briefly: (value: T) => boolean = () => false, now: () => number = Date.now): (fresh?: boolean) => Promise<T> {
  let last: { value: T; at: number; brief: boolean } | undefined
  let reading: Promise<T> | undefined
  // ponytail: a fresh ask joins a read already under way instead of starting a second process.
  const again = (): Promise<T> =>
    (reading ??= read()
      .then(
        (value) => {
          last = { value, at: now(), brief: briefly(value) }
          return value
        },
        (e) => {
          last = undefined
          throw e
        }
      )
      .finally(() => (reading = undefined)))
  return (fresh = false) => {
    const age = last ? now() - last.at : 0
    if (fresh || !last || (last.brief && age > PROBLEM_MS)) return again()
    if (age > ms) again().catch(() => {})
    return Promise.resolve(last.value)
  }
}

/** The slow lookups behind a resolution. The worker remembers them between asks; `fresh` reads again. */
export type Lookups = {
  terminal: (handle: string, fresh?: boolean) => ReturnType<typeof terminalWorkspace>
  remote: (fresh?: boolean) => Promise<RemoteChoices>
  /** One host asked directly, with the folder to look at or above. A host that fails answers the failure. */
  host: (host: SshHost, dir?: string, fresh?: boolean) => Promise<HostRepos | SwampFailure>
  /** Drops what is remembered of a host. */
  forget: (host: SshHost) => void
}

const direct: Lookups = { terminal: terminalWorkspace, remote: askRemote, host: askHost, forget: () => {} }

const REMOTE_FRESH_MS = 60_000

export function rememberedLookups(): Lookups {
  // ponytail: one entry per terminal seen in the worker's life; a terminal never moves to another workspace.
  const terminals = new Map<string, Awaited<ReturnType<typeof terminalWorkspace>>>()
  // ponytail: per host, one answer per folder asked in the last minute; two asks at once both run ssh.
  const hosts = new Map<SshHost, { dir: string | undefined; at: number; answer: HostRepos | SwampFailure }[]>()
  return {
    terminal: async (handle, fresh) => {
      const known = fresh ? undefined : terminals.get(handle)
      if (known) return known
      const found = await terminalWorkspace(handle)
      if (found.id || found.folder) terminals.set(handle, found)
      return found
    },
    remote: remembered(REMOTE_FRESH_MS, askRemote, (r) => !!r.problem),
    host: async (host, dir, fresh) => {
      const kept = fresh ? [] : (hosts.get(host) ?? []).filter((e) => Date.now() - e.at < REMOTE_FRESH_MS)
      // A host that failed is down for every folder, and an answer that lists the folder's repo already is the answer.
      for (const { answer, dir: asked } of kept) {
        if (answer instanceof Error || dir === undefined || asked === dir) return answer
        const at = answer.choices.find((c) => c.repo.dir === dir)?.repo
        if (at) return { ...answer, at }
      }
      const answer = await askHost(host, dir)
      const entry = { dir, at: Date.now(), answer }
      hosts.set(host, answer instanceof Error ? [entry] : [entry, ...kept])
      return answer
    },
    forget: (host) => void hosts.delete(host)
  }
}

/**
 * Whether an ssh pin holds. A host asked directly (an added login, or the pin's own host) decides by its answer: the
 * pin holds when the host offers that repo, and for an added login also while it does not answer, so a server down
 * for a minute keeps the setup. Any other host holds the pin while it cannot be asked.
 */
function sshPin(pinned: Repo | undefined, remote: RemoteChoices, asked: Map<SshHost, HostRepos | SwampFailure>, added: SshHost[]): Repo | null {
  if (pinned?.kind !== 'ssh') return null
  const answer = asked.get(pinned.host)
  if (answer instanceof Error) return added.includes(pinned.host) ? pinned : null
  const offered = [...remote.candidates, ...(answer?.choices ?? [])].find((c) => repoKey(c.repo) === repoKey(pinned))?.repo
  return offered ?? (!answer && (!remote.unread || remote.unread.includes(pinned.host)) ? pinned : null)
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
 * `unlisted` is a workspace Orca does not list, the only kind a remote repo can belong to.
 */
export async function focusPinKey(orca: OrcaWorkerApi, look: Lookups = direct): Promise<{ key: string | null; unlisted: boolean }> {
  const { context, named, folder, id } = await focus(orca, look)
  if (!context) return { key: UNNAMED, unlisted: true }
  return { key: id ?? folder ?? (named.length > 1 ? null : context.displayName), unlisted: !folder && named.length === 0 }
}

/**
 * `registry` may still be on its way: swamp's registry is read while Orca and the remote hosts are asked, and waited for only where local repos are picked.
 * `picked` is a repo the person chose that could not be saved, used for this answer only. `added` are the SSH logins
 * the person added.
 */
export async function resolveRepo(
  orca: OrcaWorkerApi,
  registry: SwampWorkspace[] | Promise<SwampWorkspace[]>,
  pins: Pins,
  { picked, look = direct, fresh, added = [] }: { picked?: Repo; look?: Lookups; fresh?: boolean; added?: SshHost[] } = {}
): Promise<Resolution> {
  const { context, list, named, folder, id } = await focus(orca, look, fresh)
  // The answer for a workspace Orca does not list: it is on a remote server, or nothing is focused.
  const unlisted = async (pinned: Repo | undefined, own: (remote: RemoteChoices) => Repo | null = () => null): Promise<Resolution> => {
    const pinHost = pinned?.kind === 'ssh' ? pinned.host : undefined
    const ask = (h: SshHost) => look.host(h, h === pinHost ? pinned!.dir : undefined, fresh)
    const [remote, answers] = await Promise.all([look.remote(fresh), Promise.all(added.map(ask))])
    const asked = new Map(added.map((h, i) => [h, answers[i]]))
    // A host only a pin names is asked while a server is paired without SSH: that pin may be how the person reaches it.
    // Otherwise it is a server since retired, and asking it would hold every switch for ssh's timeout.
    if (pinHost && !asked.has(pinHost) && !remote.hosts.includes(pinHost) && remote.sshless?.length) asked.set(pinHost, await ask(pinHost))
    const extra = [...asked].filter(([h]) => !remote.hosts.includes(h))
    const hosts = [...remote.hosts, ...extra.flatMap(([h, a]) => (added.includes(h) || !(a instanceof Error) ? [h] : []))]
    const down = extra.find((x): x is [SshHost, SwampFailure] => x[1] instanceof Error && added.includes(x[0]))?.[1]
    const problem = down ? problemOf(down) : remote.problem
    // This Mac's repos are offered as 0.5.0 offered them: when no remote host can be asked. Two cases differ. With a
    // server paired without SSH the workspace is on it, so none are. While Orca's server list cannot be read, they
    // are offered but a pick of one is not used: under the unnamed key it would stick to every remote workspace.
    const others = list.workspaces.map((w) => w.path)
    const local = hosts.length || remote.sshless?.length ? undefined : pickRepo([], others, await registry, serversUnread(remote) ? undefined : pinned)
    return {
      repo: local?.repo ?? sshPin(pinned, remote, asked, added) ?? own(remote),
      candidates: [...(local?.candidates ?? []), ...remote.candidates, ...extra.flatMap(([, a]) => (a instanceof Error ? [] : a.choices))],
      remoteHosts: hosts,
      ...(remote.sshless?.length && { sshless: remote.sshless }),
      ...(problem && { problem })
    }
  }
  // Orca names a workspace on a remote Orca server but does not list it, and its terminals name no folder.
  if (context && !folder && named.length === 0) {
    // With one remote workspace of this name and branch, the repo at or above its folder is this workspace's.
    const answer = await unlisted(picked ?? pins[context.displayName], (remote) => {
      const same = (remote.workspaces ?? []).filter((w) => w.name === context.displayName && shortBranch(w.branch) === shortBranch(context.branch))
      return same.length === 1 ? same[0].repo : null
    })
    return { ...answer, workspace: { name: context.displayName, listed: false } }
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
  // No workspace from Orca means a remote one is focused, or none.
  return unlisted(picked ?? pins[UNNAMED])
}
