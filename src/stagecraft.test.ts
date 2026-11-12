import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { PACE } from './pace'
import { cellsOf, dispatchRun, reasonWord, storedNote, ticketWhen, whyHere } from './present'
import { SwampFailure } from './domain'
import { digestOf, FACTORY_TYPE, olderPayloadsQuery, parseBoard, parseFactories, parseWorkItemDetail, parseWorkItems, studioUrl } from './stagecraft'

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
const NOW = '2026-11-07T23:40:00.000Z'

test('a repo without StageCraft reads as not installed, one with it lists its factories', () => {
  assert.deepEqual(parseFactories(fx('sc.types-missing'), fx('sc.models'), fx('sc.runs'), NOW), { installed: false })
  assert.deepEqual(parseFactories(fx('sc.types-installed'), fx('sc.models'), fx('sc.runs'), NOW), {
    installed: true,
    factories: [{ name: 'team', tickets: ['queued', 'queued', 'queued', 'needs-you', 'needs-you', 'queued', 'stuck'], needYou: 2 }],
    studio: 'studio'
  })
})

test('each card matches what the StageCraft studio itself says about the work item', () => {
  const studio = (fx('sc.studio-cards') as { items: Record<string, unknown>[] }).items
  const ours = parseWorkItems(fx('sc.runs'), NOW)
  assert.deepEqual(
    ours.map((i) => [i.key, i.stage, i.cycle, i.enteredAt, i.waiting, i.parked !== null]),
    studio.map((c) => [c.key, c.stage, c.cycle, c.enteredAt, c.waiting, (c.parked as unknown[]).length > 0])
  )
})

test('the board lists the factory definition stages in order', () => {
  const board = parseBoard(fx('sc.factory'), fx('sc.runs'), NOW)
  assert.deepEqual(
    board.stages.filter((s) => !s.terminal).map((s) => `${s.id}:${s.mode}`),
    ['plan:interactive', 'plan-review:dispatch', 'implement:interactive', 'verify:interactive', 'code-review:dispatch', 'release:interactive']
  )
  assert.equal(board.items.length, 7)
})

test('a work item waiting on plan-approval shows its stages, exits with gates, products and metrics', () => {
  const d = parseWorkItemDetail(fx('sc.item-team-4'), NOW)
  assert.equal(d.item.title, 'High-risk content filter')
  assert.deepEqual(d.item.waiting?.exits.map((x) => [x.transition, x.gateIds]), [['approve', ['plan-approval']]])
  assert.deepEqual(cellsOf(d.stages, d.item).slice(0, 3), [{ kind: 'passed' }, { kind: 'now' }, { kind: 'ahead' }])
  const approve = d.exits.find((x) => x.name === 'approve')!
  assert.deepEqual(approve.gates.map((g) => g.label), ['artifact-fresh plan-review', 'findings-clear critical,high', 'human-approval plan-approval'])
  assert.equal(approve.gates[2].person, 'plan-approval')
  assert.deepEqual(
    d.products.map((p) => `${p.name}: ${p.summary}`),
    ['plan: artifact · 1 step · v1', 'plan-review: findings · 0 high · 2 low']
  )
  assert.equal(d.metrics.reviewRounds, 1)
  assert.equal(d.timeline[0].text, 'waiting on plan-approval')
})

test('a work item at its dispatch cap reads as parked, not waiting', () => {
  const d = parseWorkItemDetail(fx('sc.item-team-7'), NOW)
  assert.equal(d.item.waiting, null)
  assert.deepEqual(d.item.parked, { count: 2, limit: 2 })
  assert.equal(d.metrics.dispatches, 2)
})

test('the studio URL comes from the line serve logs', () => {
  assert.equal(studioUrl('  Executing   serve\n              studio: http://127.0.0.1:51843/\n'), 'http://127.0.0.1:51843/')
  assert.equal(studioUrl('  Resolved   studio'), undefined)
})

type Records = { results: { name: string; version: number; content: unknown }[] }
const plan = (q: Records) => q.results.find((r) => r.name === 'artifact-plan')!

