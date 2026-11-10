import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { parseApprovals, parseRun } from './domain'
import type { Repo, RepoDir, SshHost } from './domain'
import { ago, approveCommand, duration, failurePrompt, firstFailed, groupWorkflows, logLine, originOf, parent, parsePlace, type Place, workspaceKey, payloadBlocks, remoteOff, retryCommand, runPill, shortName } from './present'

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

test('the run pill counts passed steps and waiting gates out of all steps', () => {
  const suspended = parseRun(fx('gated.def'), fx('gated.run-suspended'), parseApprovals(fx('gated.approvals')))
  assert.deepEqual(runPill(suspended), { tone: 'wait', text: 'Waiting · 3/4' })
  assert.deepEqual(runPill(parseRun(fx('breaks.def'), fx('breaks.run-failed'))), { tone: 'fail', text: 'Failed · 2/4' })
  assert.deepEqual(runPill(parseRun(fx('gated.def'), fx('gated.run-approved'))), { tone: 'run', text: 'Resuming · 3/4' })
})

test('a failed run offers a retry from its failed step and a one-line agent prompt', () => {
  const run = parseRun(fx('breaks.def'), fx('breaks.run-failed'))
  const step = firstFailed(run)!
  assert.equal(retryCommand(run, step.name), `swamp workflow resume breaks --run ${run.id} --from right`)
  const prompt = failurePrompt(run, step)
  assert.ok(!prompt.includes('\n'), 'typing a newline would submit the prompt early')
  assert.ok(prompt.includes('right side must hold') && prompt.includes(retryCommand(run, 'right')))
  const typed = failurePrompt({ ...run, inputs: { notes: 'first line\nrm -rf x\r\x1b[2J' } }, step)
  assert.ok(!/[\x00-\x1f\x7f]/.test(typed), 'a run input cannot press Enter or send an escape sequence')
  assert.ok(typed.includes('notes=first line rm -rf x [2J'))
})

test('the gate card names the exact approve command the panel runs', () => {
  assert.equal(approveCommand('gated', 'signoff', 'r1'), 'swamp workflow approve gated signoff --run r1')
})

test('log lines drop the timestamp, method prefix and JSON quotes, and keep their level', () => {
  assert.deepEqual(logLine('2026-10-26T19:25:09.214Z [INF] model·method·run·factory-builder·implement: "Checked 4 files"'), {
    text: 'Checked 4 files',
    level: 'info'
  })
  assert.equal(logLine('2026-10-26T19:25:09.214Z [ERR] model·method·run·x·y: "boom"').level, 'error')
})

test('relative times read like the mockup', () => {
  const now = Date.parse('2026-11-07T07:00:00Z')
  assert.equal(ago('2026-11-07T06:54:00Z', now), '6m ago')
  assert.equal(ago('2026-11-06T07:00:00Z', now), '1d ago')
})

test('a plan payload reads as its summary, steps with files and testing strategy, with extra fields as rows', () => {
  const blocks = payloadBlocks({
    summary: 'Fix headers',
    steps: [{ description: 'Set Cache-Control', files: ['src/feed.ts'] }, { description: 'Add a metric' }],
    testingStrategy: 'unit tests',
    risks: ['CDN rate limit'],
    rollback: { flag: 'feed_cache', default: false },
    estimateHours: 6
  })
  assert.deepEqual(blocks, [
    { kind: 'text', label: 'Summary', text: 'Fix headers' },
    { kind: 'steps', label: 'Steps', steps: [{ description: 'Set Cache-Control', files: ['src/feed.ts'] }, { description: 'Add a metric', files: [] }] },
    { kind: 'text', label: 'Testing strategy', text: 'unit tests' },
    { kind: 'list', label: 'Risks', items: ['CDN rate limit'] },
    { kind: 'fields', label: 'Other fields', rows: [['rollback.flag', 'feed_cache'], ['rollback.default', 'false'], ['estimateHours', '6']] }
  ])
})

test('findings list critical and high first, resolved ones last, coloured by severity', () => {
  const [b] = payloadBlocks({
    findings: [
      { id: '1', severity: 'low', description: 'Name it' },
      { id: '2', severity: 'high', description: 'Loses data', resolved: true },
      { id: '3', severity: 'medium', description: 'Slow' },
      { id: '4', severity: 'critical', description: 'Breaks prod' }
    ]
  })
  assert.equal(b.kind, 'findings')
  if (b.kind !== 'findings') return
  assert.deepEqual(b.findings.map((f) => `${f.severity}:${f.tone}:${f.resolved}`), ['critical:fail:false', 'medium:warm:false', 'low:muted:false', 'high:fail:true'])
})

test('an unknown shape still reads as key/value rows, never only raw JSON', () => {
  assert.deepEqual(payloadBlocks({ steps: [{ description: 'x', owner: 'ann' }], score: null }), [
    { kind: 'fields', label: 'Fields', rows: [['steps[1].description', 'x'], ['steps[1].owner', 'ann'], ['score', 'null']] }
  ])
  assert.deepEqual(payloadBlocks([1, 2]), [{ kind: 'fields', label: 'Payload', rows: [['value[1]', '1'], ['value[2]', '2']] }])
})

