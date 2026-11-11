import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { LOG, logText, parseLine, readChunk, type LogAsk, type LogChunk, type ReadLog } from './log'
import { parseRemoteLog, remoteLogScript } from './swamp'

const stamp = (n: number): string => `2026-11-11T10:00:${String(n % 60).padStart(2, '0')}.000Z`
const line = (n: number, text = `tick ${n}`, model = 'bake-mix'): string => `${stamp(n)} [INF] model·method·run·${model}·execute: ${text}\n`

/** A log file that grows, and a reader of it that counts its reads. */
function fakeLog(text = '', status = 'running') {
  const file = { bytes: Buffer.from(text), status, reads: 0 }
  const read: ReadLog = async (from, length) => {
    file.reads++
    return { size: file.bytes.length, status: file.status, bytes: file.bytes.subarray(from, from + length) }
  }
  const ask = (a: LogAsk = {}, limit: number = LOG.chunkBytes): Promise<LogChunk> => readChunk(read, a, limit)
  const add = (more: string) => void (file.bytes = Buffer.concat([file.bytes, Buffer.from(more)]))
  return { file, ask, add }
}
const texts = (c: LogChunk): string[] => c.lines.map((l) => l.text)

test('a log line is read as swamp writes it: time, level, the model and method that wrote it, and the message', () => {
  assert.deepEqual(parseLine('2026-11-11T10:00:01.250Z [INF] model·method·run·bake-mix·execute: flour: 2 cups'), {
    at: '2026-11-11T10:00:01.250Z',
    level: 'info',
    tag: 'bake-mix·execute',
    text: 'flour: 2 cups'
  })
  assert.equal(parseLine('2026-11-11T10:00:02.000Z [WRN] model·method·run·bake-mix·execute: oven is cold').level, 'warn')
  assert.equal(parseLine('2026-11-11T10:00:02.000Z [ERR] model·method·run·bake-mix·execute: oven is off').level, 'error')
  assert.equal(parseLine('2026-11-11T10:00:02.000Z [FTL] model·method·run·bake-mix·execute: no oven').level, 'error')
})

test('color codes and other escape bytes never reach the panel, also inside a quoted message', () => {
  assert.equal(parseLine('2026-11-11T10:00:01.000Z [INF] model·method·run·bake-mix·execute: \x1b[32mrisen\x1b[0m in \x1b[1;31m9m\x1b[0m').text, 'risen in 9m')
  const quoted = `2026-11-11T10:00:01.000Z [INF] model·method·run·bake-mix·execute: ${JSON.stringify('\x1b[0m\x1b[32mdone\x1b[0m\r "well"')}`
  assert.equal(parseLine(quoted).text, 'done "well"')
  assert.equal(parseLine('\x1b]0;window title\x07plain\x1b').text, 'plain')
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(parseLine('a\x00b\x1b[2Kc\x7f\x1b').text))
})

test('a line of another shape is kept whole, a message that only looks quoted is kept as written, and a huge line is cut', () => {
  assert.deepEqual(parseLine('Traceback: something else'), { level: 'info', text: 'Traceback: something else' })
  assert.deepEqual(parseLine('2026-11-11T10:00:01.000Z [INF] no source here: just text'), { at: '2026-11-11T10:00:01.000Z', level: 'info', text: 'no source here: just text' })
  assert.equal(parseLine('2026-11-11T10:00:01.000Z [INF] model·method·run·bake-mix·execute: "half open').text, '"half open')
  assert.equal(parseLine(line(1, 'x'.repeat(LOG.lineChars + 50)).trimEnd()).text.length, LOG.lineChars + 1)
})

test('each read after the cursor answers only the lines appended since, and the cursor moves past them', async () => {
  const log = fakeLog(line(1) + line(2))
  const first = await log.ask()
  assert.deepEqual(texts(first), ['tick 1', 'tick 2'])
  assert.deepEqual([first.from, first.next, first.done], [0, log.file.bytes.length, false])
  const idle = await log.ask({ after: first.next })
  assert.deepEqual([idle.lines, idle.next], [[], first.next])
  log.add(line(3) + line(4))
  log.file.reads = 0
  const second = await log.ask({ after: first.next })
  assert.deepEqual(texts(second), ['tick 3', 'tick 4'])
  assert.equal(second.lines[0].pos, first.next, 'a line knows the byte it starts at')
  assert.equal(second.next, log.file.bytes.length)
  assert.equal(log.file.reads, 1, 'following costs one read')
})

test('a line still being written waits for its newline, and is read once the run ended', async () => {
  const log = fakeLog(line(1) + line(2).slice(0, -8))
  const first = await log.ask()
  assert.deepEqual(texts(first), ['tick 1'])
  assert.equal(first.next, Buffer.byteLength(line(1)))
  log.add(line(2).slice(-8))
  assert.deepEqual(texts(await log.ask({ after: first.next })), ['tick 2'])
  const cut = fakeLog(line(1) + 'no newline at the end', 'failed')
  const all = await cut.ask()
  assert.deepEqual(texts(all), ['tick 1', 'no newline at the end'])
  assert.equal(all.done, true)
})

test('done is a run that ended and was read to its end', async () => {
  const many = Array.from({ length: 40 }, (_, i) => line(i)).join('')
  const log = fakeLog(many, 'succeeded')
  const part = await log.ask({ after: 0 }, 1024)
  assert.equal(part.done, false, 'more is left to read')
  let chunk = part
  while (chunk.next < chunk.size) chunk = await log.ask({ after: chunk.next }, 1024)
  assert.equal(chunk.done, true)
  assert.equal((await fakeLog(line(1), 'running').ask()).done, false)
  assert.equal((await fakeLog(line(1), 'pending').ask()).done, false)
  assert.equal((await fakeLog('', 'cancelled').ask()).done, true, 'a run that ended without a line')
})

