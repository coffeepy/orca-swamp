// StageCraft's JSON, parsed at the boundary: factories are models of type FACTORY_TYPE, and each
// work item's state is its `run` record, read with `swamp data query`.
import { createHash } from 'node:crypto'
import { arr, HISTORY_LENGTH, num, obj, plain, str, SwampFailure, type Json } from './domain'
import { PACE } from './pace'

export const FACTORY_TYPE = '@swamp/stagecraft/factory'
export const WORK_ITEM_TYPE = '@swamp/stagecraft/work-item'
export const STUDIO_TYPE = '@swamp/stagecraft/studio'

/** `workflow` names the swamp workflow a stage of mode `workflow` runs. */
export type Stage = { id: string; mode: string; terminal: boolean; workflow?: string; description?: string }

/** A gate on an exit; `person` is the id of a human-approval gate. */
export type ExitGate = { label: string; person?: string }
export type Exit = { name: string; to: string; manual: boolean; gates: ExitGate[] }

/** An exit only a person can open now, from the stage entry's latest `awaiting` event. */
export type HeldExit = { transition: string; to: string; manual: boolean; gateIds: string[] }

export type Expected = { stage: string; cycle: number; era: string }

/** One send of a stage's work. `workflow` names the swamp workflow a stage of mode `workflow` was sent to run. */
export type Dispatch = { id: number; mode: string; at: string; workflow?: string }

/**
 * Why a ticket is where it is, from its run record alone. Exactly one holds, and `since` is when it began to.
 * `why` is what the driver wrote when the dispatch ended; for a parked ticket, of its last dispatch.
 * `activeAt` is when the journal last recorded anything for the stage entry: the dispatch itself, or a later event.
 */
export type Reason = { since?: string } & (
  | { kind: 'gate'; gates: string[] }
  | { kind: 'parked'; count: number; limit: number; why?: string }
  | { kind: 'working'; dispatch: Dispatch; activeAt: string }
  | { kind: 'failed' | 'interrupted'; dispatch: Dispatch; why?: string }
  /** The stage's work succeeded and nothing advanced the ticket. */
  | { kind: 'passed'; dispatch: Dispatch }
  /** Nothing was sent for this stage entry. */
  | { kind: 'idle' }
  | { kind: 'done' }
)

/**
 * Where a ticket stands, for every view that colors or filters by it: waiting on a person, stuck (parked at its
 * dispatch cap, its last dispatch failed or was interrupted, or its open dispatch has shown no activity for
 * PACE.ticketQuietMs), a dispatch open now, active with none of those, or finished.
 */
export type TicketStatus = 'needs-you' | 'stuck' | 'working' | 'queued' | 'done' | 'abandoned'

const STATUS: Record<Exclude<Reason['kind'], 'done'>, TicketStatus> = {
  gate: 'needs-you',
  parked: 'stuck',
  failed: 'stuck',
  interrupted: 'stuck',
  working: 'working',
  passed: 'queued',
  idle: 'queued'
}

function statusOf(reason: Reason, stage: string, now: string): TicketStatus {
  if (reason.kind === 'done') return isAbandonStage(stage) ? 'abandoned' : 'done'
  return reason.kind === 'working' && Date.parse(now) - Date.parse(reason.activeAt) > PACE.ticketQuietMs ? 'stuck' : STATUS[reason.kind]
}

export type WorkItem = {
  key: string
  title: string
  factory: string
  status: TicketStatus
  reason: Reason
  stage: string
  cycle: number
  era: string
  /** How many times the ticket entered each stage. */
  entries: Record<string, number>
  startedAt: string
  /** When the current stage entry began, when the journal says. */
  enteredAt?: string
  /** The stage the ticket advanced from into the current entry, when the journal says. */
  from?: string
  waiting: { since: string; exits: HeldExit[] } | null
  /** Held at its dispatch cap until a person grants an override. */
  parked: { count: number; limit: number } | null
}

/** The payload swamp holds for a product: the version and digest the journal records, another one, or none. */
export type Stored = { match: 'current'; payload: unknown } | { match: 'stale'; version: number; payload: unknown } | { match: 'missing' }