test('durations roll over at the minute, hour and day instead of showing 60s or 60m', () => {
  assert.equal(duration(0), '0.0s')
  assert.equal(duration(59_940), '59.9s')
  assert.equal(duration(59_960), '1m 0s')
  assert.equal(duration(119_700), '2m 0s')
  assert.equal(duration(3_599_600), '1h 0m')
  assert.equal(duration(3 * 86_400_000 + 5 * 3_600_000), '3d 5h')
})

test('a duration from a skewed or broken clock reads as zero or empty, never NaN or negative', () => {
  assert.equal(duration(-5_000), '0.0s')
  assert.equal(duration(Number.NaN), '')
  assert.equal(duration(undefined), '')
})

test('an unreadable or future timestamp shows no NaN age', () => {
  const now = Date.parse('2026-11-07T07:00:00Z')
  assert.equal(ago('not a date', now), '')
  assert.equal(ago('', now), '')
  assert.equal(ago('2026-11-07T08:00:00Z', now), '0s ago')
})

test('studio and send are off for a repo on an SSH host, with the reason, and on for a local one', () => {
  const ssh: Repo = { kind: 'ssh', host: 'jarvis' as SshHost, dir: '/srv/repo' as RepoDir }
  const local: Repo = { kind: 'local', dir: '/Users/me/repo' as RepoDir }
  assert.match(remoteOff(ssh, 'studio') ?? '', /jarvis/)
  assert.match(remoteOff(ssh, 'send') ?? '', /jarvis/)
  assert.equal(remoteOff(local, 'studio'), null)
  assert.equal(remoteOff(local, 'send'), null)
})

test('a scoped workflow comes from its extension, a plain one from the repo', () => {
  assert.deepEqual(originOf('@swamp/stagecraft/claim'), { kind: 'extension', name: '@swamp/stagecraft' })
  assert.deepEqual(originOf('verify-v3'), { kind: 'repo' })
  assert.equal(shortName('@swamp/stagecraft/claim'), 'claim')
  assert.equal(shortName('verify-v3'), 'verify-v3')
})

test("the repo's workflows come first, then one group per extension, and none is dropped", () => {
  const names = ['@swamp/stagecraft/claim', 'verify-v3', '@acme/ops/deploy', '@swamp/stagecraft/publish', 'make-note']
  const groups = groupWorkflows(names.map((name) => ({ name })))
  assert.deepEqual(
    groups.map((g) => [g.title, g.workflows.map((w) => w.name)]),
    [
      ['Workflows', ['verify-v3', 'make-note']],
      ['@acme/ops', ['@acme/ops/deploy']],
      ['StageCraft', ['@swamp/stagecraft/claim', '@swamp/stagecraft/publish']]
    ]
  )
})

test('Back climbs one level at a time on both tabs, and stops at the tab', () => {
  const up = (p: Place, n: number): Place[] => (n ? [p, ...up(parent(p), n - 1)] : [p])
  assert.deepEqual(up({ tab: 'workflows', workflow: 'make-note', runId: 'r1' as never }, 3), [
    { tab: 'workflows', workflow: 'make-note', runId: 'r1' },
    { tab: 'workflows', workflow: 'make-note' },
    { tab: 'workflows' },
    { tab: 'workflows' }
  ])
  assert.deepEqual(up({ tab: 'stagecraft', factory: 'note-factory', item: 'note-2' }, 3), [
    { tab: 'stagecraft', factory: 'note-factory', item: 'note-2' },
    { tab: 'stagecraft', factory: 'note-factory' },
    { tab: 'stagecraft' },
    { tab: 'stagecraft' }
  ])
})

test('a saved place reads back as itself, and anything malformed as the Workflows tab', () => {
  for (const p of [{ tab: 'stagecraft', factory: 'f', item: 'k' }, { tab: 'workflows', workflow: 'w', runId: 'r' }, { tab: 'stagecraft' }] as const) {
    assert.deepEqual(parsePlace(JSON.parse(JSON.stringify(p))), p)
  }
  assert.deepEqual(parsePlace({ tab: 'stagecraft', item: 'k' }), { tab: 'stagecraft' }, 'a ticket needs its factory')
  assert.deepEqual(parsePlace(null), { tab: 'workflows' })
  assert.deepEqual(parsePlace({ tab: 'workflows', workflow: 7 }), { tab: 'workflows' })
})

test('switching between two workspaces named master on branch master is a switch; renaming a terminal is not', () => {
  const swampTest = { displayName: 'master', branch: 'master', terminals: [{ id: 'term_1c7f', title: 'zsh' }] }
  const otherRepo = { displayName: 'master', branch: 'master', terminals: [{ id: 'term_9a02', title: 'zsh' }] }
  assert.notEqual(workspaceKey(swampTest), workspaceKey(otherRepo))
  assert.equal(workspaceKey(swampTest), workspaceKey({ ...swampTest, terminals: [{ id: 'term_1c7f', title: 'claude' }] }))
  assert.equal(workspaceKey(null), '')
})
