import { watch, type FSWatcher } from "node:fs"
import { open, stat, type FileHandle } from "node:fs/promises"
import { join } from "node:path"

import { LOAD_ON_OPEN_EVENTS } from "../shared/bounds"
import type { Earlier } from "../shared/earlier"
import { EVENT_TYPES, type Envelope } from "../shared/wire"

/**
 * The Sidecar, read as a stream of envelopes.
 *
 * Ingestion is a file offset and nothing else: the Reader remembers how far into
 * `log/rails_log_reader.jsonl` it has read, and every line past that point is an envelope
 * it has not seen. That is what lets a temp file drive the whole Reader with no Rails
 * process anywhere near it (ADR-0003).
 *
 * Two things here are not obvious and are both ADR-0003's:
 *
 * - **The watch is on the `log/` directory, not on the Sidecar.** The Reader is routinely
 *   started before Rails has ever booted, so there is frequently no file to watch yet, and
 *   one directory watcher covers creation, replacement and appends alike.
 * - **A 1 Hz `stat` backs the watcher up.** Nothing waits on this timer in the normal case.
 *   It exists because in-flight requests are given no timeout, ever: a watch notification
 *   dropped by the platform would strand a row in flight until the Reader was restarted,
 *   and the backstop turns that permanent lie into a one-second delay.
 */

export const SIDECAR_NAME = "rails_log_reader.jsonl"

/** ADR-0003's line cap, which the Initializer applies on write and this applies on read. */
export const MAX_LINE_BYTES = 256 * 1024

const BACKSTOP_MS = 1_000

/** Read backwards a megabyte at a time: comfortably over one line, well under the history. */
const SCAN_CHUNK_BYTES = 1024 * 1024

const NEWLINE = 0x0a

export type Sidecar = {
  /** Read everything appended since the last read. What the watcher and the backstop both call. */
  catchUp: () => Promise<void>
  close: () => void
}

/**
 * Attach to the Sidecar in `logDirectory` and deliver envelopes in append order — the
 * Reader's global ordering key — starting with the load-on-open history, which is already
 * delivered by the time this resolves.
 */