export type Product = {
  name: string
  kind: 'artifact' | 'evidence'
  version: number
  at: string
  summary: string
  stored: Stored
  /** A gate on an exit waiting for a person reads it, or reads a review of it. */
  forGate: boolean
}
export type JournalLine = { at: string; stage: string; cycle: number; text: string }

export type WorkItemDetail = {
  item: WorkItem
  /** The factory's stages before the terminal ones, the columns of the ticket's grid row. */
  stages: Stage[]
  /** The current stage's exits, from the definition the work item pinned at start. */
  exits: Exit[]
  products: Product[]
  /** Newest first. */
  timeline: JournalLine[]
  metrics: { totalMs: number; reviewRounds: number; dispatches: number }
}

/** `tickets` is the status of its latest tickets by start, oldest first, at most HISTORY_LENGTH. */
export type FactorySummary = { name: string; tickets: TicketStatus[]; needYou: number }
/** `skipped` counts the tickets left out because their run record is of a schemaVersion this panel does not read. */
export type Factories = { installed: false } | { installed: true; factories: FactorySummary[]; studio?: string; skipped?: number }
export type Board = { factory: string; stages: Stage[]; items: WorkItem[]; skipped?: number }

/** Keys and factory names go into query predicates, so only plain names cross. */
export function safeName(name: string, what: string): string {
  if (!/^[\w.@/-]+$/.test(name)) throw new SwampFailure('swamp_error', `${what} '${name}' is not a plain name`)
  return name
}

export const runsQuery = (factory?: string): string =>
  `modelType == "${WORK_ITEM_TYPE}" && name == "run"` + (factory ? ` && attributes.factory == "${safeName(factory, 'factory')}"` : '')

export const itemQuery = (key: string): string =>
  `modelType == "${WORK_ITEM_TYPE}" && modelName == "${safeName(key, 'work item')}" && !name.startsWith("report-")`

const results = (raw: unknown, what: string): Json[] => arr(obj(raw, what).results, `${what}.results`).map((r) => obj(r, what))

/** Whether `swamp model type search stagecraft` found StageCraft's model types in this repo. */
export const hasStagecraft = (typeSearch: unknown): boolean =>
  results(typeSearch, 'type search').some((t) => t.normalized === FACTORY_TYPE || t.raw === FACTORY_TYPE)

export const modelsOfType = (modelSearch: unknown, type: string): string[] =>
  results(modelSearch, 'model search')
    .filter((m) => m.type === type)
    .map((m) => str(m.name) ?? '?')
    .sort()

type Run = Json & { journal: Json[] }

/** The run record formats this panel reads; StageCraft itself refuses a record of any other version rather than guess.
 * Version 2 only renames dispatch work mode `method` to `behavior`, a field the panel does not read. */
const RUN_SCHEMA_VERSIONS = [1, 2]

const findLast = <T,>(xs: T[], f: (x: T) => boolean): T | undefined => [...xs].reverse().find(f)

const lastAt = (run: Run): string => str(run.journal.at(-1)?.at) ?? ''

/**
 * The latest run record of each key; a key made twice keeps the one that changed last, as the studio does.
 * A record of another schemaVersion is refused, or counted in `skipped` when a list gives one, so one ticket does not hide the others.
 */
function latestRuns(query: unknown, skipped?: { count: number }): Run[] {
  const byKey = new Map<string, Run>()
  for (const r of results(query, 'data query')) {
    const run = obj(r.content, 'run record') as Run
    if (!RUN_SCHEMA_VERSIONS.includes(run.schemaVersion as number)) {
      if (skipped) {
        skipped.count++
        continue
      }
      throw new SwampFailure(
        'parse_error',
        `work item ${String(run.key ?? r.modelName)} has a run record of schemaVersion ${run.schemaVersion}, and this panel reads ${RUN_SCHEMA_VERSIONS.join(' and ')}. Update Swampling or StageCraft so they match.`
      )
    }
    run.journal = arr(run.journal, 'run.journal').map((e) => obj(e, 'journal event'))
    const key = str(run.key) ?? '?'
    const held = byKey.get(key)
    if (!held || lastAt(run) > lastAt(held)) byKey.set(key, run)
  }
  return [...byKey.values()].sort((a, b) => String(a.key).localeCompare(String(b.key), undefined, { numeric: true }))
}

