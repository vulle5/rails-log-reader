import { afterEach, describe, expect, test } from "bun:test"
import { link, mkdir, mkdtemp, appendFile, stat } from "node:fs/promises"
import { watch } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  findLiveRunHeader,
  MAX_LINE_BYTES,
  openSidecar,
  readEarlier,
  type RunHeaderEnvelope,
  type Sidecar,
} from "../src/server/sidecar"
import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"
import type { Envelope } from "../src/shared/wire"
import {
  aLogDirectory,
  aLogDirectoryThatDoesNotExistYet,
  aRun,
  appendToSidecar,
  eventually,
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
  const runHeaders: RunHeaderEnvelope[] = []
  // Where the history the Reader was given begins, as the Sidecar announces it: the offset a
  // load-earlier continues the backward scan from, kept here exactly as the browser keeps it.
  let historyStart = 0
  const sidecar = await openSidecar(
    logDirectory,
    (envelopes) => delivered.push(...envelopes),
    (from) => {
      historyStart = from
    },
    (header) => runHeaders.push(header),
  )
  opened.push(sidecar)
  return { delivered, runHeaders, caughtUp: () => sidecar.catchUp(), historyStart: () => historyStart }
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

describe("load-earlier", () => {
  test("continues the same backward scan from where the loaded history begins", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const events = Array.from({ length: LOAD_ON_OPEN_EVENTS + 10 }, (_, index) =>
      run.start(`req-${index}`, "GET", `/posts/${index}`),
    )
    await appendToSidecar(log, ...events)
    const reader = await theReaderReads(log)

    const earlier = await readEarlier(log, reader.historyStart())

    // The ten the load-on-open window left behind, and nothing the Reader already holds:
    // one scan continued from an earlier point, rather than a second mechanism.
    expect(earlier.envelopes.map((envelope) => envelope.request_id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `req-${index}`),
    )
    expect(earlier.from).toBe(0)
  })

  test("has nothing left to give once the scan has reached the top of the file", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.header(), run.start("req-1"))
    const reader = await theReaderReads(log)

    expect(reader.historyStart()).toBe(0)

    const earlier = await readEarlier(log, reader.historyStart())

    expect(earlier.envelopes).toEqual([])
    expect(earlier.from).toBe(0)
  })

  test("asks the Sidecar that is there now, not the one the offset was taken from", async () => {
    const log = await aLogDirectoryThatDoesNotExistYet()

    const earlier = await readEarlier(log, 4_096)

    expect(earlier.envelopes).toEqual([])
    expect(earlier.from).toBe(0)
  })
})

describe("recovering the live Run's own run_header", () => {
  test("delivers it through onRunHeader, never through onEnvelopes, once the window opens past it", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const header = run.header()
    // Four times the load-on-open window, the shape reported against a real Host app: the
    // header the last ~5,000 events never reach, comfortably before EOF.
    const filler = Array.from({ length: LOAD_ON_OPEN_EVENTS * 4 }, (_, index) => run.log(null, `filler ${index}`))
    await appendToSidecar(log, header, ...filler)

    const reader = await theReaderReads(log)

    await eventually(() => reader.runHeaders.length > 0, "the backward scan finding the header")

    expect(reader.runHeaders).toEqual([header])
    expect(reader.delivered.some((envelope) => envelope.type === "run_header")).toBe(false)
  })

  test("still scans when the loaded window holds a concurrent Run's header rather than the live Run's own", async () => {
    const log = await aLogDirectory()
    const server = aRun("srv-1")
    const header = server.header()
    const buried = Array.from({ length: LOAD_ON_OPEN_EVENTS * 4 }, (_, index) => server.log(null, `filler ${index}`))
    // A `rails c` session, started and logged entirely inside the load-on-open window: its
    // own `run_header` is right there, but it is not the live Run's — the last event in the
    // window is srv-1's, so srv-1's header is what this scan must go and find.
    const rake = aRun("rake-1")
    await appendToSidecar(log, header, ...buried, rake.header("rake"), server.log(null, "back to srv-1"))

    const reader = await theReaderReads(log)

    await eventually(() => reader.runHeaders.length > 0, "the backward scan finding srv-1's own header")

    expect(reader.runHeaders).toEqual([header])
  })

  test("memoizes the scan per (inode, run_id): a second call gets the same result without repeating it", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const filler = Array.from({ length: LOAD_ON_OPEN_EVENTS * 4 }, (_, index) => run.log(null, `filler ${index}`))
    await appendToSidecar(log, run.header(), ...filler)
    const path = sidecarPath(log)
    const { ino, size } = await stat(path)

    const first = findLiveRunHeader(path, ino, "srv-1", size)
    const second = findLiveRunHeader(path, ino, "srv-1", size)

    // The very same Promise, not merely an equal result: the second call never started a
    // scan of its own to arrive at it.
    expect(second).toBe(first)
    expect(await first).toMatchObject({ run_id: "srv-1", type: "run_header" })
  })

  test("invalidates the memoized scan the same way read() detects a truncation: a new inode", async () => {
    const log = await aLogDirectory()
    const before = aRun("srv-1")
    await appendToSidecar(log, before.header(), before.log(null, "before the truncation"))
    const path = sidecarPath(log)
    const beforeStat = await stat(path)
    expect(await findLiveRunHeader(path, beforeStat.ino, "srv-1", beforeStat.size)).toMatchObject({ run_id: "srv-1" })

    // What `rails c` does to a Sidecar a live server is still appending to.
    const after = aRun("srv-2")
    await truncateSidecar(log, after.header(), after.log(null, "after the truncation"))
    const afterStat = await stat(path)

    const found = await findLiveRunHeader(path, afterStat.ino, "srv-2", afterStat.size)

    expect(found).toMatchObject({ run_id: "srv-2" })
  })

  test("gives up and resolves null once the scan reaches the top of the file with no match", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.header(), run.log(null, "just one line"))
    const path = sidecarPath(log)
    const { size } = await stat(path)

    // No Run in this file ever wrote this id — the same "not there at all" the 64 MB cap
    // gives up on, reached here by running out of file instead of running out of budget.
    expect(await findLiveRunHeader(path, 1, "no-such-run", size)).toBeNull()
  })

  test(
    "gives up past the 64 MB cap even though a matching header sits further back",
    async () => {
      const log = await aLogDirectory()
      const run = aRun("srv-1")
      const header = run.header()
      // Comfortably past the cap, and free of the needle entirely: the scan has to stop at
      // 64 MB on its own, rather than this test merely reaching the top of a small file.
      const filler = Array.from({ length: 80 }, () => "x".repeat(1_000_000))
      await appendToSidecar(log, header, ...filler, run.log(null, "near the end"))
      const path = sidecarPath(log)
      const { size } = await stat(path)

      expect(await findLiveRunHeader(path, 1, "srv-1", size)).toBeNull()
    },
    20_000,
  )
})
