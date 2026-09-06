import { afterEach, describe, expect, test } from "bun:test"

import { openSidecar, type Sidecar } from "../src/server/sidecar"
import { activityTable, type RequestRow } from "../src/shared/activity"
import { CLOCK_STEPPED_BACK, DENSE_TRAFFIC, HANGS, NEVER_ROUTED } from "./traffic.fixtures"
import {
  aLogDirectory,
  aRun,
  appendToSidecar,
  forgetLogDirectories,
  replaceSidecar,
} from "./sidecar.fixtures"

/**
 * Seam 1: a Sidecar file becomes Activity table rows. Every test here writes JSONL into a
 * temp file and reads what a developer would see in the table — the fold is never called
 * directly, because a test that names an internal function has picked the wrong seam.
 */

const opened: Sidecar[] = []

afterEach(async () => {
  for (const sidecar of opened.splice(0)) sidecar.close()
  await forgetLogDirectories()
})

/**
 * The Reader with the wire between its halves taken out: `src/server/index.ts` reads the
 * Sidecar and `src/ui/live.ts` folds what it sends, and here the two are joined directly.
 */
async function theReaderReads(logDirectory: string) {
  const activity = activityTable()
  const sidecar = await openSidecar(logDirectory, activity.fold)
  opened.push(sidecar)
  return { rows: activity.rows, caughtUp: () => sidecar.catchUp() }
}

function row(rows: readonly RequestRow[], path: string) {
  const found = rows.find((candidate) => candidate.path === path)
  if (found === undefined) throw new Error(`no row for ${path}, only ${rows.map((r) => r.path).join(", ")}`)
  return found
}

describe("folding a request", () => {
  test("folds request_start, request_route and request_finish into one row", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.header(),
      run.start("req-1", "GET", "/posts/12"),
      run.route("req-1", "PostsController", "show"),
      run.finish("req-1", { status: 200, duration_ms: 78.3, view_runtime_ms: 61.2, db_runtime_ms: 1.4 }),
    )

    const { rows } = await theReaderReads(log)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      requestId: "req-1",
      method: "GET",
      path: "/posts/12",
      controller: "PostsController",
      action: "show",
      status: 200,
      durationMs: 78.3,
      viewRuntimeMs: 61.2,
      dbRuntimeMs: 1.4,
    })
  })

  test("a request that never routed still gets a row, showing its method and path", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-404", "GET", "/pots/12"),
      run.finish("req-404", { status: 404, duration_ms: 3.1 }),
    )

    const { rows } = await theReaderReads(log)

    expect(rows[0]).toMatchObject({ method: "GET", path: "/pots/12", status: 404 })
    expect(rows[0]?.controller).toBeNull()
    expect(rows[0]?.action).toBeNull()
  })

  test("attaches SQL and App log events to their request and drives its counts", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1"),
      run.sql("req-1"),
      run.sql("req-1"),
      run.log("req-1", "Feed cache MISS"),
      run.sql("req-1"),
      run.finish("req-1"),
    )

    const { rows } = await theReaderReads(log)

    expect(rows[0]).toMatchObject({ sqlCount: 3, logCount: 1 })
  })

  test("an event with no owning request drives no request's counts", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.header(), run.sql(null), run.log(null, "Booting Puma"), run.end())

    const { rows } = await theReaderReads(log)

    expect(rows).toHaveLength(0)
  })
})

describe("where a row sits", () => {
  test("appends a row at the position of the earliest event observed for it", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1", "GET", "/first"),
      run.sql("req-2"), // a child of a request whose start the Reader never saw
      run.start("req-3", "GET", "/third"),
      run.finish("req-2", { status: 200 }),
      run.route("req-2", "ReportsController", "monthly"),
    )

    const { rows } = await theReaderReads(log)

    expect(rows.map((r) => r.requestId)).toEqual(["req-1", "req-2", "req-3"])
  })

  test("mutates a row in place rather than moving it as its later events arrive", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1", "GET", "/first"), run.start("req-2", "GET", "/second"))
    const reader = await theReaderReads(log)
    const first = reader.rows[0]

    await appendToSidecar(log, run.finish("req-1", { status: 500 }), run.finish("req-2", { status: 200 }))
    await reader.caughtUp()

    expect(reader.rows.map((r) => r.path)).toEqual(["/first", "/second"])
    expect(reader.rows[0]).toBe(first)
    expect(reader.rows[0]?.status).toBe(500)
  })

  test("orders rows by append position even when at_wall jumps backwards", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1", "GET", "/before-the-jump", 1_756_915_200_900),
      run.start("req-2", "GET", "/after-the-jump", 1_756_915_200_100), // NTP stepped the clock back
    )

    const { rows } = await theReaderReads(log)

    expect(rows.map((r) => r.path)).toEqual(["/before-the-jump", "/after-the-jump"])
  })

  test("orders two Runs by append position, not by the seq each restarts at 1", async () => {
    const log = await aLogDirectory()
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    await appendToSidecar(
      log,
      server.header(),
      server.start("req-1", "GET", "/first"),
      rake.header("rake", 90_211),
      rake.start("req-2", "GET", "/second"),
      server.start("req-3", "GET", "/third"),
    )

    const { rows } = await theReaderReads(log)

    expect(rows.map((r) => r.path)).toEqual(["/first", "/second", "/third"])
  })
})

