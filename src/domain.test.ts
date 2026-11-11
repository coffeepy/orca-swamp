import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import {
  isLive,
  layerSteps,
  LOG_LIMIT_BYTES,
  parseApprovals,
  parseLogs,
  parseRecent,
  RUNS_LIMIT,
  parseRun,
  parseWorkflowList,
  stepKind,
  SwampFailure,
  type Run
} from './domain'
import { runLook, stepTime } from './present'

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

const rows = (run: Run) => run.jobs[0].stages.map((stage) => stage.map((s) => `${s.name}: ${s.status} ${stepTime(s, 0)}`.trim()))

test('a real finished issue-factory run reads as an eight-stage pipeline', () => {
  const run = parseRun(fx('issue-factory.def'), fx('issue-factory.run'))
  assert.equal(run.status, 'succeeded')
  assert.deepEqual(rows(run), [
    ['intake: succeeded 0.2s'],
    ['build: succeeded 0.1s'],
    ['quality-gate: succeeded 1.1s'],
    ['assert-quality: succeeded 0.0s'],
    ['adversary-audit: succeeded 0.1s'],
    ['assert-adversary: succeeded 0.0s'],
    ['human-signoff: skipped skipped'],
    ['ship: succeeded 2.4s']
  ])
})

test('parallel steps share a row and a failure shows its message', () => {
  const run = parseRun(fx('breaks.def'), fx('breaks.run-failed'))
  assert.equal(runLook(run.status).text, 'Failed')
  assert.deepEqual(rows(run), [
    ['start: succeeded 0.0s'],
    ['left: succeeded 0.0s', 'right: failed 0.0s'],
    ['join: skipped skipped']
  ])
  const right = run.jobs[0].stages[1][1]
  assert.equal(right.status === 'failed' && right.error, 'right side must hold')
})

