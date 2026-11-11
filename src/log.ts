// A run's log as the panel follows it. swamp appends one line per event to the run's `.log` file while the run
// moves, so the panel asks for the bytes after the offset it has read to and gets only the new lines.
import { inFlight, type RunStatus } from './domain'

export const LOG = {
  /** The newest bytes a first read answers; "Show earlier" pages back by as many. */
  firstBytes: 48 * 1024,
  /** The bytes one read after a cursor answers, when the panel names no limit. */
  chunkBytes: 128 * 1024,
  /** What a limit the panel names is clamped to. The answer must stay under Orca's 1 MiB per answer. */
  minBytes: 1024,
  maxBytes: 256 * 1024,
  /** A longer line is cut, so one line cannot fill the panel. */
  lineChars: 4000,
  /** The lines the panel keeps; the oldest go first. */
  keepLines: 3000
} as const

export type LogLevel = 'error' | 'warn' | 'info'

/**
 * One line of a run's log. `pos` is the byte offset of its start in the log file. `tag` is the `model·method` that
 * wrote it, which is a step's `logTag`.
 */
export type LogLine = { pos: number; at?: string; level: LogLevel; tag?: string; text: string }

/** What a read asks for: the lines after a byte offset, the lines that end at one, or with neither the newest lines. */
export type LogAsk = { after: number } | { before: number } | Record<string, never>

/**
 * Lines `from` to `next` of a log `size` bytes long, all three byte offsets of line starts. `done` is a run that
 * ended with nothing left to read after `next`. `reset` is a log found shorter than the cursor asked after: the lines
 * are its newest, and the lines read before no longer stand.
 */
export type LogChunk = { from: number; next: number; size: number; lines: LogLine[]; done: boolean; reset?: true }

// Colors and cursor moves (CSI), window titles and links (OSC), and the two-character escapes.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])?/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g
const clean = (s: string): string => s.replace(ANSI, '').replace(CONTROL, '')

const LEVELS: Record<string, LogLevel> = { ERR: 'error', FTL: 'error', WRN: 'warn' }

/**
 * Reads one line as swamp writes it: `2026-11-11T20:28:04.332Z [INF] model·method·run·<model>·<method>: <message>`.
 * The message is plain text or one JSON string. A line of any other shape is kept whole as text.
 */
export function parseLine(raw: string): Omit<LogLine, 'pos'> {
  const line = clean(raw)
  const head = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[([A-Z]{3})\] /.exec(line)
  if (!head) return { level: 'info', text: line.slice(0, LOG.lineChars) }
  const rest = line.slice(head[0].length)
  const source = /^(\S*·\S*?): /.exec(rest)
  let text = source ? rest.slice(source[0].length) : rest
  try {
    const unquoted = text.startsWith('"') ? JSON.parse(text) : undefined
    if (typeof unquoted === 'string') text = clean(unquoted)
  } catch {}
  const tag = source?.[1].split('·').slice(-2).join('·')
  return { at: head[1], level: LEVELS[head[2]] ?? 'info', ...(tag && { tag }), text: text.length > LOG.lineChars ? `${text.slice(0, LOG.lineChars)}…` : text }
}

/**
 * The bytes to read of a log `size` bytes long. `ragged` is a read that starts wherever the limit put it, so its
 * first line is a part of one. `reset` is a cursor past the end of the log, answered with the newest lines.
 * ponytail: a log cut and grown again past the cursor reads as appended to; swamp only appends, also on a retry.
 */
export function logWindow(size: number, ask: LogAsk, limit: number): { from: number; to: number; ragged: boolean; reset: boolean } {
  if ('before' in ask) {
    const to = Math.min(ask.before, size)
    const from = Math.max(0, to - limit)
    return { from, to, ragged: from > 0, reset: false }
  }
  if ('after' in ask && ask.after <= size) return { from: ask.after, to: Math.min(size, ask.after + limit), ragged: false, reset: false }
  const from = Math.max(0, size - limit)
  return { from, to: size, ragged: from > 0, reset: 'after' in ask }
}

/**
 * The whole lines in `bytes`, read from byte `from` of the log. A last line with no newline yet is left for the next
 * read, unless the log is `complete` there. A line longer than the read is answered in parts, so a read never stalls.
 */
export function linesOf(bytes: Uint8Array, from: number, o: { ragged: boolean; complete: boolean; limit: number }): Pick<LogChunk, 'from' | 'next' | 'lines'> {
  const text = new TextDecoder()
  const firstBreak = o.ragged ? bytes.indexOf(10) : -1
  const start = firstBreak + 1
  const lines: LogLine[] = []
  let at = start
  while (at < bytes.length) {
    const found = bytes.indexOf(10, at)
    if (found < 0 && !o.complete && !(at === 0 && bytes.length >= o.limit)) break
    const end = found < 0 ? bytes.length : found
    const raw = text.decode(bytes.subarray(at, end))
    if (raw.trim()) lines.push({ pos: from + at, ...parseLine(raw) })
    at = found < 0 ? end : end + 1
  }
  return { from: from + start, next: from + at, lines }
}

/** What one read of a run's files answers: the log's size, the status its record names, and the bytes asked for. */
export type LogRead = { size: number; status: string; bytes: Uint8Array }
/** Reads `length` bytes of a run's log from byte `from`; fewer when the log ends sooner. */
export type ReadLog = (from: number, length: number) => Promise<LogRead>

/** Answers one ask. The lines after a cursor take one read; the others need the log's size first. */
export async function readChunk(read: ReadLog, ask: LogAsk, limit: number): Promise<LogChunk> {
  let got = 'after' in ask ? await read(ask.after, limit) : await read(0, 0)
  const w = logWindow(got.size, ask, limit)
  if (!('after' in ask) || w.reset) got = await read(w.from, w.to - w.from)
  const size = Math.max(got.size, w.from + got.bytes.length)
  const ended = !inFlight(got.status as RunStatus)
  const part = linesOf(got.bytes, w.from, { ragged: w.ragged, complete: ended && w.from + got.bytes.length >= size, limit })
  return { ...part, size, done: ended && part.next >= size, ...(w.reset && { reset: true as const }) }
}

/** The lines as text to copy: each with its time, and its level when it is a warning or an error. */
export const logText = (lines: readonly LogLine[]): string =>
  lines.map((l) => [l.at, l.level === 'info' ? '' : `[${l.level}]`, l.text].filter(Boolean).join(' ')).join('\n')