// ponytail: a terminal stage whose id says "abandon" is an abandoned ticket; the definition marks no outcome.
export const isAbandonStage = (stage: string): boolean => /abandon/i.test(stage)

const cycleOf = (run: Json): number => num((run.entries as Json | undefined)?.[String(run.stage)]) ?? 1

/** The journal of the current stage entry (same era, stage and cycle), oldest first. */
const entryEvents = (run: Run): Json[] => run.journal.filter((e) => e.era === run.era && e.stage === run.stage && e.cycle === cycleOf(run))

function entered(run: Run): { at?: string; from?: string } {
  const era = run.journal.filter((e) => e.era === run.era)
  const advanced = findLast(era, (e) => e.type === 'advanced' && e.to === run.stage && e.toCycle === cycleOf(run))
  return { at: str(advanced?.at) ?? (cycleOf(run) === 1 ? str(era[0]?.at) : undefined), from: str(advanced?.stage) }
}

/** The one reason a ticket is where it is. `parkedAt` is when the `awaiting` event that parked it was written. */
function reasonOf(run: Run, waiting: WorkItem['waiting'], parked: WorkItem['parked'], parkedAt: string | undefined, enteredAt: string | undefined): Reason {
  if (run.status === 'terminal') return { kind: 'done', since: enteredAt }
  if (waiting) return { kind: 'gate', since: waiting.since, gates: [...new Set(waiting.exits.flatMap((x) => x.gateIds))] }
  const events = entryEvents(run)
  const sent = findLast(events, (e) => e.type === 'dispatched')
  const ended = sent && events.find((e) => e.type === 'outcome' && e.dispatchId === sent.dispatchId)
  // The journal says when and how; only the dispatch record holds the mode, the workflow and the driver's reason.
  const record = arr(run.dispatches ?? [], 'run.dispatches').find((d) => sent && (d as Json | null)?.id === sent.dispatchId) as Json | undefined
  const why = str((record?.outcome as Json | undefined)?.reason)
  if (parked) return { kind: 'parked', since: parkedAt, ...parked, ...(why && { why }) }
  if (!sent) return { kind: 'idle', since: enteredAt }
  const workflow = str(record?.workflow)
  const dispatch: Dispatch = { id: num(sent.dispatchId) ?? 0, mode: str(record?.mode) ?? '', at: str(sent.at) ?? '', ...(workflow && { workflow }) }
  if (!ended) return { kind: 'working', since: dispatch.at, dispatch, activeAt: str(events.at(-1)?.at) ?? dispatch.at }
  if (ended.outcome === 'succeeded') return { kind: 'passed', since: str(ended.at), dispatch }
  return { kind: ended.outcome === 'interrupted' ? 'interrupted' : 'failed', since: str(ended.at), dispatch, ...(why && { why }) }
}

function workItem(run: Run, now: string): WorkItem {
  const awaiting = run.status === 'active' ? findLast(entryEvents(run), (e) => e.type === 'awaiting') : undefined
  const held = arr(awaiting?.exits ?? [], 'awaiting.exits')
    .map((x) => obj(x, 'awaiting exit'))
    .filter((x) => (str(x.readyAt) ?? str(awaiting!.at)!) <= now)
  const hold = awaiting?.dispatchOverride as Json | undefined
  const grantedSince = hold && entryEvents(run).some((e) => e.type === 'override' && str(e.at)! > str(awaiting!.at)!)
  const parked = hold && !grantedSince ? { count: num(hold.count) ?? 0, limit: num(hold.limit) ?? 0 } : null
  const stage = str(run.stage) ?? '?'
  const { at, from } = entered(run)
  const waiting: WorkItem['waiting'] = held.length
    ? {
        since: held.map((x) => str(x.readyAt) ?? str(awaiting!.at)!).sort()[0],
        exits: held.map((x) => ({
          transition: str(x.transition) ?? '?',
          to: str(x.to) ?? '?',
          manual: x.manual === true,
          gateIds: arr(x.gateIds ?? [], 'gateIds').map(String)
        }))
      }
    : null
  const reason = reasonOf(run, waiting, parked, str(awaiting?.at), at)
  return {
    key: str(run.key) ?? '?',
    title: str(run.title) ?? str(run.key) ?? '?',
    factory: str(run.factory) ?? '?',
    status: statusOf(reason, stage, now),
    reason,
    stage,
    cycle: cycleOf(run),
    era: str(run.era) ?? '',
    entries: Object.fromEntries(Object.entries((run.entries ?? {}) as Json).flatMap(([k, v]) => (typeof v === 'number' ? [[k, v]] : []))),
    startedAt: str(run.journal[0]?.at) ?? '',
    enteredAt: at,
    from,
    waiting,
    parked
  }
}

