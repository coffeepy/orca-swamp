import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import type { Repo } from './domain'
import { inboxRepos, parseInbox, readInbox } from './inbox'

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
const NOW = '2026-11-07T23:40:00.000Z'

function repo(root: string, ...parts: string[]): string {
  const dir = join(root, ...parts)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.swamp.yaml'), 'swampVersion: test\n')
  return dir
}
const local = (dir: string) => ({ kind: 'local', dir }) as Repo
const ssh = (dir: string) => ({ kind: 'ssh', host: 'jarvis', dir }) as Repo

test('the inbox reads each repo once: those of the Orca workspaces, the registry, the pins and the one on screen', () => {
  const root = mkdtempSync(join(tmpdir(), 'swampling-inbox-'))
  const [app, factory, pinned, onScreen] = [repo(root, 'app'), repo(root, 'tools', 'factory'), repo(root, 'pinned'), repo(root, 'shown')]
  const gone = join(root, 'deleted')
  const repos = inboxRepos(
    [join(app, 'packages', 'web'), app, join(root, 'no-swamp-here')],
    [{ name: 'acme-factory', path: factory }],
    { w1: local(app), w2: local(factory), w3: local(pinned), w4: ssh('/srv/factory-v3'), w5: ssh('/srv/factory-v3'), w6: local(gone) },
    [local(onScreen), ssh('/srv/factory-v3')]
  )
  assert.deepEqual(
    repos.map((r) => [r.label, r.repo]).sort(),
    [
      ['acme-factory', local(factory)],
      ['app', local(app)],
      ['factory-v3 · jarvis', ssh('/srv/factory-v3')],
      ['pinned', local(pinned)],
      ['shown', local(onScreen)]
    ],
    'two workspaces and a pin in one repo are one read, a remote repo names its host, and a pin to a folder that is gone is left out'
  )
})

test('a gate and a ticket that wait each become one item that names what a decision needs', () => {
  const at = { repo: ssh('/srv/f'), label: 'f · jarvis' }
  const approvals = { approvals: (fx('gated.approvals') as { approvals: unknown[] }).approvals, expired: [{ workflowName: 'old', runId: 'r-old', stepName: 'signoff', suspendedAt: '2026-11-01T00:00:00Z' }] }
  const items = parseInbox(at, approvals, fx('sc.runs'), NOW)
  assert.deepEqual(
    items.map((i) => (i.kind === 'gate' ? [i.kind, i.gate.workflow, i.gate.step, i.gate.runId, i.gate.expired, i.since] : [i.kind, i.factory, i.key, i.stage, i.gates, i.since])),
    [
      ['gate', 'gated', 'signoff', '0fdef291-426e-4ec9-a2c0-92bc24c3a7d8', false, '2026-11-07T06:14:14.508Z'],
      ['gate', 'old', 'signoff', 'r-old', true, '2026-11-01T00:00:00.000Z'],
      ['ticket', 'team', 'team-4', 'plan-review', ['plan-approval'], items[2].since],
      ['ticket', 'team', 'team-5', 'plan-review', ['plan-approval'], items[3].since]
    ],
    'an expired gate is still listed, and only the tickets held for a person are'
  )
  assert.ok(items.every((i) => i.repoLabel === 'f · jarvis' && JSON.stringify(i.repo) === JSON.stringify(at.repo)), 'each item names its repo')
  assert.ok(items[2].since && items[3].since, 'a ticket says since when it waits')
})

test('a repo that cannot be read is named, and the others still answer with the longest wait first', async () => {
  const gate = (runId: string, suspendedAt?: string) => ({ workflowName: 'deploy', runId, stepName: 'signoff', suspendedAt })
  const answers: Record<string, unknown> = {
    '/a': { approvals: [gate('newest', '2026-11-07T10:00:00Z'), gate('no-time')], expired: [] },
    '/c': { approvals: [gate('middle', '2026-11-06T10:00:00Z')], expired: [gate('oldest', '2026-11-01T10:00:00Z')] }
  }
  const repos = ['/a', '/b', '/c'].map((dir) => ({ repo: local(dir), label: dir.slice(1) }))
  const inbox = await readInbox(
    repos,
    async (r) => {
      if (r.dir === '/b') throw new Error('Could not reach jarvis over SSH')
      return [answers[r.dir], { results: [] }]
    },
    NOW
  )
  assert.deepEqual(inbox.items.map((i) => (i.kind === 'gate' ? `${i.repoLabel}:${i.gate.runId}` : '')), ['c:oldest', 'c:middle', 'a:newest', 'a:no-time'])
  assert.deepEqual(inbox.failed, [{ repoLabel: 'b', message: 'Could not reach jarvis over SSH' }])
  assert.equal(inbox.repos, 3)
})

test('a repo whose answer is not what swamp prints fails alone too', async () => {
  const repos = ['/a', '/b'].map((dir) => ({ repo: local(dir), label: dir.slice(1) }))
  const inbox = await readInbox(repos, async (r) => [r.dir === '/a' ? 'not json' : fx('gated.approvals'), { results: [] }], NOW)
  assert.deepEqual([inbox.items.length, inbox.failed.map((f) => f.repoLabel)], [1, ['a']])
})