test('a backlog larger than one answer arrives over several reads with no line lost or read twice', async () => {
  const log = fakeLog(Array.from({ length: 200 }, (_, i) => line(i)).join(''))
  const seen: string[] = []
  let cursor = 0
  for (let reads = 0; cursor < log.file.bytes.length; reads++) {
    assert.ok(reads < 50, 'the cursor keeps moving')
    const chunk = await log.ask({ after: cursor }, 2000)
    assert.ok(chunk.next - cursor <= 2000, 'no answer reads past its limit')
    seen.push(...texts(chunk))
    cursor = chunk.next
  }
  assert.deepEqual(seen, Array.from({ length: 200 }, (_, i) => `tick ${i}`))
})

test('the first read answers the newest lines, and paging back reaches the first line with no gap', async () => {
  const log = fakeLog(Array.from({ length: 100 }, (_, i) => line(i)).join(''))
  const newest = await log.ask({}, 1500)
  assert.ok(newest.from > 0 && newest.lines.length > 5 && newest.lines.length < 40)
  assert.equal(texts(newest).at(-1), 'tick 99')
  assert.equal(newest.next, log.file.bytes.length)
  assert.equal(newest.lines[0].pos, newest.from, 'the answer starts at a whole line')
  const seen = [...texts(newest)]
  let from = newest.from
  while (from > 0) {
    const earlier = await log.ask({ before: from }, 1500)
    assert.ok(earlier.from < from, 'each page goes further back')
    assert.equal(earlier.next, from)
    seen.unshift(...texts(earlier))
    from = earlier.from
  }
  assert.deepEqual(seen, Array.from({ length: 100 }, (_, i) => `tick ${i}`))
})

test('a log found shorter than the cursor is read again from its newest lines and says so', async () => {
  const log = fakeLog(line(1) + line(2) + line(3))
  const { next } = await log.ask()
  log.file.bytes = Buffer.from(line(7))
  const again = await log.ask({ after: next })
  assert.equal(again.reset, true)
  assert.deepEqual(texts(again), ['tick 7'])
  assert.deepEqual([again.from, again.next], [0, log.file.bytes.length])
  assert.ok(!('reset' in (await log.ask({ after: again.next }))))
})

test('a line longer than a read comes in parts and never stalls the cursor', async () => {
  const log = fakeLog(line(1) + line(2, 'y'.repeat(5000)) + line(3))
  let cursor = 0
  const seen: string[] = []
  for (let reads = 0; cursor < log.file.bytes.length; reads++) {
    assert.ok(reads < 20, 'the cursor keeps moving')
    const chunk = await log.ask({ after: cursor }, 1024)
    seen.push(...texts(chunk))
    cursor = chunk.next
  }
  assert.equal(seen[0], 'tick 1')
  assert.equal(seen.at(-1), 'tick 3')
  assert.equal(seen.join('').replace(/[^y]/g, '').length, 5000)
})

test('the remote script answers the same bytes a local read does, at byte offsets, whatever the text holds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swampling-log-'))
  const record = join(dir, "workflow-run-it's 1.yaml")
  const text = line(1, 'crème brûlée · 20 °C') + line(2, '\x1b[32mgreen\x1b[0m') + line(3)
  writeFileSync(record, 'id: abc\nworkflowName: bake\nstatus: running\njobs:\n  - name: main\n    status: succeeded\n')
  writeFileSync(record.replace(/\.yaml$/, '.log'), text)
  const reader = (file: string): ReadLog => async (from, length) => parseRemoteLog(execFileSync('sh', ['-c', remoteLogScript(file, from, length)], { encoding: 'latin1' }))
  const remote = reader(record)
  const first = await readChunk(remote, {}, 4096)
  assert.deepEqual(texts(first), ['crème brûlée · 20 °C', 'green', 'tick 3'])
  assert.equal(first.next, Buffer.byteLength(text))
  assert.equal(first.done, false)
  const from = Buffer.byteLength(line(1, 'crème brûlée · 20 °C'))
  assert.deepEqual(texts(await readChunk(remote, { after: from }, 4096)), ['green', 'tick 3'])
  assert.deepEqual((await remote(from, 0)).bytes.length, 0, 'a read of no bytes still answers the size')
  assert.equal((await remote(0, 0)).size, Buffer.byteLength(text))
  writeFileSync(record, 'id: abc\nstatus: succeeded\n')
  assert.equal((await readChunk(remote, { after: first.next }, 4096)).done, true)
  const quiet = join(dir, 'workflow-run-quiet.yaml')
  writeFileSync(quiet, 'status: running\n')
  assert.deepEqual(await readChunk(reader(quiet), {}, 4096), { from: 0, next: 0, size: 0, lines: [], done: false }, 'a run that wrote nothing yet has no log file')
  await assert.rejects(readChunk(reader(join(dir, 'none.yaml')), {}, 4096), /outside the repo/)
})

test('the text Copy takes holds each line with its time, and marks warnings and errors', () => {
  const lines = [line(1, 'mixed'), `${stamp(2)} [WRN] model·method·run·bake-mix·execute: lumpy\n`].map((l) => ({ pos: 0, ...parseLine(l.trimEnd()) }))
  assert.equal(logText(lines), `${stamp(1)} mixed\n${stamp(2)} [warn] lumpy`)
})