describe("reading the same bytes twice", () => {
  test("never doubles a row, because (run_id, seq) is the event identity", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const events = [run.start("req-1"), run.sql("req-1"), run.log("req-1"), run.finish("req-1")]
    await appendToSidecar(log, ...events)
    const reader = await theReaderReads(log)

    // A replaced Sidecar resets the offset, so every one of those bytes is read a second time.
    await replaceSidecar(log, ...events, run.log("req-1", "and one the Reader has not seen"))
    await reader.caughtUp()

    expect(reader.rows).toHaveLength(1)
    expect(reader.rows[0]).toMatchObject({ sqlCount: 1, logCount: 2, status: 200 })
  })

  test("tells apart two Runs that both count from 1", async () => {
    const log = await aLogDirectory()
    const server = aRun("srv-1")
    const worker = aRun("srv-2")
    await appendToSidecar(log, server.start("req-1", "GET", "/first"), worker.start("req-2", "GET", "/second"))

    const { rows } = await theReaderReads(log)

    expect(rows).toHaveLength(2)
  })
})

/**
 * The seed the prototype left behind, driven through a real Sidecar file: 650 emissions
 * over ~13 seconds, three Runs writing at once, and the crafted scenarios buried in
 * ordinary traffic rather than sitting alone. The quiet original flattered every design,
 * and would flatter these assertions too.
 */
describe("a busy dev app's Sidecar", () => {
  async function theReaderReadsTheSeed() {
    const log = await aLogDirectory()
    await appendToSidecar(log, ...DENSE_TRAFFIC)
    return theReaderReads(log)
  }

  test("gives every request in the file exactly one row", async () => {
    const { rows } = await theReaderReadsTheSeed()

    expect(rows).toHaveLength(56)
    expect(new Set(rows.map((candidate) => candidate.requestId)).size).toBe(56)
  })

  test("appends rows in the order the file did, across all three Runs", async () => {
    const { rows } = await theReaderReadsTheSeed()

    const firstSeen: string[] = []
    for (const envelope of DENSE_TRAFFIC) {
      if (envelope.request_id !== null && !firstSeen.includes(envelope.request_id)) {
        firstSeen.push(envelope.request_id)
      }
    }

    expect(rows.map((candidate) => candidate.requestId)).toEqual(firstSeen)
  })

  test("leaves the request whose clock was stepped back where it was appended", async () => {
    const { rows } = await theReaderReadsTheSeed()

    const stepped = rows.findIndex((candidate) => candidate.requestId === CLOCK_STEPPED_BACK.requestId)
    const startedAt = rows[stepped]?.startedAtWall ?? 0
    const above = rows.slice(0, stepped).map((candidate) => candidate.startedAtWall ?? 0)

    expect(rows[stepped]?.path).toBe(CLOCK_STEPPED_BACK.path)
    // Sorting on at_wall would have carried it up past these; append order did not.
    expect(above.filter((wall) => wall > startedAt).length).toBeGreaterThan(0)
  })

  test("counts the N+1 request's twenty-four queries against its row", async () => {
    const { rows } = await theReaderReadsTheSeed()

    expect(row(rows, "/api/v1/feed?page=1")).toMatchObject({
      controller: "Api::V1::FeedController",
      action: "index",
      status: 200,
      sqlCount: 24,
      logCount: 4,
    })
  })

  test("shows the mistyped path that never reached a controller", async () => {
    const { rows } = await theReaderReadsTheSeed()

    expect(row(rows, NEVER_ROUTED.path)).toMatchObject({ method: "GET", status: 404, controller: null })
  })

  test("holds the hanging request open, naming the controller it is stuck in", async () => {
    const { rows } = await theReaderReadsTheSeed()

    expect(row(rows, HANGS.path)).toMatchObject({
      controller: "Admin::ReportsController",
      action: "monthly",
      status: null,
      durationMs: null,
      sqlCount: 2,
    })
  })
})
