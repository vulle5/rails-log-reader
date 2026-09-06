import { afterEach, describe, expect, test } from "bun:test"

import { openSidecar, type Sidecar } from "../src/server/sidecar"
import { activityTable, type RequestRow, type TimelineEvent } from "../src/shared/activity"
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

/** What a timeline event is, in one string: the query it ran or the line it printed. */
function describeEvent(event: TimelineEvent) {
  return event.type === "sql" ? event.payload.sql : event.payload.message
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

/**
 * What the detail column reads: a row keeps the events themselves, not just a count of
 * them. Still Seam 1 — a real Sidecar file in, rows out — because the timeline is folded
 * from the same bytes by the same pass.
 */
describe("a request's timeline", () => {
  test("keeps its SQL and App log events interleaved, in the order they were emitted", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1"),
      run.sql("req-1", "SELECT 1"),
      run.log("req-1", "Feed cache MISS"),
      run.sql("req-1", "SELECT 2"),
      run.finish("req-1"),
    )

    const { rows } = await theReaderReads(log)

    expect(rows[0]?.timeline.map(describeEvent)).toEqual(["SELECT 1", "Feed cache MISS", "SELECT 2"])
  })

  test("holds SQL exactly as it was emitted, QueryLogs comment and all", async () => {
    const statement = `SELECT "posts".* FROM "posts" WHERE "posts"."id" = ? /*action='show',controller='posts'*/`
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1"), run.sql("req-1", statement), run.finish("req-1"))

    const { rows } = await theReaderReads(log)

    expect(rows[0]?.timeline[0]).toMatchObject({ type: "sql", payload: { sql: statement } })
  })

  test("puts an event whose seq is after the request_finish in a trailing section of its own", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1"),
      run.sql("req-1", "SELECT 1"),
      run.finish("req-1"),
      run.log("req-1", "Executor#to_complete ran after the body closed"),
    )

    const { rows } = await theReaderReads(log)

    expect(rows[0]?.timeline.map(describeEvent)).toEqual(["SELECT 1"])
    expect(rows[0]?.trailing.map(describeEvent)).toEqual(["Executor#to_complete ran after the body closed"])
    // Attribution was never in doubt, so a Trailing event still counts against its request.
    expect(rows[0]).toMatchObject({ logCount: 1 })
  })

  test("leaves a request that has not finished no trailing section to put anything in", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1"), run.sql("req-1"), run.log("req-1"))

    const { rows } = await theReaderReads(log)

    expect(rows[0]?.timeline).toHaveLength(2)
    expect(rows[0]?.trailing).toHaveLength(0)
  })

  test("keeps the exception a request finished with, its backtrace uncleaned", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1"),
      run.finish("req-1", {
        status: 500,
        exception: {
          class: "NoMethodError",
          message: "undefined method `price_cents' for nil",
          backtrace: ["app/models/order.rb:44:in `block in recalculate_total!'", "puma (6.6.0) lib/puma/server.rb:443"],
        },
      }),
    )

    const { rows } = await theReaderReads(log)

    expect(rows[0]?.exception).toMatchObject({ class: "NoMethodError" })
    expect(rows[0]?.exception?.backtrace).toHaveLength(2)
  })

  test("gives a request that finished without raising no exception rather than an empty one", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1"), run.finish("req-1"))

    const { rows } = await theReaderReads(log)

    expect(rows[0]?.exception).toBeNull()
  })

  test("drops the line Rails logs beside a query it already holds, keeping the callsite under it", async () => {
    const statement = `SELECT "posts".* FROM "posts" WHERE "posts"."id" = 58 LIMIT 1 /*action='show'*/`
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1"),
      run.sql("req-1", statement),
      // What ActiveRecord's own log subscriber writes for that same query, and then the
      // callsite `verbose_query_logs` puts under it.
      run.log("req-1", `  Post Load (0.2ms)  ${statement}`, { severity: "debug", source: "rails" }),
      run.log("req-1", "  \u21b3 app/controllers/posts_controller.rb:9", { severity: "debug", source: "rails" }),
      run.finish("req-1"),
    )

    const { rows } = await theReaderReads(log)

    expect(rows[0]?.timeline.map(describeEvent)).toEqual([
      statement,
      "  \u21b3 app/controllers/posts_controller.rb:9",
    ])
    // The count and the timeline are one thing counted and the same thing listed.
    expect(rows[0]).toMatchObject({ sqlCount: 1, logCount: 1 })
  })

  test("keeps a line the developer wrote themselves, even when they logged the query into it", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1"),
      run.sql("req-1", "SELECT 1"),
      // Someone debugging their own Arel. It says what Rails' line says and is not the same
      // event: a developer's own call is the one thing the Console exists to keep findable.
      run.log("req-1", "about to run SELECT 1", { source: "app" }),
      run.finish("req-1"),
    )

    const { rows } = await theReaderReads(log)

    expect(rows[0]?.timeline.map(describeEvent)).toEqual(["SELECT 1", "about to run SELECT 1"])
  })

  test("keeps a Rails line that quotes a query from further back than the one before it", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1"),
      run.sql("req-1", "SELECT 1"),
      run.sql("req-1", "SELECT 2"),
      // Rails writes a query's line there and then, so this one cannot be SELECT 1's.
      run.log("req-1", "  Post Load (0.2ms)  SELECT 1", { severity: "debug", source: "rails" }),
      run.finish("req-1"),
    )

    const { rows } = await theReaderReads(log)

    expect(rows[0]?.timeline.map(describeEvent)).toEqual(["SELECT 1", "SELECT 2", "  Post Load (0.2ms)  SELECT 1"])
  })

  test("keeps both lines when the query's SQL was cut, rather than guessing they are one", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const query = run.sql("req-1", "SELECT huge FROM enormous WHERE it = 'was cut here")
    await appendToSidecar(
      log,
      run.start("req-1"),
      { ...query, truncated: { sql: 812_400 } },
      // Cut at its own cap, a few characters earlier, so it does not hold the statement.
      run.log("req-1", "  Load (9.1ms)  SELECT huge FROM enormous WHERE it = 'was cut", {
        severity: "debug",
        source: "rails",
      }),
      run.finish("req-1"),
    )

    const { rows } = await theReaderReads(log)

    // Duplicated on screen, which is the honest outcome: nothing here can prove they match.
    expect(rows[0]?.timeline).toHaveLength(2)
  })

  test("keeps the twenty-four queries of the N+1 request, in the order the file has them", async () => {
    const log = await aLogDirectory()
    await appendToSidecar(log, ...DENSE_TRAFFIC)
    const { rows } = await theReaderReads(log)

    const feed = row(rows, "/api/v1/feed?page=1")
    const authorLoads = feed.timeline.filter(
      (event) => event.type === "sql" && event.payload.name === "Author Load",
    )

    const order = feed.timeline.map((event) => event.seq)

    expect(feed.timeline).toHaveLength(28)
    expect(authorLoads).toHaveLength(20)
    // Append order put them in `seq` order already: the fold sorted nothing to achieve this.
    expect(order).toEqual([...order].sort((one, other) => one - other))
  })
})
