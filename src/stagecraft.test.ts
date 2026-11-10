import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { cellsOf, storedNote, ticketWhen } from './present'
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

test('the line under a ticket says how long it waited, how many tries it used, or which try it is on', () => {
  const at = (key: string) => ticketWhen(notes().items.find((i) => i.key === key)!, Date.parse(NOTE_NOW))
  assert.equal(at('note-2'), '2nd try')
  assert.equal(at('note-6'), '2 of 2 tries')
  assert.match(at('note-3'), /^\d+m$/)
})

test('a stage that runs a workflow names it, and other stages name none', () => {
  const factory = fx('sc.note-factory') as { globalArguments: { definition: { stages: { id: string; work?: unknown }[] } } }
  factory.globalArguments.definition.stages[1].work = { mode: 'workflow', workflow: { name: 'verify-v3', passAsInputs: ['commit'] } }
  const stages = parseBoard(factory, fx('sc.note-runs'), NOTE_NOW).stages
  assert.deepEqual(stages.map((s) => [s.id, s.workflow ?? null]), [['write', null], ['check', 'verify-v3'], ['ship', null], ['done', null]])
})