export async function openSidecar(
  logDirectory: string,
  onEnvelopes: (envelopes: Envelope[]) => void,
  onHistoryStart: (from: number) => void = () => {},
): Promise<Sidecar> {
  const path = join(logDirectory, SIDECAR_NAME)

  let offset = 0
  /** The inode the offset belongs to: a different one is a different file, however named. */
  let inode: number | null = null
  let reading: Promise<void> = Promise.resolve()
  let watcher: FSWatcher | null = null
  let closed = false

  /**
   * Attached here rather than once at open, and retried on every catchUp, because `log/`
   * itself may not exist yet in a checkout that has never booted Rails. Until it does, the
   * backstop is the entire watch — and the tick that finds the directory attaches to it.
   */
  function watchLogDirectory() {
    if (watcher !== null) return

    try {
      watcher = watch(logDirectory, (_event, filename) => {
        if (filename === null || filename === SIDECAR_NAME) void catchUp()
      })
      // A watch outlives the directory it was taken on; dropping it here is what makes the
      // line above try again, rather than leaving a dead handle in place of a watch.
      watcher.once("error", () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      /* no `log/` yet */
    }
  }

  async function read() {
    const sidecar = await stat(path).catch((failure: NodeJS.ErrnoException) => {
      // Only "there is no such file" is an answer; anything else — a permission or
      // descriptor problem — leaves the offset alone and is retried a second later,
      // because resetting on it would re-read the whole history every tick.
      if (failure.code !== "ENOENT") throw failure
      return null
    })

    if (sidecar === null) {
      // Not written yet, or deleted under us. Either way the next file starts from its top.
      inode = null
      offset = 0
      return
    }

    // Shrink or replacement: a boot-time truncation, or a Sidecar swapped for another file.
    // Both mean the offset now points into bytes that are not the ones it was taken from,
    // and the answer to both is to attach to what is there now as if opening it.
    //
    // A truncation that regrows past the old offset inside one tick would slip through, and
    // is left to: that is 64 MB of new events inside a second, and the alternative is the
    // liveness protocol ADR-0003 refused.
    if (inode !== sidecar.ino || sidecar.size < offset) {
      inode = sidecar.ino
      offset = await startOfHistory(path, sidecar.size)
      // Announced on every attachment and every reset, not once at open: a truncation moves
      // the whole window, and a load-earlier cursor taken before it points into bytes that
      // are no longer the ones it was taken from.
      onHistoryStart(offset)
    }

    if (sidecar.size <= offset) return

    const handle = await open(path, "r")
    try {
      // One allocation for everything appended since the last read, bounded by ADR-0003's
      // 64 MB cap on the file itself. Behaviour under volume — backpressure, a drop policy —
      // is out of scope for v1 and open on the map.
      const span = Buffer.alloc(sidecar.size - offset)
      const { bytesRead } = await handle.read(span, 0, span.length, offset)
      const complete = span.subarray(0, bytesRead).lastIndexOf(NEWLINE)
      // A line without its newline is a write still in progress; it is read next time whole.
      if (complete === -1) return

      const envelopes = readEnvelopes(span.subarray(0, complete + 1))
      offset += complete + 1
      if (envelopes.length > 0) onEnvelopes(envelopes)
    } finally {
      await handle.close()
    }
  }

  /**
   * Reads are serialised and never overlap: the watcher fires in bursts, and two reads at
   * one offset would deliver the same envelopes twice. A read that fails takes nothing
   * down — there is no Reader surface for "your Sidecar is unreadable" yet (#29), and the
   * backstop retries a second later — but it must not poison the chain either.
   */
  function catchUp() {
    reading = reading.then(async () => {
      if (closed) return
      watchLogDirectory()
      try {
        await read()
      } catch {
        /* retried at 1 Hz */
      }
    })
    return reading
  }

  await catchUp()

  const backstop = setInterval(() => void catchUp(), BACKSTOP_MS)
  backstop.unref()

  return {
    catchUp,
    close() {
      closed = true
      watcher?.close()
      clearInterval(backstop)
    },
  }
}

/**
 * Where the load-on-open history begins: the start of the ~5,000th line back from EOF,
 * found by scanning backwards over the same offset the Reader tracks — the one seek
 * ADR-0003 describes.
 */
async function startOfHistory(path: string, size: number) {
  const handle = await open(path, "r")
  try {
    return await startOfWindow(handle, size)
  } finally {
    await handle.close()
  }
}

/**
 * The *load-earlier* control: the window before the window, read by continuing the same
 * backward scan from where the Reader's own window begins. Not infinite scroll, not a silent
 * fetch, and not a second mechanism — the only thing that makes this different from opening
 * the file is where the scan starts.
 *
 * Nothing is remembered between calls. The offset comes in from the browser and goes back
 * out with the envelopes, so this survives the browser reconnecting, which is exactly when a
 * server-side cursor would quietly have forgotten how far back the developer had read.
 */
export async function readEarlier(logDirectory: string, before: number): Promise<Earlier> {
  const path = join(logDirectory, SIDECAR_NAME)
  if (before <= 0) return { envelopes: [], from: 0 }

  const sidecar = await stat(path).catch((failure: NodeJS.ErrnoException) => {
    if (failure.code !== "ENOENT") throw failure
    return null
  })
  // The Sidecar the offset was taken from is not the one there now — it was truncated at a
  // boot, or has not been written yet. There is nothing earlier to give, and the live
  // attachment is announcing the new window as this returns.
  if (sidecar === null) return { envelopes: [], from: 0 }

  const end = Math.min(before, sidecar.size)
  const handle = await open(path, "r")
  try {
    const from = await startOfWindow(handle, end)
    const span = Buffer.alloc(end - from)
    const { bytesRead } = await handle.read(span, 0, span.length, from)
    const complete = span.subarray(0, bytesRead).lastIndexOf(NEWLINE)
    if (complete === -1) return { envelopes: [], from }

    return { envelopes: readEnvelopes(span.subarray(0, complete + 1)), from }
  } finally {
    await handle.close()
  }
}

/**
 * Where the load-on-open figure's worth of lines before `end` begins. `end` is the end of a
 * line — EOF, or the start of the line the Reader's window opens on — so the newline the
 * count runs one past is the one closing the line before the window, and the byte after it
 * opens it.
 */
async function startOfWindow(handle: FileHandle, end: number) {
  const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, end))
  let position = end
  let lines = 0

  while (position > 0) {
    const length = Math.min(chunk.length, position)
    position -= length
    await handle.read(chunk, 0, length, position)

    for (let index = length - 1; index >= 0; index--) {
      if (chunk[index] !== NEWLINE) continue
      lines += 1
      if (lines > LOAD_ON_OPEN_EVENTS) return position + index + 1
    }
  }

  return 0
}

function readEnvelopes(lines: Buffer) {
  const envelopes: Envelope[] = []

  let start = 0
  while (start < lines.length) {
    const end = lines.indexOf(NEWLINE, start)
    const envelope = readEnvelope(lines.subarray(start, end))
    if (envelope !== null) envelopes.push(envelope)
    start = end + 1
  }

  return envelopes
}