test('a waiting item carries the payloads its gate reads, at the version and digest the journal recorded', () => {
  const q = fx('sc.item-team-4') as Records
  assert.equal(olderPayloadsQuery('team-4', q), undefined)
  const d = parseWorkItemDetail(q, NOW)
  assert.deepEqual(d.products.map((p) => [p.name, p.stored.match, p.forGate]), [['plan', 'current', true], ['plan-review', 'current', true]])
  assert.deepEqual((d.products[0].stored as { payload: unknown }).payload, plan(q).content)
})

test('a payload whose digest or version is not the recorded one is shown as stale, and the recorded version is fetched', () => {
  const edited = fx('sc.item-team-4') as Records
  plan(edited).content = { summary: 'changed after recording', steps: [], testingStrategy: 'none' }
  const sameVersion = parseWorkItemDetail(edited, NOW).products[0]
  assert.equal(sameVersion.stored.match, 'stale')
  assert.match(storedNote(sameVersion)!, /does not match the digest/)

  const original = plan(fx('sc.item-team-4') as Records)
  plan(edited).version = 2
  assert.equal(
    olderPayloadsQuery('team-4', edited),
    'modelType == "@swamp/stagecraft/work-item" && modelName == "team-4" && ((name == "artifact-plan" && version == 1))'
  )
  const newer = parseWorkItemDetail(edited, NOW).products[0]
  assert.deepEqual([newer.stored.match, newer.stored.match === 'stale' && newer.stored.version], ['stale', 2])
  assert.match(storedNote(newer)!, /recorded plan v1, but swamp only holds v2/)
  assert.equal(parseWorkItemDetail(edited, NOW, { results: [original] }).products[0].stored.match, 'current')

  edited.results = edited.results.filter((r) => r.name !== 'artifact-plan')
  assert.equal(parseWorkItemDetail(edited, NOW).products[0].stored.match, 'missing')
})

type RunRecords = { results: { content: Record<string, unknown> }[] }

test('a run record from StageCraft schemaVersion 2 reads like version 1', () => {
  const runs = fx('sc.runs') as RunRecords
  const v1 = parseWorkItems(runs, NOW)
  for (const r of runs.results) r.content.schemaVersion = 2
  assert.deepEqual(parseWorkItems(runs, NOW), v1)
})

test('a run record from a StageCraft schemaVersion the panel does not read is a parse_error naming it', () => {
  for (const version of [3, undefined]) {
    const runs = fx('sc.runs') as RunRecords
    runs.results[0].content.schemaVersion = version
    assert.throws(
      () => parseWorkItems(runs, NOW),
      (e: unknown) => e instanceof SwampFailure && e.code === 'parse_error' && e.message.includes(`schemaVersion ${version}`)
    )
  }
})

test('the factory list and the board leave out a ticket of a schemaVersion the panel does not read, and count it', () => {
  const runs = fx('sc.runs') as RunRecords
  const all = parseBoard(fx('sc.factory'), runs, NOW).items.length
  runs.results[0].content.schemaVersion = 3
  const board = parseBoard(fx('sc.factory'), runs, NOW)
  assert.deepEqual([board.items.length, board.skipped], [all - 1, 1])
  const f = parseFactories(fx('sc.types-installed'), fx('sc.models'), runs, NOW)
  assert.ok(f.installed && f.skipped === 1 && f.factories[0].tickets.length === all - 1)
})

test('a findings payload with a null entry still summarizes its real findings', () => {
  const q = fx('sc.item-team-4') as Records
  const review = q.results.find((r) => r.name === 'artifact-plan-review')!
  review.content = { findings: [null, { id: '1', severity: 'high', description: 'x' }] }
  const run = q.results.find((r) => r.name === 'run')!.content as { products: { artifacts: Record<string, { digest: string }> } }
  run.products.artifacts['plan-review'].digest = digestOf(review.content)
  assert.equal(parseWorkItemDetail(q, NOW).products[1].summary, 'findings · 1 high · 0 low')
})