test('a diamond DAG layers into [[a],[b,c],[d]]', () => {
  const steps = ['a', 'b', 'c', 'd'].map((name) => ({ name }))
  const deps = new Map([['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]])
  assert.deepEqual(
    layerSteps(steps, deps).map((layer) => layer.map((s) => s.name)),
    [['a'], ['b', 'c'], ['d']]
  )
})

test('a gate moves from waiting to approved-resuming to succeeded', () => {
  const suspended = parseRun(fx('gated.def'), fx('gated.run-suspended'), parseApprovals(fx('gated.approvals')))
  assert.deepEqual(rows(suspended), [
    ['prepare: succeeded 0.0s'],
    ['side-check: succeeded 0.0s', 'signoff: waiting ' + stepTime(suspended.jobs[0].stages[1][1], 0)],
    ['finish: pending']
  ])
  const gate = suspended.jobs[0].stages[1][1]
  assert.equal(gate.status === 'waiting' && gate.prompt, 'Approve to run the finish step.')
  assert.equal(isLive(suspended), false)

  const approved = parseRun(fx('gated.def'), fx('gated.run-approved'))
  assert.equal(approved.status, 'suspended')
  assert.equal(stepTime(approved.jobs[0].stages[1][1], 0), 'approved, resuming')
  assert.equal(isLive(approved), true)

  const resumed = parseRun(fx('gated.def'), fx('gated.run-resumed'))
  assert.deepEqual(rows(resumed).flat(), [
    'prepare: succeeded 0.0s',
    'side-check: succeeded 0.0s',
    'signoff: succeeded 22.3s',
    'finish: succeeded 0.0s'
  ])
  assert.equal(isLive(resumed), false)
})

test('a rejected gate shows the rejection note as its error', () => {
  const run = parseRun(fx('gated.def'), fx('gated.run-rejected'))
  const signoff = run.jobs[0].stages[1][1]
  assert.equal(run.status, 'failed')
  assert.equal(signoff.status === 'failed' && signoff.error, 'nope')
})

test('statuses swamp adds later still show, labelled with their raw name', () => {
  const run = parseRun(
    { jobs: [{ steps: [{ name: 'x', dependsOn: [] }] }] },
    { id: 'r', workflowName: 'w', status: 'exploded', jobs: [{ name: 'j', steps: [{ name: 'x', status: 'teleporting' }] }] }
  )
  assert.equal(runLook(run.status).text, 'Unknown')
  const step = run.jobs[0].stages[0][0]
  assert.equal(stepTime(step, 0), 'teleporting')
})

test('the workflow list shows each workflow with its latest run and progress', () => {
  const [wf] = parseWorkflowList(
    { results: [{ name: 'issue-factory', description: 'factory' }] },
    fx('issue-factory.history-search')
  )
  assert.equal(wf.name, 'issue-factory')
  assert.deepEqual(
    { status: wf.latest?.status, done: wf.latest?.done, total: wf.latest?.total, trigger: wf.latest?.trigger, history: wf.runs.map((r) => r.status) },
    { status: 'succeeded', done: 8, total: 8, trigger: 'manual', history: ['succeeded'] }
  )
  const names = parseWorkflowList(fx('e2e.workflow-search'), { results: [] }).map((w) => [w.name, w.latest])
  assert.deepEqual(names, [['breaks', undefined], ['gated', undefined]])
})

test("a workflow carries its own latest runs, newest first, at most ten", () => {
  const entry = (workflowName: string, day: number) => ({ workflowName, runId: `${workflowName}-${day}`, status: day % 2 ? 'failed' : 'succeeded', startedAt: `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`, inputs: { note: `n${day}` } })
  const history = { results: [...Array.from({ length: 12 }, (_, i) => entry('make-note', i + 1)), entry('other', 20)] }
  const [wf] = parseWorkflowList({ results: [{ name: 'make-note' }] }, history)
  assert.equal(wf.runs.length, 10)
  assert.deepEqual(wf.runs.slice(0, 2).map((r) => [r.runId, r.status, r.input]), [['make-note-12', 'succeeded', 'n12'], ['make-note-11', 'failed', 'n11']])
  assert.equal(wf.latest?.runId, 'make-note-12')
  assert.ok(wf.runs.every((r) => r.workflow === 'make-note'))
})

test('pending approvals become gates keyed by run id', () => {
  assert.deepEqual(parseApprovals(fx('gated.approvals')), [
    {
      workflow: 'gated',
      runId: '0fdef291-426e-4ec9-a2c0-92bc24c3a7d8',
      step: 'signoff',
      prompt: 'Approve to run the finish step.',
      since: '2026-11-07T06:14:14.508Z',
      expired: false
    }
  ])
})

test('a step log keeps only its model method lines, without ANSI escapes', () => {
  const log = parseLogs(fx('issue-factory.logs'), 'factory-builder·implement')
  const lines = log.text.split('\n')
  assert.ok(lines.length > 0)
  assert.ok(lines.every((l) => l.includes('factory-builder·implement')))
  assert.ok(!log.text.includes('\x1b'))
  assert.equal(log.truncated, false)
})

test('a long log is cut to its newest 15 KiB', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(100)}`)
  const log = parseLogs({ lines })
  assert.ok(Buffer.byteLength(log.text) <= LOG_LIMIT_BYTES)
  assert.ok(log.text.endsWith(lines[399]))
  assert.equal(log.truncated, true)
})

test('output that is not the shape swamp prints is a parse_error', () => {
  assert.throws(() => parseRun({ jobs: [] }, { jobs: 'nope' }), (e: unknown) => e instanceof SwampFailure && e.code === 'parse_error')
})

test('each step of a workflow with templated model names shows its own log lines', () => {
  const run = parseRun(fx('convert-call.def'), fx('convert-call.run'))
  const logs = fx('convert-call.logs')
  for (const step of run.jobs.flatMap((j) => j.stages.flat())) {
    const lines = parseLogs(logs, step.logTag).text.split('\n')
    const model = `fc-${run.id}-${step.name.replace('_', '-')}·execute:`
    assert.ok(lines.length >= 3 && lines.every((l) => l.includes(model)), `${step.name} shows only its own lines`)
  }
})

test('two jobs with a step of the same name each keep their own model and order', () => {
  const step = (name: string, model: string, after?: string) => ({
    name,
    dependsOn: after ? [{ step: after, condition: { type: 'succeeded' } }] : [],
    task: { type: 'model_method', modelIdOrName: model, methodName: 'execute' }
  })
  const run = parseRun(
    { jobs: [{ name: 'build', steps: [step('setup', 'b-setup'), step('check', 'b-check', 'setup')] }, { name: 'test', steps: [step('check', 't-check')] }] },
    {
      id: 'r',
      status: 'succeeded',
      jobs: [
        { name: 'build', steps: [{ name: 'setup', status: 'succeeded' }, { name: 'check', status: 'succeeded' }] },
        { name: 'test', steps: [{ name: 'check', status: 'succeeded' }] }
      ]
    }
  )
  assert.deepEqual(
    run.jobs.map((j) => j.stages.map((stage) => stage.map((s) => s.logTag))),
    [[['b-setup·execute'], ['b-check·execute']], [['t-check·execute']]]
  )
})

const parseError = (e: unknown) => e instanceof SwampFailure && e.code === 'parse_error'

test('a step or dependency that is not an object is a parse_error, not a crash', () => {
  const def = { jobs: [{ name: 'j', steps: [{ name: 'x' }] }] }
  assert.throws(() => parseRun(def, { id: 'r', jobs: [{ name: 'j', steps: [null] }] }), parseError)
  assert.throws(() => parseRun({ jobs: [{ name: 'j', steps: [{ name: 'x', dependsOn: [null] }] }] }, { id: 'r', jobs: [] }), parseError)
})

test('a run, history entry or gate without a run id is a parse_error, so no button acts on the wrong run', () => {
  assert.throws(() => parseRun({ jobs: [] }, { status: 'failed', jobs: [] }), parseError)
  assert.throws(() => parseRecent({ results: [{ workflowName: 'w', status: 'failed' }] }), parseError)
  assert.throws(() => parseApprovals({ approvals: [{ workflowName: 'w', stepName: 's' }] }), parseError)
  assert.throws(() => parseWorkflowList({ results: [{ name: 'w' }] }, { results: [{ workflowName: 'w', status: 'failed' }] }), parseError)
})

test('a timestamp that is not a date shows no time instead of NaN, and sorts after real ones', () => {
  const run = parseRun(
    { jobs: [{ name: 'j', steps: [{ name: 'x' }] }] },
    { id: 'r', status: 'running', startedAt: 'soon', jobs: [{ name: 'j', steps: [{ name: 'x', status: 'running', startedAt: 'yesterday-ish' }] }] }
  )
  assert.equal(stepTime(run.jobs[0].stages[0][0], Date.now()), '')
  assert.equal(run.startedAt, undefined)
  const [gate] = parseApprovals({ approvals: [{ runId: 'r', workflowName: 'w', stepName: 's', suspendedAt: 'garbage' }] })
  assert.equal(gate.since, undefined)
  const recent = parseRecent({
    results: [
      { runId: 'a', workflowName: 'w', startedAt: 'garbage' },
      { runId: 'b', workflowName: 'w', startedAt: '2026-11-07T02:30:13+01:00' },
      { runId: 'c', workflowName: 'w', startedAt: '2026-11-07T02:00:00.000Z' }
    ]
  })
  assert.deepEqual(recent.map((r) => [r.runId, r.startedAt]), [['c', '2026-11-07T02:00:00.000Z'], ['b', '2026-11-07T01:30:13.000Z'], ['a', '']])
})

test('a history entry keeps what the runs list filters, sorts and searches by, and the list stops at 500 runs', () => {
  const [failed, running] = parseRecent({
    results: [
      { runId: 'r1', workflowName: 'w', status: 'running', startedAt: '2026-11-07T01:00:00.000Z', inputs: { call: 'only' } },
      { runId: 'r2', workflowName: 'w', status: 'failed', startedAt: '2026-11-07T02:00:00.000Z', duration: 1500, inputs: { call: 'graphql:query:x', base: 'rest/base', budget: 0, note: '' }, failedStep: 'expose_impl', failureReason: 'exit 1' }
    ]
  })
  assert.deepEqual(failed, { workflow: 'w', runId: 'r2', status: 'failed', startedAt: '2026-11-07T02:00:00.000Z', input: 'graphql:query:x', inputs: 'rest/base 0', durationMs: 1500, failedStep: 'expose_impl' })
  assert.deepEqual(running, { workflow: 'w', runId: 'r1', status: 'running', startedAt: '2026-11-07T01:00:00.000Z', input: 'only' }, 'one input leaves no others, and a run still going has no duration')
  const many = parseRecent({ results: Array.from({ length: RUNS_LIMIT + 5 }, (_, i) => ({ runId: `r${i}`, workflowName: 'w', startedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() })) })
  assert.equal(many.length, RUNS_LIMIT)
  assert.equal(many[0].runId, `r${RUNS_LIMIT + 4}`, 'the newest runs are the ones kept')
})

test('a log whose newest line alone is over 15 KiB keeps the tail of that line', () => {
  const log = parseLogs({ lines: ['older', `${'é'.repeat(20_000)}END`] })
  assert.ok(log.text.endsWith('éEND'))
  assert.ok(Buffer.byteLength(log.text) <= LOG_LIMIT_BYTES)
  assert.ok(!log.text.includes('�'))
  assert.equal(log.truncated, true)
})

test('a step and a job carry the description their author wrote, and a step without one carries none', () => {
  const run = parseRun(fx('convert-call.def'), fx('convert-call.run'))
  assert.equal(run.jobs[0].description, 'Guide step 0')
  const prepare = run.jobs[0].stages[0][0]
  assert.equal(prepare.description, 'Create the call worktree and its local.env, regenerate the inventory and audit, confirm category convert.')
  assert.equal(prepare.kind, 'shell')

  const gated = parseRun(fx('gated.def'), fx('gated.run-suspended'))
  const steps = gated.jobs[0].stages.flat()
  assert.ok(!('description' in gated.jobs[0]))
  assert.ok(steps.every((s) => !('description' in s)))
  assert.deepEqual(steps.map((s) => [s.name, s.kind]), [['prepare', 'assert'], ['side-check', 'assert'], ['signoff', 'approval'], ['finish', 'assert']])
})

test('a step is labelled by what runs it, and a step that names an existing behavior has no label', () => {
  assert.equal(stepKind({ type: 'model_method', modelType: 'command/shell', modelName: 'x', methodName: 'execute' }), 'shell')
  assert.equal(stepKind({ type: 'behavior', behaviorType: '@coffeepy/factory-intake', methodName: 'prepare' }), 'factory-intake')
  assert.equal(stepKind({ type: 'manual_approval', prompt: 'ok?' }), 'approval')
  assert.equal(stepKind({ type: 'assert' }), 'assert')
  assert.equal(stepKind({ type: 'workflow', workflowIdOrName: 'other' }), 'workflow')
  assert.equal(stepKind({ type: 'wait_for_signal' }), 'wait for signal')
  assert.equal(stepKind({ type: 'model_method', modelIdOrName: 'lint', methodName: 'execute' }), undefined)
  assert.equal(stepKind({}), undefined)
  const run = parseRun(fx('issue-factory.def'), fx('issue-factory.run'))
  assert.ok(!('kind' in run.jobs[0].stages[0][0]))
})