/**
 * One line. Unparseable lines are skipped silently (ADR-0003): a Sidecar is written by
 * concurrent processes and read while it is being written, so a half-written or interleaved
 * line is an ordinary event in the life of the file rather than a fault to report.
 */
function readEnvelope(line: Buffer): Envelope | null {
  if (line.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(line.toString("utf8"))
  } catch {
    return null
  }

  if (!isEnvelope(parsed)) return null
  return line.length > MAX_LINE_BYTES ? shrinkLargestField(parsed, line.length) : parsed
}

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.v === "number" &&
    typeof candidate.run_id === "string" &&
    typeof candidate.seq === "number" &&
    typeof candidate.at_mono === "number" &&
    typeof candidate.at_wall === "number" &&
    (typeof candidate.request_id === "string" || candidate.request_id === null) &&
    typeof candidate.type === "string" &&
    (EVENT_TYPES as readonly string[]).includes(candidate.type) &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  )
}

/**
 * ADR-0003's line cap, from the reading end. The Initializer already applies it on write,
 * so a line this large is one written by a Sidecar the Reader does not control — an
 * Initializer older than the cap, or a file written by hand. The Reader never assumes the
 * file it reads was written by its own master copy, and a 400 KB backtrace is the same
 * hazard in a browser that it is in a `write(2)`.
 *
 * The shrink mirrors the Initializer's, field for field, so the same line read twice by
 * either half says the same thing: the largest payload field is cut to fit, its original
 * byte length recorded in `truncated`, and three passes bound a pathological line.
 */
function shrinkLargestField(envelope: Envelope, lineBytes: number) {
  const payload = envelope.payload as Record<string, unknown>
  let bytes = lineBytes

  for (let pass = 0; pass < 3 && bytes > MAX_LINE_BYTES; pass++) {
    const fields = Object.entries(payload)
    if (fields.length === 0) return envelope

    const [field, value] = fields.reduce((largest, entry) =>
      byteSize(entry[1]) > byteSize(largest[1]) ? entry : largest,
    ) as [string, unknown]

    const truncated: Record<string, number> = envelope.truncated ?? {}
    const original = truncated[field] ?? byteSize(value)
    // The 1 KB of slack the Initializer leaves, for JSON's own escaping overhead.
    const budget = Math.max(byteSize(value) - (bytes - MAX_LINE_BYTES) - 1024, 0)

    payload[field] = shrinkToFit(value, budget)
    truncated[field] = original
    envelope.truncated = truncated

    bytes = Buffer.byteLength(JSON.stringify(envelope))
  }

  return envelope
}

/**
 * A String is cut from its end — a shortened string still says what it says. An Array sheds
 * elements from its tail, which for a backtrace is the framework frames farthest from where
 * it broke. An Object never loses a key, since a `params` missing one would be a lie about
 * what the request carried, so its values are shrunk evenly instead.
 */
function shrinkToFit(value: unknown, budget: number): unknown {
  if (byteSize(value) <= budget) return value

  if (typeof value === "string") return cutToBytes(value, budget)

  if (Array.isArray(value)) {
    const kept: unknown[] = []
    let remaining = budget
    for (const element of value) {
      const size = byteSize(element)
      if (size <= remaining) {
        kept.push(element)
        remaining -= size
      } else {
        if (remaining > 0) kept.push(shrinkToFit(element, remaining))
        break
      }
    }
    return kept
  }

  if (typeof value === "object" && value !== null) {
    const fields = Object.entries(value)
    if (fields.length === 0) return value
    const perField = Math.floor(budget / fields.length)
    return Object.fromEntries(fields.map(([field, nested]) => [field, shrinkToFit(nested, perField)]))
  }

  return value
}

/** Back off the cut until it is on a character boundary: a mangled line is one we skip. */
function cutToBytes(text: string, budget: number) {
  const bytes = Buffer.from(text, "utf8")
  let end = Math.max(budget, 0)
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1
  return bytes.subarray(0, end).toString("utf8")
}

/**
 * What the Initializer weighs a field by, so both halves cut in the same place — including
 * its blind spot: a field made only of numbers weighs nothing here, so a line made huge by
 * numbers alone is left whole rather than cut somewhere the Initializer would not have.
 */
function byteSize(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8")
  if (Array.isArray(value)) return value.reduce((total: number, element) => total + byteSize(element), 0)
  if (typeof value === "object" && value !== null) {
    return Object.values(value).reduce((total: number, nested) => total + byteSize(nested), 0)
  }
  return 0
}