// note-factory in the swamp-test sandbox, driven by hand: note-2 sent back from check, note-3 waiting at ship,
// note-4 with a dispatch open, note-6 parked at its dispatch cap, note-1 and note-5 shipped.
const NOTE_NOW = '2026-11-08T06:00:00.000Z'
const NOW_MS = Date.parse(NOTE_NOW)
const notes = () => parseBoard(fx('sc.note-factory'), fx('sc.note-runs'), NOTE_NOW)

test('each ticket has one status: waiting on a person, parked, a dispatch open, queued, or finished', () => {
  assert.deepEqual(Object.fromEntries(notes().items.map((i) => [i.key, i.status])), {
    'note-1': 'done',
    'note-2': 'queued',
    'note-3': 'needs-you',
    'note-4': 'working',
    'note-5': 'done',
    'note-6': 'stuck'
  })
})

test('a dispatch with an outcome is no longer working, and a terminal stage named abandoned reads as abandoned', () => {
  const runs = fx('sc.note-runs') as RunRecords
  const run = (key: string) => runs.results.find((r) => r.content.key === key)!.content as { journal: Record<string, unknown>[]; stage: string; entries: Record<string, number> }
  const four = run('note-4')
  four.journal.push({ ...four.journal.at(-1)!, type: 'outcome', outcome: 'succeeded', at: NOTE_NOW })
  const five = run('note-5')
  five.stage = 'abandoned'
  five.entries = { ...five.entries, abandoned: 1 }
  const items = parseBoard(fx('sc.note-factory'), runs, NOTE_NOW).items
  assert.deepEqual(['note-4', 'note-5'].map((k) => items.find((i) => i.key === k)!.status), ['queued', 'abandoned'])
})

test('the factory card counts the tickets that need you and colors its latest tickets oldest first', () => {
  const f = parseFactories(fx('sc.types-installed'), { results: [{ name: 'note-factory', type: FACTORY_TYPE }] }, fx('sc.note-runs'), NOTE_NOW)
  assert.deepEqual(f, { installed: true, factories: [{ name: 'note-factory', tickets: ['done', 'queued', 'needs-you', 'working', 'done', 'stuck'], needYou: 1 }] })
})

test('the grid shows passed stages, the current one, the one a ticket was sent back from, and stages not reached', () => {
  const board = notes()
  const columns = board.stages.filter((s) => !s.terminal)
  const row = (key: string) => cellsOf(columns, board.items.find((i) => i.key === key)!)
  assert.deepEqual(columns.map((s) => s.id), ['write', 'check', 'ship'])
  assert.deepEqual(row('note-2'), [{ kind: 'now', passes: 2 }, { kind: 'back' }, { kind: 'ahead' }])
  assert.deepEqual(row('note-3'), [{ kind: 'passed' }, { kind: 'passed' }, { kind: 'now' }])
  assert.deepEqual(row('note-5'), [{ kind: 'passed' }, { kind: 'passed' }, { kind: 'passed' }])
  assert.deepEqual(row('note-6'), [{ kind: 'now' }, { kind: 'ahead' }, { kind: 'ahead' }])
})

// Three tickets as two real factories recorded them: the plan dispatch failed, the plan dispatch was interrupted, and
// the security review succeeded with nothing advancing the ticket after it.
const STUCK_NOW = '2026-11-11T05:00:00.000Z'
const stuck = () => parseWorkItems(fx('sc.stuck-runs'), STUCK_NOW)
const note = (key: string) => notes().items.find((i) => i.key === key)!
const shop = (key: string) => stuck().find((i) => i.key === key)!
const line = (i: ReturnType<typeof note>, now: string) => `${reasonWord(i)} · ${ticketWhen(i, Date.parse(now))}`

test('a ticket held at a gate says which gate a person must decide and since when', () => {
  const i = note('note-3')
  assert.deepEqual(i.reason, { kind: 'gate', since: i.waiting!.since, gates: ['ship-approval'] })
  assert.match(line(i, NOTE_NOW), /^needs you · \d+m$/)
  assert.match(whyHere(i, NOW_MS).text, /person must decide ship-approval/)
})

