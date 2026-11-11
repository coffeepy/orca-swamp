// Whether a run in flight is healthy: how long it took so far against how long its workflow usually takes, and
// how long it has shown no activity. Every threshold of that question, for runs and tickets, is in PACE.
import { inFlight, type RecentRun, type RunStatus, type Vitals } from './domain'

export const PACE = {
  /** The succeeded runs a workflow needs before it has a usual time. */
  minSample: 3,
  /** The usual time is the median of this many of its newest succeeded runs, so it follows a workflow that changed. */
  sample: 20,
  /** A run reads "longer than usual" once it took this many usual times. */
  slowFactor: 2,
  /** A run reads "no activity" after its workflow's usual time without any, and never sooner than this. */
  quietMinMs: 10 * 60_000,
  /** A working ticket reads "no activity", and counts as stuck, after this long without a journal event. */
  ticketQuietMs: 2 * 3_600_000
} as const

/**
 * How a run in flight is doing. `quietMs` is how long since its record or log last changed, when that is known.
 * `gone` is a run swamp lists as running whose swamp process no longer exists; `quiet` is not a failure: a long step
 * that writes nothing reads the same.
 */
export type Pace = { elapsedMs: number; usualMs?: number; quietMs?: number; state: 'on-pace' | 'slow' | 'quiet' | 'gone' }

/** The usual time of durations given newest first: their median, or none for fewer than PACE.minSample. */
export function usualMs(durations: readonly number[]): number | undefined {
  const d = durations.slice(0, PACE.sample).sort((a, b) => a - b)
  if (d.length < PACE.minSample) return undefined
  const mid = d.length >> 1
  return d.length % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2
}

/**
 * Each workflow's usual time, from its succeeded runs in `runs`, newest first.
 * ponytail: a run that failed and was retried to success counts with its wait included, since swamp's list does not
 * mark it; the median absorbs a few. Read `ownerBeforeResume` from the run files if they skew a workflow.
 */
export function usualTimes(runs: readonly RecentRun[]): Map<string, number> {
  const durations = new Map<string, number[]>()
  for (const r of runs) {
    if (r.status !== 'succeeded' || r.durationMs === undefined) continue
    ;(durations.get(r.workflow) ?? durations.set(r.workflow, []).get(r.workflow)!).push(r.durationMs)
  }
  const usual = new Map<string, number>()
  for (const [workflow, d] of durations) {
    const ms = usualMs(d)
    if (ms !== undefined) usual.set(workflow, ms)
  }
  return usual
}

/** The pace of a running or pending run at `now`; none for a run that is not in flight or has no start time. */
export function paceOf(run: { status: RunStatus; startedAt?: string } & Vitals, usual: number | undefined, now: number): Pace | undefined {
  const started = Date.parse(run.startedAt ?? '')
  if (!inFlight(run.status) || Number.isNaN(started)) return undefined
  const elapsedMs = Math.max(0, now - started)
  const active = Date.parse(run.activeAt ?? '')
  const quietMs = Number.isNaN(active) ? undefined : Math.max(0, now - active)
  const state = run.gone
    ? 'gone'
    : quietMs !== undefined && quietMs > Math.max(PACE.quietMinMs, usual ?? 0)
      ? 'quiet'
      : usual !== undefined && elapsedMs > usual * PACE.slowFactor
        ? 'slow'
        : 'on-pace'
  return { elapsedMs, ...(usual !== undefined && { usualMs: usual }), ...(quietMs !== undefined && { quietMs }), state }
}
