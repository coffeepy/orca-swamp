// What waits for a person in every repo the worker knows: workflow approval gates and StageCraft tickets held for a person.
import { posix } from 'node:path'
import { parseApprovals, plain, repoKey, type Gate, type Repo } from './domain'
import { repoTitle } from './present'
import { pickRepo, repoAbove, type Pins, type SwampWorkspace } from './repo'
import { waitingItems } from './stagecraft'

/** `gates` are the ids of the human-approval gates a ticket waits on. */
export type InboxItem = { repo: Repo; repoLabel: string; since?: string } & (
  | { kind: 'gate'; gate: Gate }
  | { kind: 'ticket'; factory: string; key: string; title: string; stage: string; gates: string[] }
)
/** `repos` counts every repo asked, the ones in `failed` too. */
export type Inbox = { items: InboxItem[]; failed: { repoLabel: string; message: string }[]; repos: number }
export type InboxRepo = { repo: Repo; label: string }

/**
 * Every repo the inbox reads, once each: the repo at or above each Orca workspace folder on this Mac, the repos in
 * swamp's registry, each pinned repo, and the repos the panel showed. Pins are how the remote ones are known.
 */
export function inboxRepos(folders: string[], registry: SwampWorkspace[], pins: Pins, shown: Repo[] = []): InboxRepo[] {
  const local = pickRepo([], folders, registry).candidates
  // A pin to a local folder that is no longer a repo is left out. A remote one is asked, and its line says why it failed.
  const others = [...Object.values(pins), ...shown]
    .filter((r) => r.kind === 'ssh' || repoAbove(r.dir) === r.dir)
    .map((repo) => ({ repo, label: posix.basename(repo.dir) }))
  // The local ones come last, so the name swamp's registry gives a repo wins over its folder name.
  return [...new Map([...others, ...local].map((c) => [repoKey(c.repo), { repo: c.repo, label: repoTitle(c) }])).values()]
}

/** What waits in one repo, from `swamp workflow approvals` and the run records of its StageCraft work items. */
export function parseInbox({ repo, label }: InboxRepo, approvals: unknown, runs: unknown, now: string): InboxItem[] {
  const at = { repo, repoLabel: label }
  return plain([
    ...parseApprovals(approvals).map((gate): InboxItem => ({ ...at, since: gate.since, kind: 'gate', gate })),
    ...waitingItems(runs, now).map((w): InboxItem => {
      const gates = [...new Set((w.waiting?.exits ?? []).flatMap((x) => x.gateIds))]
      return { ...at, since: w.waiting?.since, kind: 'ticket', factory: w.factory, key: w.key, title: w.title, stage: w.stage, gates }
    })
  ])
}

const waitStart = (i: InboxItem): number => {
  const t = Date.parse(i.since ?? '')
  return Number.isNaN(t) ? Number.MAX_VALUE : t
}

/**
 * Asks every repo at once. `read` answers a repo's approvals and work item run records; a repo it fails for goes in
 * `failed` and the others still answer. The longest wait comes first, and an item with no time last.
 */
export async function readInbox(repos: InboxRepo[], read: (repo: Repo) => Promise<[approvals: unknown, runs: unknown]>, now: string): Promise<Inbox> {
  const failed: Inbox['failed'] = []
  const lists = await Promise.all(
    repos.map((r) =>
      read(r.repo)
        .then(([approvals, runs]) => parseInbox(r, approvals, runs, now))
        .catch((e: Error): InboxItem[] => {
          failed.push({ repoLabel: r.label, message: e.message })
          return []
        })
    )
  )
  return { items: lists.flat().sort((a, b) => waitStart(a) - waitStart(b)), failed, repos: repos.length }
}