test('a ticket at its dispatch cap is parked since the cap was hit, and says a person must grant an override', () => {
  const i = note('note-6')
  assert.deepEqual(i.reason, { kind: 'parked', since: '2026-11-08T05:48:27.984Z', count: 2, limit: 2 })
  assert.equal(line(i, NOTE_NOW), 'parked · 2 of 2 tries')
  assert.match(whyHere(i, NOW_MS).next, /grant a dispatch override/)
})

test('a ticket with a dispatch open is working since that dispatch, and its line stays the quiet one', () => {
  const i = note('note-4')
  assert.deepEqual(i.reason, { kind: 'working', since: '2026-11-08T05:47:41.988Z', dispatch: { id: 1, mode: 'interactive', at: '2026-11-08T05:47:41.988Z' }, activeAt: '2026-11-08T05:47:41.988Z' })
  assert.match(line(i, NOTE_NOW), /^working · \d+m$/)
  assert.match(whyHere(i, NOW_MS).text, /is in progress/)
})

/** note-4, whose dispatch is open, read at `now`, with a journal event of `type` at each of `events` after the dispatch. */
function openDispatch(now: string, events: string[] = [], type = 'usage') {
  const runs = fx('sc.note-runs') as RunRecords
  const record = runs.results.find((r) => r.content.key === 'note-4')!.content as { journal: Record<string, unknown>[] }
  for (const at of events) record.journal.push({ ...record.journal.at(-1)!, type, at })
  return parseWorkItems(runs, now).find((i) => i.key === 'note-4')!
}
const after = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString()
const SENT = '2026-11-08T05:47:41.988Z'

test('a working ticket whose dispatch recorded nothing for longer than the threshold counts as stuck and reads "no activity"', () => {
  const now = after(SENT, 3 * 86_400_000)
  const i = openDispatch(now)
  assert.equal(i.status, 'stuck')
  assert.equal(i.reason.kind, 'working')
  assert.equal(line(i, now), 'no activity · 3d')
  const why = whyHere(i, Date.parse(now))
  assert.equal(why.text, 'The work for write has shown no activity for 3d.')
  assert.match(why.next, /still open .* may have stopped/)
  assert.ok(!/failed/.test(why.text + why.next))
})

test('the threshold is counted from the last journal event of the stage entry, not from the dispatch', () => {
  const last = after(SENT, 3 * 86_400_000)
  const justUnder = openDispatch(after(last, PACE.ticketQuietMs), [after(SENT, 60_000), last])
  assert.equal(justUnder.status, 'working')
  assert.ok(justUnder.reason.kind === 'working' && justUnder.reason.activeAt === last && justUnder.reason.since === SENT)
  assert.match(line(justUnder, after(last, PACE.ticketQuietMs)), /^working · /)
  const over = openDispatch(after(last, PACE.ticketQuietMs + 60_000), [last], 'checkpoint')
  assert.equal(over.status, 'stuck')
  assert.equal(line(over, after(last, PACE.ticketQuietMs + 60_000)), 'no activity · 2h')
})

test('a quiet ticket sent to a workflow points at that run', () => {
  const runs = fx('sc.note-runs') as RunRecords
  const record = runs.results.find((r) => r.content.key === 'note-4')!.content as { dispatches: Record<string, unknown>[] }
  Object.assign(record.dispatches.at(-1)!, { mode: 'workflow', workflow: 'write-it' })
  const now = after(SENT, 86_400_000)
  const i = parseWorkItems(runs, now).find((x) => x.key === 'note-4')!
  assert.match(whyHere(i, Date.parse(now)).next, /Open the run of write-it/)
})

