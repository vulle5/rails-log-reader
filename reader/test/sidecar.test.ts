import { afterEach, describe, expect, test } from "bun:test"
import { link, mkdir, mkdtemp, appendFile } from "node:fs/promises"
import { watch } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LOAD_ON_OPEN_EVENTS, MAX_LINE_BYTES, openSidecar, type Sidecar } from "../src/server/sidecar"
import type { Envelope } from "../src/shared/wire"
import {
  aLogDirectory,
  aLogDirectoryThatDoesNotExistYet,
  aRun,
  appendToSidecar,
  forgetLogDirectories,
  sidecarPath,
  truncateSidecar,
} from "./sidecar.fixtures"

/**
 * Seam 1, at the ingestion end: what the Reader does with the file itself, before anything
 * is folded. Still no Rails process and no browser — a temp file is the whole apparatus.
 */

const opened: Sidecar[] = []

afterEach(async () => {
  for (const sidecar of opened.splice(0)) sidecar.close()
  await forgetLogDirectories()
})

async function theReaderReads(logDirectory: string) {
  const delivered: Envelope[] = []
  const sidecar = await openSidecar(logDirectory, (envelopes) => delivered.push(...envelopes))
  opened.push(sidecar)
  return { delivered, caughtUp: () => sidecar.catchUp() }
}

/** Polls, because the watcher and the backstop are the two things under test here. */
async function eventually(satisfied: () => boolean, what: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (satisfied()) return
    await Bun.sleep(20)
  }
  throw new Error(`${what} never happened`)
}

describe("watching the log directory", () => {
  test("picks up a Sidecar that did not exist when the Reader started", async () => {
    const log = await aLogDirectory()
    const reader = await theReaderReads(log)
    const run = aRun("srv-1")

    await appendToSidecar(log, run.header(), run.start("req-1"))

    await eventually(() => reader.delivered.length === 2, "the first two events arriving")
  })

  test("picks up a `log/` that did not exist when the Reader started either", async () => {
    const log = await aLogDirectoryThatDoesNotExistYet()
    const reader = await theReaderReads(log)
    const run = aRun("srv-1")

    await mkdir(log, { recursive: true })
    await appendToSidecar(log, run.header(), run.start("req-1"))

    await eventually(() => reader.delivered.length === 2, "the events arriving once `log/` exists")
  })

  test("follows an append the directory watcher never reports", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.header())
    const reader = await theReaderReads(log)

    // A second link to the same inode, in another directory. Writes through it modify the
    // Sidecar and are invisible to a watch on `log/` — which is the shape of the dropped
    // notification ADR-0003 backs the watcher up for: with no timeout on an in-flight
    // request, a `request_finish` that arrives this way and is never noticed strands a row.
    const elsewhere = join(await mkdtemp(join(tmpdir(), "elsewhere-")), "sidecar.jsonl")
    await link(sidecarPath(log), elsewhere)
    const witnessed: string[] = []
    const witness = watch(log, (event) => witnessed.push(event))

    try {
      await appendFile(elsewhere, `${JSON.stringify(run.start("req-1"))}\n`)

      await eventually(() => reader.delivered.length === 2, "the 1 Hz stat catching the append")

      // On Linux, watching `log/` really is blind to a write through another path to the
      // same inode — inotify reports on the directory entry, not the inode — so arriving
      // at all here proves the backstop, not the watcher, did the catching. macOS's
      // FSEvents has no such boundary: hard-linked names share one catalog entry, so a
      // write through either name touches metadata FSEvents reports against both. That is
      // not just noise on this `witness` watch — the Sidecar's own directory watcher
      // (`sidecar.ts`'s `watchLogDirectory`) is watching the exact same directory the same
      // way, so it almost certainly sees the identical spurious event and calls `catchUp()`
      // from *there*, milliseconds in, before the backstop's 1 Hz tick ever fires. Measured
      // on this machine: delivery lands in ~20 ms, not ~1 s. So on macOS this test still
      // confirms the append is delivered, but can no longer tell you it was the backstop
      // that delivered it — the isolation the hard link buys on Linux, it doesn't buy here.
      if (process.platform !== "darwin") expect(witnessed).toEqual([])
    } finally {
      witness.close()
    }
  })
})

describe("the offset", () => {
  test("delivers each event once as the Sidecar grows", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1"))
    const reader = await theReaderReads(log)

    await appendToSidecar(log, run.sql("req-1"))
    await reader.caughtUp()
    await reader.caughtUp()
    await appendToSidecar(log, run.finish("req-1"))
    await reader.caughtUp()

    expect(reader.delivered.map((envelope) => envelope.type)).toEqual(["request_start", "sql", "request_finish"])
  })

  test("waits for the rest of a line that is still being written", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const line = JSON.stringify(run.start("req-1"))
    await appendFile(sidecarPath(log), line.slice(0, 40))
    const reader = await theReaderReads(log)

    expect(reader.delivered).toHaveLength(0)

    await appendFile(sidecarPath(log), `${line.slice(40)}\n`)
    await reader.caughtUp()

    expect(reader.delivered).toHaveLength(1)
    expect(reader.delivered[0]?.type).toBe("request_start")
  })

  test("opens on roughly the last 5,000 events, scanned backwards from the end", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const events = Array.from({ length: LOAD_ON_OPEN_EVENTS + 10 }, (_, index) =>
      run.start(`req-${index}`, "GET", `/posts/${index}`),
    )
    await appendToSidecar(log, ...events)

    const reader = await theReaderReads(log)

    expect(reader.delivered).toHaveLength(LOAD_ON_OPEN_EVENTS)
    expect(reader.delivered.at(0)?.request_id).toBe("req-10")
    expect(reader.delivered.at(-1)?.request_id).toBe(`req-${LOAD_ON_OPEN_EVENTS + 9}`)
  })

  test("starts a truncated Sidecar again from its top", async () => {
    const log = await aLogDirectory()
    const server = aRun("srv-1")
    await appendToSidecar(log, server.header(), server.start("req-1"), server.finish("req-1"))
    const reader = await theReaderReads(log)

    // What `rails c` does to a 64 MB Sidecar a live server is still appending to.
    const next = aRun("srv-2")
    await truncateSidecar(log, next.header("console", 90_211))
    await reader.caughtUp()

    expect(reader.delivered.at(-1)).toMatchObject({ run_id: "srv-2", type: "run_header" })
  })
})

describe("a line the Reader cannot use", () => {
  test("skips it silently and keeps the lines around it", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1"),
      "{ this is not JSON at all",
      '{"v":1,"but":"not an envelope"}',
      '{"v":1,"run_id":"srv-1","seq":9,"at_mono":1,"at_wall":1,"request_id":null,"type":"gossip","payload":{}}',
      "",
      run.finish("req-1"),
    )

    const reader = await theReaderReads(log)

    expect(reader.delivered.map((envelope) => envelope.type)).toEqual(["request_start", "request_finish"])
  })

  test("truncates the largest field of an oversized line further, and records what it was", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const shout = "x".repeat(300_000)
    await appendToSidecar(log, run.log("req-1", shout))

    const reader = await theReaderReads(log)

    const delivered = reader.delivered[0]
    if (delivered?.type !== "app_log") throw new Error("the App log event did not arrive")
    expect(delivered.payload.message.length).toBeLessThan(MAX_LINE_BYTES)
    expect(delivered.payload.message.startsWith("xxxx")).toBe(true)
    expect(delivered.truncated).toEqual({ message: 300_000 })
    expect(Buffer.byteLength(JSON.stringify(delivered))).toBeLessThanOrEqual(MAX_LINE_BYTES)
  })
})