export const parseWorkItems = (query: unknown, now: string): WorkItem[] => plain(latestRuns(query).map((r) => workItem(r, now)))

/** The work items held for a person now. A run record of a version this panel does not read is left out, so it does not hide the others. */
export const waitingItems = (query: unknown, now: string): WorkItem[] =>
  plain(latestRuns(query, { count: 0 }).map((r) => workItem(r, now)).filter((i) => i.status === 'needs-you'))

export function parseFactories(typeSearch: unknown, modelSearch: unknown, runs: unknown, now: string): Factories {
  if (!hasStagecraft(typeSearch)) return { installed: false }
  const skipped = { count: 0 }
  const items = latestRuns(runs, skipped).map((r) => workItem(r, now))
  return plain({
    installed: true,
    ...(skipped.count && { skipped: skipped.count }),
    factories: modelsOfType(modelSearch, FACTORY_TYPE).map((name) => {
      const mine = items.filter((i) => i.factory === name).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      return { name, tickets: mine.slice(-HISTORY_LENGTH).map((i) => i.status), needYou: mine.filter((i) => i.status === 'needs-you').length }
    }),
    studio: modelsOfType(modelSearch, STUDIO_TYPE)[0]
  })
}

type Definition = { stages: Json[] }

function definitionOf(raw: unknown, what: string): Definition {
  const d = obj(raw, what)
  return { stages: arr(d.stages, `${what}.stages`).map((s) => obj(s, 'stage')) }
}

const stagesOf = (def: Definition): Stage[] =>
  def.stages.map((s) => {
    const work = (s.work ?? {}) as Json
    const mode = str(work.mode) ?? ''
    const workflow = mode === 'workflow' ? str((work.workflow as Json | undefined)?.name) : undefined
    const description = str(s.description)?.trim()
    return { id: str(s.id) ?? '?', mode, terminal: s.terminal === true, ...(workflow && { workflow }), ...(description && { description }) }
  })

/** The board from `swamp model get <factory>` and the factory's run records. */
export function parseBoard(factoryModel: unknown, runs: unknown, now: string): Board {
  const model = obj(factoryModel, 'factory model')
  const def = definitionOf(obj(model.globalArguments, 'factory.globalArguments').definition, 'factory definition')
  const factory = str(model.name) ?? '?'
  const skipped = { count: 0 }
  const items = latestRuns(runs, skipped).map((r) => workItem(r, now)).filter((i) => i.factory === factory)
  return plain({ factory, stages: stagesOf(def), items, ...(skipped.count && { skipped: skipped.count }) })
}

function gateLabel(g: Json): ExitGate {
  const type = str(g.type) ?? '?'
  const c = (g.config ?? {}) as Json
  const blocking = Array.isArray(c.blocking) ? c.blocking.join(',') : undefined
  const subject = blocking ?? str(c.artifact) ?? str(c.id) ?? str(c.name) ?? str(c.stage)
  return { label: subject ? `${type} ${subject}` : type, person: type === 'human-approval' ? str(c.id) : undefined }
}

const exitOf = (t: Json): Exit => ({
  name: str(t.name) ?? '?',
  to: str(t.to) ?? '?',
  manual: t.manual === true,
  gates: arr(t.gates ?? [], 'transition.gates').map((g) => gateLabel(obj(g, 'gate')))
})