test('a ticket whose dispatch failed is stuck since it failed, with the reason its driver wrote', () => {
  const i = shop('shop-1')
  assert.equal(i.status, 'stuck')
  assert.equal(i.reason.kind, 'failed')
  assert.equal(i.reason.since, '2026-11-07T04:02:41.438Z')
  assert.equal(line(i, STUCK_NOW), 'failed · 4d')
  assert.match(whyHere(i, NOW_MS).why!, /^Provider failure/)
  assert.match(whyHere(i, NOW_MS).next, /dispatch the stage's work again/)
})

test('a ticket whose dispatch was interrupted is stuck and says so, not failed', () => {
  const i = shop('shop-2')
  assert.equal(i.status, 'stuck')
  assert.equal(i.reason.kind, 'interrupted')
  assert.equal(line(i, STUCK_NOW), 'interrupted · 4d')
  assert.match(whyHere(i, NOW_MS).text, /was interrupted/)
})

test('a ticket whose work passed but did not advance says so, counted from when the work ended', () => {
  const i = shop('shop-3')
  assert.equal(i.status, 'queued')
  assert.deepEqual(i.reason, { kind: 'passed', since: '2026-11-03T19:46:47.362Z', dispatch: { id: 3, mode: 'dispatch', at: '2026-11-03T19:42:57.112Z' } })
  assert.equal(line(i, STUCK_NOW), 'not advanced · 7d')
})

test('a ticket with nothing sent for its stage entry is idle since it entered, and one sent back says where from', () => {
  const i = note('note-2')
  assert.deepEqual(i.reason, { kind: 'idle', since: i.enteredAt })
  assert.match(line(i, NOTE_NOW), /^idle · \d+m$/)
  assert.match(whyHere(i, NOW_MS).text, /came back to write from check/)
})

test('a finished ticket is done, and its line keeps its status word', () => {
  const i = note('note-1')
  assert.equal(i.reason.kind, 'done')
  assert.equal(reasonWord(i), 'done')
})

test('a failed dispatch to a workflow stage names the workflow, and its run is the first one started after the dispatch', () => {
  const runs = fx('sc.stuck-runs') as RunRecords
  const record = runs.results.find((r) => r.content.key === 'shop-1')!.content as { dispatches: Record<string, unknown>[] }
  Object.assign(record.dispatches[0], { mode: 'workflow', workflow: 'plan-it' })
  const i = parseWorkItems(runs, STUCK_NOW).find((x) => x.key === 'shop-1')!
  assert.ok(i.reason.kind === 'failed' && i.reason.dispatch.workflow === 'plan-it')
  assert.match(whyHere(i, NOW_MS).next, /Open the run of plan-it/)
  const run = (runId: string, workflow: string, startedAt: string) => ({ runId, workflow, startedAt, status: 'failed' }) as Parameters<typeof dispatchRun>[0][number]
  const history = [run('later', 'plan-it', '2026-11-07T09:00:00.000Z'), run('mine', 'plan-it', '2026-11-07T04:01:30.000Z'), run('other', 'ship-it', '2026-11-07T04:01:29.900Z'), run('before', 'plan-it', '2026-11-07T03:00:00.000Z')]
  assert.equal(dispatchRun(history, i.reason.dispatch)?.runId, 'mine')
  assert.equal(dispatchRun(history.slice(3), i.reason.dispatch), undefined)
})

test('a stage that runs a workflow names it, and other stages name none', () => {
  const factory = fx('sc.note-factory') as { globalArguments: { definition: { stages: { id: string; work?: unknown }[] } } }
  factory.globalArguments.definition.stages[1].work = { mode: 'workflow', workflow: { name: 'verify-v3', passAsInputs: ['commit'] } }
  const stages = parseBoard(factory, fx('sc.note-runs'), NOTE_NOW).stages
  assert.deepEqual(stages.map((s) => [s.id, s.workflow ?? null]), [['write', null], ['check', 'verify-v3'], ['ship', null], ['done', null]])
})

test('a stage carries the description its author wrote, and a stage without one carries none', () => {
  const stages = parseBoard(fx('sc.factory'), fx('sc.runs'), NOW).stages
  assert.equal(stages.find((s) => s.id === 'plan')?.description, 'Plan the change.')
  assert.ok(!('description' in stages.find((s) => s.id === 'done')!))
  const d = parseWorkItemDetail(fx('sc.item-team-4'), NOW)
  assert.match(d.stages.find((s) => s.id === d.item.stage)?.description ?? '', /^Adversarial review of the current plan\./)
})
