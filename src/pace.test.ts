import { assert, test } from 'orca/testing'
import type { RecentRun, RunId } from './domain'
import { PACE, paceOf, usualMs, usualTimes } from './pace'
import { PACE_LOOK, paceLabel, paceProgress, paceRow } from './present'

const MIN = 60_000
const START = '2026-11-11T10:00:00.000Z'
const at = (ms: number): number => Date.parse(START) + ms
const iso = (ms: number): string => new Date(at(ms)).toISOString()

test('the usual time is the median, and fewer than three runs give none', () => {
  assert.equal(usualMs([]), undefined)
  assert.equal(usualMs([5 * MIN, 7 * MIN]), undefined)
  assert.equal(usualMs([9 * MIN, 5 * MIN, 6 * MIN]), 6 * MIN)
  assert.equal(usualMs([4 * MIN, 8 * MIN, 6 * MIN, 5 * MIN]), 5.5 * MIN)
})

test('one run that took days does not move the usual time', () => {
  assert.equal(usualMs([6 * MIN, 5 * MIN, 4000 * MIN, 7 * MIN, 6 * MIN]), 6 * MIN)
})

test('the usual time follows the newest runs, so a workflow that got slower is not held to its old time', () => {
  const durations = [...Array(PACE.sample).fill(10 * MIN), ...Array(50).fill(1 * MIN)]
  assert.equal(usualMs(durations), 10 * MIN)
})

const past = (workflow: string, status: RecentRun['status'], durationMs?: number): RecentRun => ({ workflow, runId: 'r' as RunId, status, startedAt: START, durationMs })

test('each workflow gets its own usual time from its passed runs only', () => {
  const usual = usualTimes([
    past('build', 'succeeded', 6 * MIN),
    past('build', 'failed', 1 * MIN),
    past('build', 'succeeded', 4 * MIN),
    past('build', 'cancelled', 90 * MIN),
    past('build', 'succeeded', 5 * MIN),
    past('build', 'succeeded'),
    past('ship', 'succeeded', 2 * MIN),
    past('ship', 'succeeded', 2 * MIN),
    past('ship', 'failed', 2 * MIN)
  ])
  assert.deepEqual([...usual], [['build', 5 * MIN]])
})

const running = (more: object = {}) => ({ status: 'running' as const, startedAt: START, ...more })

test('a run within its usual time is on pace and reads how far along it is', () => {
  const p = paceOf(running(), 6 * MIN, at(2 * MIN))!
  assert.deepEqual(p, { elapsedMs: 2 * MIN, usualMs: 6 * MIN, state: 'on-pace' })
  assert.equal(paceProgress(p), '2m of about 6m')
  assert.equal(paceRow(p), '2m of about 6m')
  assert.equal(paceLabel(p), undefined)
})

test('a workflow with no usual time shows the elapsed time alone and is never called slow', () => {
  const p = paceOf(running(), undefined, at(600 * MIN))!
  assert.equal(p.state, 'on-pace')
  assert.equal(paceProgress(p), '10h 0m')
})

test('a run reads "longer than usual" only past a clear margin over the usual time', () => {
  assert.equal(paceOf(running(), 6 * MIN, at(6 * MIN * PACE.slowFactor))!.state, 'on-pace')
  const p = paceOf(running(), 6 * MIN, at(6 * MIN * PACE.slowFactor + 1000))!
  assert.equal(p.state, 'slow')
  assert.equal(paceLabel(p), 'longer than usual')
  assert.equal(paceRow(p), '12m of about 6m')
  assert.equal(PACE_LOOK.slow.tone, 'warm')
})

test('a run with no activity for longer than the floor reads "no activity", and never "failed"', () => {
  const still = paceOf(running({ activeAt: iso(1 * MIN) }), undefined, at(1 * MIN + PACE.quietMinMs))!
  assert.equal(still.state, 'on-pace')
  const p = paceOf(running({ activeAt: iso(1 * MIN) }), undefined, at(13 * MIN))!
  assert.deepEqual(p, { elapsedMs: 13 * MIN, quietMs: 12 * MIN, state: 'quiet' })
  assert.equal(paceRow(p), 'no activity for 12m')
  assert.ok(!/fail|dead/.test(paceLabel(p)! + PACE_LOOK.quiet.hint))
})

test('a long quiet step of a workflow that usually takes hours is not called quiet until it is quiet for longer than the usual time', () => {
  const usual = 120 * MIN
  assert.equal(paceOf(running({ activeAt: iso(5 * MIN) }), usual, at(100 * MIN))!.state, 'on-pace')
  assert.equal(paceOf(running({ activeAt: iso(5 * MIN) }), usual, at(126 * MIN))!.state, 'quiet')
})

test('quiet outranks slow, and a run that is active stays slow however long it takes', () => {
  assert.equal(paceOf(running({ activeAt: iso(1 * MIN) }), 2 * MIN, at(30 * MIN))!.state, 'quiet')
  assert.equal(paceOf(running({ activeAt: iso(29 * MIN) }), 2 * MIN, at(30 * MIN))!.state, 'slow')
})

test('a run whose process is gone says so whatever else holds', () => {
  const p = paceOf(running({ activeAt: iso(0), gone: true as const }), 6 * MIN, at(1 * MIN))!
  assert.equal(p.state, 'gone')
  assert.equal(paceRow(p), 'its process is gone')
  assert.match(PACE_LOOK.gone.hint!, /Stop it/)
})

test('only a run in flight has a pace', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', 'suspended', 'interrupted', 'unknown'] as const) {
    assert.equal(paceOf({ status, startedAt: START, gone: true }, 6 * MIN, at(MIN)), undefined)
  }
  assert.equal(paceOf({ status: 'pending', startedAt: START }, 6 * MIN, at(MIN))!.state, 'on-pace')
  assert.equal(paceOf({ status: 'running', startedAt: '' }, 6 * MIN, at(MIN)), undefined)
})

test('a clock behind the run reads as zero elapsed, never negative', () => {
  assert.deepEqual(paceOf(running({ activeAt: iso(MIN) }), undefined, at(-5 * MIN)), { elapsedMs: 0, quietMs: 0, state: 'on-pace' })
})