function productSummary(kind: 'artifact' | 'evidence', version: number, payload: Json | undefined): string {
  const findings = Array.isArray(payload?.findings) ? (payload.findings as (Json | null)[]).filter((f): f is Json => f !== null && typeof f === 'object' && f.resolved !== true) : undefined
  if (findings) {
    const count = (sev: string) => findings.filter((f) => f.severity === sev).length
    const high = count('critical') + count('high')
    return ['findings', `${high} high`, count('medium') ? `${count('medium')} medium` : '', `${count('low')} low`].filter(Boolean).join(' · ')
  }
  const steps = Array.isArray(payload?.steps) ? ` · ${payload.steps.length} step${payload.steps.length === 1 ? '' : 's'}` : ''
  return `${kind}${steps} · v${version}`
}

function journalText(e: Json): string {
  switch (e.type) {
    case 'started':
      return `started in ${e.factory}`
    case 'recorded':
      return `recorded ${e.kind} ${e.name} v${e.version}`
    case 'rejected':
      return `rejected ${e.kind} ${e.name}: ${arr(e.errors ?? [], 'errors').join('; ')}`
    case 'approval':
      return `${e.decision === 'approve' ? 'approved' : 'declined'} ${e.gateId}`
    case 'advanced':
      return `${e.transition} → ${e.to}`
    case 'awaiting': {
      const ids = arr(e.exits ?? [], 'exits').flatMap((x) => arr(obj(x, 'exit').gateIds ?? [], 'gateIds'))
      return e.dispatchOverride ? 'parked at its dispatch cap' : ids.length ? `waiting on ${ids.join(', ')}` : 'no longer waiting on a person'
    }
    case 'dispatched':
      return `dispatch ${e.dispatchId}`
    case 'outcome':
      return `dispatch ${e.dispatchId} ${e.outcome}`
    case 'override':
      return `${e.kind} override for ${e.for}`
    default:
      return String(e.type)
  }
}

type ProductRef = { kind: 'artifact' | 'evidence'; name: string; version: number; digest: string; at: string; subject?: string }

const recordName = (p: { kind: string; name: string }): string => `${p.kind}-${p.name}`

/** Each product the run record names, at the version and digest its journal recorded. */
function productRefs(run: Json): ProductRef[] {
  const products = (run.products ?? {}) as Json
  return (['artifact', 'evidence'] as const).flatMap((kind) =>
    Object.entries((products[kind === 'artifact' ? 'artifacts' : 'evidence'] ?? {}) as Record<string, Json>).map(([name, ref]) => ({
      kind,
      name,
      version: num(ref.version) ?? 0,
      digest: str(ref.digest) ?? '',
      at: str(ref.at) ?? '',
      subject: str((ref.subject as Json | undefined)?.name)
    }))
  )
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Json)[k])]))
      : v

