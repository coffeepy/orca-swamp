import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { parseApprovals, parseRun } from './domain'
import type { RecentRun, Repo, RepoDir, RunId, RunStatus, SshHost } from './domain'
import type { InboxItem } from './inbox'
import { ACTION_LOOK, actionCommand, actionLabel, inboxGroups, inboxId, inboxPlace, ago, approveCommand, duration, failurePrompt, firstFailed, groupWorkflows, logLine, originOf, parent, parsePlace, placeIn, resolutionIn, withPlace, ALL_RUNS, parseRunsView, runGroups, runsShown, runsViewIn, workflowsShown, type RunsView, withResolution, type Place, workspaceKey, payloadBlocks, remoteOff, retryCommand, runPill, shortName } from './present'

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
  for (const p of [{ tab: 'stagecraft', factory: 'f', item: 'k' }, { tab: 'workflows', workflow: 'w', runId: 'r' }, { tab: 'stagecraft' }, { tab: 'inbox' }] as const) {
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

test('each repo keeps its own last place, an old single saved place still reads, and only the 20 used last are kept', () => {
  const ticket: Place = { tab: 'stagecraft', factory: 'f', item: 'k' }
  const run: Place = { tab: 'workflows', workflow: 'w', runId: 'r' as never }
  const saved = withPlace(withPlace(undefined, '/a', ticket), 'host:/b', run)
  assert.deepEqual(placeIn(JSON.parse(JSON.stringify(saved)), '/a'), ticket, 'coming back to a repo opens where the person was')
  assert.deepEqual(placeIn(saved, 'host:/b'), run)
  assert.equal(placeIn(saved, '/never-seen'), undefined)
  assert.deepEqual(placeIn(withPlace(saved, '/a', { tab: 'workflows' }), '/a'), { tab: 'workflows' }, 'a newer place replaces the older one')
  assert.deepEqual(placeIn({ place: ticket, repo: '/old' }, '/old'), ticket, 'what an older version saved')
  for (const junk of [null, 'x', 7, [null, 3, { repo: 5 }, { place: ticket }], { repo: '' }]) assert.deepEqual(withPlace(junk, '/a', run), [{ repo: '/a', place: run }])
  let many: unknown = saved
  for (let i = 0; i < 25; i++) many = withPlace(many, `/r${i}`, run)
  assert.equal((many as unknown[]).length, 20)
  assert.equal(placeIn(many, '/a'), undefined, 'the repo used longest ago is dropped')
  assert.deepEqual(placeIn(many, '/r24'), run)
})

test('each workspace keeps the repo it resolved to last, damaged storage reads as nothing remembered, and only the 20 used last are kept', () => {
  const local = { kind: 'local', dir: '/a' } as Repo
  const remote = { kind: 'ssh', host: 'jarvis', dir: '/srv/b' } as Repo
  const chosen = { repo: local, candidates: [{ repo: local, label: 'a · home' }, { repo: remote, label: 'b · srv' }], workspace: { name: 'main', listed: true } }
  const picker = { repo: null, candidates: [{ repo: remote, label: 'b · srv' }], remoteHosts: ['jarvis' as SshHost] }
  const saved = withResolution(withResolution(undefined, 'main\0main\0term_1', chosen), '', picker)
  assert.deepEqual(resolutionIn(JSON.parse(JSON.stringify(saved)), 'main\0main\0term_1'), chosen, 'a switch back finds the repo without asking')
  assert.deepEqual(resolutionIn(saved, ''), picker, 'the picker of a workspace Orca does not name is remembered too')
  assert.equal(resolutionIn(saved, 'never-seen'), undefined)
  assert.deepEqual(resolutionIn(withResolution(saved, '', { ...picker, repo: remote }), '')?.repo, remote, 'a newer answer replaces the older one')
  const failing = { ...picker, problem: { code: 'host_unreachable' as const, message: 'down' } }
  assert.deepEqual(resolutionIn(withResolution(saved, '', failing), ''), picker, 'an answer with a problem does not replace the one remembered')
  const junk = [null, 'x', 7, { workspace: 'w', resolution: chosen }, [null, 3, { workspace: 5, resolution: chosen }, { workspace: 'w' }, { workspace: 'w', resolution: { repo: { kind: 'local' }, candidates: [] } }, { workspace: 'w', resolution: { repo: null } }]]
  for (const j of junk) assert.deepEqual(withResolution(j, 'w2', chosen), [{ workspace: 'w2', resolution: chosen }])
  const damaged = { repo: local, candidates: [null, { repo: { kind: 'ssh', dir: '/x' }, label: 'no host' }, { repo: remote, label: 'b · srv' }], workspace: { name: 7 }, remoteHosts: [3] }
  assert.deepEqual(resolutionIn([{ workspace: 'w', resolution: damaged }], 'w'), { repo: local, candidates: [{ repo: remote, label: 'b · srv' }] }, 'a damaged choice is left out of the picker')
  let many: unknown = saved
  for (let i = 0; i < 25; i++) many = withResolution(many, `w${i}`, chosen)
  assert.equal((many as unknown[]).length, 20)
  assert.equal(resolutionIn(many, ''), undefined, 'the workspace used longest ago is dropped')
  assert.deepEqual(resolutionIn(many, 'w24'), chosen)
})

test('the inbox shows one group per repo, the repo with the longest wait first, and Open goes to the run or the ticket', () => {
  const a = { kind: 'local', dir: '/a' } as Repo
  const b = { kind: 'ssh', host: 'jarvis', dir: '/a' } as Repo
  const gate = (repo: Repo, repoLabel: string, runId: string): InboxItem => ({ repo, repoLabel, kind: 'gate', gate: { workflow: 'deploy', runId: runId as never, step: 'signoff', prompt: '', expired: false } })
  const ticket: InboxItem = { repo: a, repoLabel: 'a', kind: 'ticket', factory: 'team', key: 'team-4', title: 'Filter', stage: 'plan-review', gates: ['plan-approval'] }
  const items = [gate(b, 'a · jarvis', 'r1'), ticket, gate(b, 'a · jarvis', 'r2'), gate(a, 'a', 'r1')]
  assert.deepEqual(inboxGroups(items).map((g) => [g.label, g.items.length]), [['a · jarvis', 2], ['a', 2]], 'a remote repo and a local one at the same path are two repos')
  assert.equal(new Set(items.map(inboxId)).size, 4, 'each item has its own id, so a note or a press is for that item only')
  assert.deepEqual(inboxPlace(items[0]), { tab: 'workflows', workflow: 'deploy', runId: 'r1' })
  assert.deepEqual(inboxPlace(ticket), { tab: 'stagecraft', factory: 'team', item: 'team-4' })
  assert.deepEqual(parent({ tab: 'inbox' }), { tab: 'inbox' })
})

// Local times, so "today" is the same day wherever the tests run. Now is Wednesday 11 November 2026, 15:00.
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime()
const NOW = at(11, 15)
const aRun = (id: string, status: RunStatus, startedMs: number, more: Partial<RecentRun> = {}): RecentRun => ({
  workflow: 'convert-call',
  runId: id as RunId,
  status,
  startedAt: new Date(startedMs).toISOString(),
  ...more
})
const RUNS: RecentRun[] = [
  aRun('aaaa1111-0000', 'running', at(11, 14), { input: 'graphql:mutation:updateTranscript', inputs: 'rest/factory-base 0' }),
  aRun('bbbb2222-0000', 'pending', at(11, 0), { workflow: 'convert-lane' }),
  aRun('cccc3333-0000', 'failed', at(10, 23, 59), { durationMs: 9_000, failedStep: 'expose_impl', input: 'graphql:query:downloadAvailability' }),
  aRun('dddd4444-0000', 'interrupted', at(9, 12), { durationMs: 1_000 }),
  aRun('eeee5555-0000', 'succeeded', at(4, 15, 1), { durationMs: 60_000, workflow: 'convert-batch' }),
  aRun('ffff6666-0000', 'succeeded', at(4, 14, 59), { durationMs: 5_000 }),
  aRun('gggg7777-0000', 'suspended', at(1, 9)),
  aRun('hhhh8888-0000', 'cancelled', at(1, 8), { durationMs: 2_000 }),
  aRun('iiii9999-0000', 'unknown', at(1, 7))
]
const ids = (view: Partial<RunsView> = {}, search = '', runs: readonly RecentRun[] = RUNS): string[] =>
  runsShown(runs, { ...ALL_RUNS, ...view }, search, NOW).runs.map((r) => r.runId.slice(0, 4))

test('each status chip shows its runs, and a cancelled run shows under All only', () => {
  assert.deepEqual(ids(), ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff', 'gggg', 'hhhh', 'iiii'])
  assert.deepEqual(ids({ status: 'running' }), ['aaaa', 'bbbb'], 'a pending run is about to run')
  assert.deepEqual(ids({ status: 'failed' }), ['cccc', 'dddd'], 'an interrupted run did not finish its work')
  assert.deepEqual(ids({ status: 'passed' }), ['eeee', 'ffff'])
  assert.deepEqual(ids({ status: 'waiting' }), ['gggg'])
  assert.deepEqual(ids({}, 'cancelled'), ['hhhh'], 'the status word finds what no chip shows')
})

test('Today is since local midnight and This week is the last 7 days', () => {
  assert.deepEqual(ids({ when: 'today' }), ['aaaa', 'bbbb'], 'a run started at midnight is today, one a minute before is not')
  assert.deepEqual(ids({ when: 'week' }), ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'], 'a run started 7 days less a minute ago is in, one 7 days and a minute ago is out')
  assert.deepEqual(ids({ when: 'week', status: 'passed' }), ['eeee'])
  assert.deepEqual(ids({ when: 'today' }, '', [aRun('nope', 'failed', NOW, { startedAt: '' })]), [], 'a run with no start time is in no time window')
})

test('each sort orders the runs, with runs of no known duration last under Longest', () => {
  assert.deepEqual(ids({ sort: 'oldest' }), ['iiii', 'hhhh', 'gggg', 'ffff', 'eeee', 'dddd', 'cccc', 'bbbb', 'aaaa'])
  assert.deepEqual(ids({ sort: 'longest' }), ['eeee', 'cccc', 'ffff', 'hhhh', 'dddd', 'aaaa', 'bbbb', 'gggg', 'iiii'])
  assert.deepEqual(ids({ sort: 'name' }), ['eeee', 'aaaa', 'cccc', 'dddd', 'ffff', 'gggg', 'hhhh', 'iiii', 'bbbb'], 'by workflow, then newest first')
  assert.deepEqual(RUNS.map((r) => r.runId.slice(0, 4)).join(), 'aaaa,bbbb,cccc,dddd,eeee,ffff,gggg,hhhh,iiii', 'the list given is left as it was')
})

test('the search finds a run by any input, its id, its failed step or its workflow', () => {
  assert.deepEqual(ids({}, 'updateTranscript'), ['aaaa'])
  assert.deepEqual(ids({}, ' FACTORY-BASE '), ['aaaa'], 'an input after the first, in any case')
  assert.deepEqual(ids({}, 'downloadavail'), ['cccc'])
  assert.deepEqual(ids({}, 'cccc'), ['cccc'], 'the short id')
  assert.deepEqual(ids({}, 'cccc3333-0000'), ['cccc'], 'the full id')
  assert.deepEqual(ids({}, 'expose_impl'), ['cccc'])
  assert.deepEqual(ids({}, 'convert-lane'), ['bbbb'])
  assert.deepEqual(ids({ status: 'passed' }, 'expose_impl'), [], 'the search and the chip both apply')
  assert.deepEqual(ids({}, 'no such thing'), [])
})

test('each chip counts what it would show under the search and the time window, whichever chip is on', () => {
  const counts = (view: Partial<RunsView>, search = '') => runsShown(RUNS, { ...ALL_RUNS, ...view }, search, NOW).counts
  assert.deepEqual(counts({}), { all: 9, running: 2, failed: 2, passed: 2, waiting: 1 })
  assert.deepEqual(counts({ status: 'failed', sort: 'name' }), counts({}), 'the chip that is on does not change the counts')
  assert.deepEqual(counts({ when: 'week' }), { all: 5, running: 2, failed: 2, passed: 1, waiting: 0 })
  assert.deepEqual(counts({ when: 'week' }, 'convert-call'), { all: 3, running: 1, failed: 2, passed: 0, waiting: 0 })
})

test('the workflows follow the chip, the time window and the search, and a workflow that never ran shows only while no chip or window is on', () => {
  const WORKFLOWS = [{ name: 'convert-batch' }, { name: 'convert-call' }, { name: 'convert-lane' }, { name: 'never-ran', description: 'Nightly cleanup' }]
  const names = (view: Partial<RunsView> = {}, search = ''): string[] => {
    const v = { ...ALL_RUNS, ...view }
    return workflowsShown(WORKFLOWS, runsShown(RUNS, v, search, NOW).runs, v, search).map((w) => w.name)
  }
  assert.deepEqual(names(), ['convert-batch', 'convert-call', 'convert-lane', 'never-ran'])
  assert.deepEqual(names({ sort: 'name' }), names(), 'a sort hides nothing')
  assert.deepEqual(names({ status: 'running' }), ['convert-call', 'convert-lane'])
  assert.deepEqual(names({ status: 'passed', when: 'week' }), ['convert-batch'], 'convert-call passed, but more than a week ago')
  assert.deepEqual(names({}, 'expose_impl'), ['convert-call'], 'found by a run')
  assert.deepEqual(names({}, 'NEVER'), ['never-ran'], 'found by its name')
  assert.deepEqual(names({}, 'nightly'), ['never-ran'], 'found by its description')
  assert.deepEqual(names({ when: 'today' }, 'never'), [], 'a time window asks for a run')
  assert.deepEqual(names({ status: 'failed' }, 'convert-lane'), [], 'the name matches, but no failed run does')
})

test('the runs are grouped by workflow in the order of each first run, and the limit counts runs across the groups', () => {
  const groups = (view: Partial<RunsView> = {}, limit = 20): string[] =>
    runGroups(runsShown(RUNS, { ...ALL_RUNS, ...view }, '', NOW).runs, limit).map((g) => `${g.workflow}: ${g.runs.map((r) => r.runId.slice(0, 4)).join(' ')}`)
  assert.deepEqual(groups(), ['convert-call: aaaa cccc dddd ffff gggg hhhh iiii', 'convert-lane: bbbb', 'convert-batch: eeee'])
  assert.deepEqual(groups({ sort: 'oldest' }), ['convert-call: iiii hhhh gggg ffff dddd cccc aaaa', 'convert-batch: eeee', 'convert-lane: bbbb'])
  assert.deepEqual(groups({ sort: 'name' }), ['convert-batch: eeee', 'convert-call: aaaa cccc dddd ffff gggg hhhh iiii', 'convert-lane: bbbb'])
  assert.deepEqual(groups({}, 8), ['convert-call: aaaa cccc dddd ffff gggg hhhh iiii', 'convert-lane: bbbb'], 'a group with no row left is not drawn')
  assert.deepEqual(groups({}, 3), ['convert-call: aaaa cccc dddd'])
})

test('each repo keeps how its runs were narrowed, and anything malformed reads as everything, newest first', () => {
  const failedThisWeek: RunsView = { status: 'failed', when: 'week', sort: 'longest' }
  const saved = withPlace(withPlace(undefined, '/a', { tab: 'workflows' }, failedThisWeek), '/b', { tab: 'workflows' })
  assert.deepEqual(runsViewIn(JSON.parse(JSON.stringify(saved)), '/a'), failedThisWeek)
  assert.deepEqual(runsViewIn(saved, '/b'), ALL_RUNS)
  assert.deepEqual(runsViewIn(saved, '/never-seen'), ALL_RUNS)
  assert.deepEqual(runsViewIn([{ repo: '/a', place: {}, runs: { status: 'toString', when: 7, sort: 'name' } }], '/a'), { status: 'all', when: 'all', sort: 'name' })
  assert.deepEqual(parseRunsView(null), ALL_RUNS)
})

test('run controls read by status, ask before they stop or recover, and name the swamp command they run', () => {
  const run = parseRun(fx('breaks.def'), fx('breaks.run-failed'))
  assert.equal(actionLabel('retry', 'failed'), 'Retry failed steps')
  assert.equal(actionLabel('retry', 'suspended'), 'Resume')
  assert.equal(actionLabel('stop', 'pending'), 'Stop')
  assert.deepEqual(Object.entries(ACTION_LOOK).filter(([, look]) => look.confirm).map(([a]) => a), ['stop', 'recover'])
  assert.equal(actionCommand('stop', run), `swamp workflow cancel breaks --run ${run.id}`)
  assert.equal(actionCommand('retry', run), `swamp workflow resume breaks --run ${run.id}`)
  assert.ok(actionCommand('recover', run).startsWith(`swamp workflow recover breaks --run ${run.id} --acknowledge-unknown`))
})