/** SHA-256 over JSON with sorted keys and no whitespace, as StageCraft digests a payload. */
export const digestOf = (v: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex')}`

/**
 * The item query answers each record's latest version only. When a product's latest stored version is not the one
 * the journal recorded, this predicate fetches the recorded versions; undefined when every one is already there.
 */
export function olderPayloadsQuery(key: string, query: unknown): string | undefined {
  const records = results(query, 'data query')
  const run = records.find((r) => r.name === 'run')
  if (!run) return undefined
  const wanted = productRefs(obj(run.content, 'run record')).filter(
    (p) => Number.isInteger(p.version) && records.find((r) => r.name === recordName(p))?.version !== p.version
  )
  if (!wanted.length) return undefined
  const names = wanted.map((p) => `(name == "${safeName(recordName(p), 'product')}" && version == ${p.version})`)
  return `modelType == "${WORK_ITEM_TYPE}" && modelName == "${safeName(key, 'work item')}" && (${names.join(' || ')})`
}

function storedOf(p: ProductRef, records: Json[]): Stored {
  const mine = records.filter((r) => r.name === recordName(p))
  const exact = mine.find((r) => r.version === p.version)
  if (exact && digestOf(exact.content) === p.digest) return { match: 'current', payload: exact.content }
  const other = exact ?? mine.sort((a, b) => (num(b.version) ?? 0) - (num(a.version) ?? 0))[0]
  return other ? { match: 'stale', version: num(other.version) ?? 0, payload: other.content } : { match: 'missing' }
}

/** The products named by the gates of exits a person holds open now, with what each reviews. */
function gateReads(stage: Json | undefined, held: readonly string[], refs: readonly ProductRef[]): Set<string> {
  const reads = new Set<string>()
  for (const t of arr(stage?.transitions ?? [], 'stage.transitions').map((x) => obj(x, 'transition'))) {
    if (!held.includes(str(t.name) ?? '')) continue
    for (const g of arr(t.gates ?? [], 'transition.gates').map((x) => obj(x, 'gate'))) {
      const c = (g.config ?? {}) as Json
      const name = str(c.artifact) ?? (g.type === 'evidence-recorded' ? str(c.name) : undefined)
      if (name) reads.add(name)
    }
  }
  for (const r of refs) if (reads.has(r.name) && r.subject) reads.add(r.subject)
  return reads
}

/**
 * One work item from `swamp data query 'modelName == "<key>"'`: its run, pinned definition, products and metrics.
 * `older` answers `olderPayloadsQuery`, when it asked for anything.
 */
export function parseWorkItemDetail(query: unknown, now: string, older?: unknown): WorkItemDetail {
  const records = [...results(query, 'data query'), ...(older ? results(older, 'older payloads') : [])]
  const named = (name: string) => records.find((r) => r.name === name)
  const runRecord = named('run')
  if (!runRecord) throw new SwampFailure('swamp_error', 'this work item has no run record')
  const [run] = latestRuns({ results: [runRecord] })
  const item = workItem(run, now)
  const pinned = named('definition')
  const def = pinned ? definitionOf(obj(pinned.content, 'pinned definition').definition, 'pinned definition') : { stages: [] }
  const stage = def.stages.find((s) => s.id === item.stage)
  const refs = productRefs(run)
  const reads = gateReads(stage, item.waiting?.exits.map((x) => x.transition) ?? [], refs)
  const productList: Product[] = refs.map((p) => {
    const stored = storedOf(p, records)
    const payload = stored.match === 'current' ? (stored.payload as Json) : undefined
    return { name: p.name, kind: p.kind, version: p.version, at: p.at, summary: productSummary(p.kind, p.version, payload), stored, forGate: reads.has(p.name) }
  })
  const metrics = (obj(named('metrics')?.content ?? {}, 'metrics').summary ?? {}) as Json
  const rounds = Object.values(((metrics.rework as Json | undefined)?.reviewRounds ?? {}) as Record<string, Json>)
  const ended = run.status === 'terminal' ? lastAt(run) : now
  return plain({
    item,
    stages: stagesOf(def).filter((s) => !s.terminal),
    exits: arr(stage?.transitions ?? [], 'stage.transitions').map((t) => exitOf(obj(t, 'transition'))),
    products: productList.sort((a, b) => a.at.localeCompare(b.at)),
    timeline: run.journal
      .filter((e) => e.type !== 'usage' && e.type !== 'checkpoint')
      .map((e) => ({ at: str(e.at) ?? '', stage: str(e.stage) ?? '', cycle: num(e.cycle) ?? 1, text: journalText(e) }))
      .reverse(),
    metrics: {
      totalMs: Math.max(0, Date.parse(ended) - Date.parse(item.startedAt)),
      reviewRounds: rounds.reduce((n, r) => n + (num(r.rounds) ?? 0), 0),
      dispatches: num((metrics.dispatches as Json | undefined)?.count) ?? 0
    }
  })
}

export const expectedOf = (item: WorkItem): Expected => ({ stage: item.stage, cycle: item.cycle, era: item.era })

/** The URL `studio serve` logs, once it is listening. */
export const studioUrl = (output: string): string | undefined => /studio: (https?:\/\/\S+)/.exec(output)?.[1]
