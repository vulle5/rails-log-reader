import { afterEach, describe, expect, test } from "bun:test"

import { openSidecar, readEarlier, type Sidecar } from "../src/server/sidecar"
import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"
import {
  activityTable,
  type ActivityRow,
  type EvictedRow,
  type RequestRow,
  type RunRow,
  type TimelineEvent,
} from "../src/shared/activity"
import {
  CLOCK_STEPPED_BACK,
  CONSOLE_RUN,
  DENSE_TRAFFIC,
  HANGS,
  NEVER_ROUTED,
  RAKE_RUN,
  SERVER_RUN,
} from "./traffic.fixtures"
import {
  aLogDirectory,
  aRun,
  EPOCH,
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
  // The offset the history the Reader was given begins at, kept exactly as the browser keeps
  // it: the Sidecar announces it on attaching, and a load-earlier continues the scan from
  // there and hands back where the history begins now.
  let from = 0
  // Every row `fold` and `foldEarlier` have ever handed back, in the order they reported
  // it — the fold's own report of what it let go of, which is what `live.ts` hands the
  // Console (#63).
  const evicted: EvictedRow[] = []
  const sidecar = await openSidecar(
    logDirectory,
    (envelopes) => evicted.push(...activity.fold(envelopes)),
    (start) => {
      from = start
    },
  )
  opened.push(sidecar)

  async function loadEarlier() {
    const earlier = await readEarlier(logDirectory, from)
    from = earlier.from
    evicted.push(...activity.foldEarlier(earlier.envelopes))
  }

  return { rows: activity.rows, caughtUp: () => sidecar.catchUp(), loadEarlier, evicted }
}

/** What a timeline event is, in one string: the query it ran or the line it printed. */
function describeEvent(event: TimelineEvent) {
  return event.type === "sql" ? event.payload.sql : event.payload.message
}

/**
 * The Activity table holds two kinds of row, and most of what follows is about one of them.
 * Read through these rather than by index, so a test about requests keeps saying what it
 * said before Run rows existed.
 */
function requests(rows: readonly ActivityRow[]): RequestRow[] {
  return rows.filter((candidate) => candidate.kind === "request")
}

function runs(rows: readonly ActivityRow[]): RunRow[] {
  return rows.filter((candidate) => candidate.kind === "run")
}

/**
 * The one request row in the table, for the tests whose Sidecar holds a single request: it
 * says that out loud, and fails rather than reading past a row that should not be there.
 */
function theOnlyRequest(rows: readonly ActivityRow[]) {
  const only = requests(rows)
  if (only.length !== 1) throw new Error(`${only.length} request rows, not one`)
  return only[0] as RequestRow
}

function row(rows: readonly ActivityRow[], path: string) {
  const found = requests(rows).find((candidate) => candidate.path === path)
  if (found === undefined) throw new Error(`no row for ${path}, only ${requests(rows).map((r) => r.path).join(", ")}`)
  return found
}

function runRow(rows: readonly ActivityRow[], runId: string) {
  const found = runs(rows).find((candidate) => candidate.runId === runId)
  if (found === undefined) throw new Error(`no Run row for ${runId}, only ${runs(rows).map((r) => r.runId).join(", ")}`)
  return found
}

/** What a timeline holds, in the order it holds it. */
function timeline(row: { timeline: readonly TimelineEvent[] }) {
  return row.timeline.map(describeEvent)
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

    expect(requests(rows)).toHaveLength(1)
    expect(theOnlyRequest(rows)).toMatchObject({
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

  // #45: a finish with no duration is still a finish. The Initializer leaves the field off
  // when it never saw the request start and so has nothing to measure from — where it used to
  // subtract the missing start, raise, and drop the whole event, leaving the row in flight for
  // the rest of the session.
  test("finishes a row on a request_finish that carries no duration, rather than reading one as zero", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.header(),
      run.start("req-1", "GET", "/posts/12"),
      run.finish("req-1", { status: 200, duration_ms: undefined }),
    )

    const { rows } = await theReaderReads(log)

    expect(theOnlyRequest(rows)).toMatchObject({ state: "finished", status: 200, durationMs: null })
    // What the row has instead, and what the table shows in that column: the Reader's own
    // measurement, across the one clock two events may be subtracted in.
    expect(theOnlyRequest(rows).provenElapsed?.ms).toBe(100)
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

    expect(theOnlyRequest(rows)).toMatchObject({ method: "GET", path: "/pots/12", status: 404 })
    expect(theOnlyRequest(rows).controller).toBeNull()
    expect(theOnlyRequest(rows).action).toBeNull()
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

    expect(theOnlyRequest(rows)).toMatchObject({ sqlCount: 3, logCount: 1 })
  })

  test("gives an event with no owning request to its Run rather than to a request", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.header(), run.sql(null), run.log(null, "Booting Puma"), run.end())

    const { rows } = await theReaderReads(log)

    expect(requests(rows)).toHaveLength(0)
    expect(runRow(rows, "srv-1")).toMatchObject({ sqlCount: 1, logCount: 1 })
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

    expect(requests(rows).map((r) => r.requestId)).toEqual(["req-1", "req-2", "req-3"])
  })

  test("mutates a row in place rather than moving it as its later events arrive", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1", "GET", "/first"), run.start("req-2", "GET", "/second"))
    const reader = await theReaderReads(log)
    const first = reader.rows[0]

    await appendToSidecar(log, run.finish("req-1", { status: 500 }), run.finish("req-2", { status: 200 }))
    await reader.caughtUp()

    expect(requests(reader.rows).map((r) => r.path)).toEqual(["/first", "/second"])
    expect(reader.rows[0]).toBe(first)
    expect(requests(reader.rows)[0]?.status).toBe(500)
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

    expect(requests(rows).map((r) => r.path)).toEqual(["/before-the-jump", "/after-the-jump"])
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

    expect(requests(rows).map((r) => r.path)).toEqual(["/first", "/second", "/third"])
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

    expect(requests(reader.rows)).toHaveLength(1)
    expect(theOnlyRequest(reader.rows)).toMatchObject({ sqlCount: 1, logCount: 2, status: 200 })
  })

  test("tells apart two Runs that both count from 1", async () => {
    const log = await aLogDirectory()
    const server = aRun("srv-1")
    const worker = aRun("srv-2")
    await appendToSidecar(log, server.start("req-1", "GET", "/first"), worker.start("req-2", "GET", "/second"))

    const { rows } = await theReaderReads(log)

    expect(requests(rows)).toHaveLength(2)
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

    expect(requests(rows)).toHaveLength(56)
    expect(new Set(requests(rows).map((candidate) => candidate.requestId)).size).toBe(56)
  })

  test("appends rows in the order the file did, across all three Runs", async () => {
    const { rows } = await theReaderReadsTheSeed()

    const firstSeen: string[] = []
    for (const envelope of DENSE_TRAFFIC) {
      if (envelope.request_id !== null && !firstSeen.includes(envelope.request_id)) {
        firstSeen.push(envelope.request_id)
      }
    }

    expect(requests(rows).map((candidate) => candidate.requestId)).toEqual(firstSeen)
  })

  test("leaves the request whose clock was stepped back where it was appended", async () => {
    const { rows } = await theReaderReadsTheSeed()

    const ordered = requests(rows)
    const stepped = ordered.findIndex((candidate) => candidate.requestId === CLOCK_STEPPED_BACK.requestId)
    const startedAt = ordered[stepped]?.startedAtWall ?? 0
    const above = ordered.slice(0, stepped).map((candidate) => candidate.startedAtWall ?? 0)

    expect(ordered[stepped]?.path).toBe(CLOCK_STEPPED_BACK.path)
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

  test("gives each of the three Runs writing into it a row of its own", async () => {
    const { rows } = await theReaderReadsTheSeed()

    // Previous Runs stay visible: nothing here filters the file down to the newest one.
    expect(runs(rows).map((candidate) => candidate.runId)).toEqual([SERVER_RUN, RAKE_RUN, CONSOLE_RUN])
    expect(runRow(rows, RAKE_RUN)).toMatchObject({ runKind: "rake", marker: false, sqlCount: 118 })
    expect(runRow(rows, SERVER_RUN).marker).toBe(true)
  })

  test("holds the hanging request open, naming the controller it is stuck in", async () => {
    const { rows } = await theReaderReadsTheSeed()

    expect(row(rows, HANGS.path)).toMatchObject({
      controller: "Admin::ReportsController",
      action: "monthly",
      state: "in-flight",
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

    expect(theOnlyRequest(rows).timeline.map(describeEvent)).toEqual(["SELECT 1", "Feed cache MISS", "SELECT 2"])
  })

  test("holds SQL exactly as it was emitted, QueryLogs comment and all", async () => {
    const statement = `SELECT "posts".* FROM "posts" WHERE "posts"."id" = ? /*action='show',controller='posts'*/`
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1"), run.sql("req-1", statement), run.finish("req-1"))

    const { rows } = await theReaderReads(log)

    expect(theOnlyRequest(rows).timeline[0]).toMatchObject({ type: "sql", payload: { sql: statement } })
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

    expect(theOnlyRequest(rows).timeline.map(describeEvent)).toEqual(["SELECT 1"])
    expect(theOnlyRequest(rows).trailing.map(describeEvent)).toEqual(["Executor#to_complete ran after the body closed"])
    // Attribution was never in doubt, so a Trailing event still counts against its request.
    expect(theOnlyRequest(rows)).toMatchObject({ logCount: 1 })
  })

  test("leaves a request that has not finished no trailing section to put anything in", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1"), run.sql("req-1"), run.log("req-1"))

    const { rows } = await theReaderReads(log)

    expect(theOnlyRequest(rows).timeline).toHaveLength(2)
    expect(theOnlyRequest(rows).trailing).toHaveLength(0)
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

    expect(theOnlyRequest(rows).exception).toMatchObject({ class: "NoMethodError" })
    expect(theOnlyRequest(rows).exception?.backtrace).toHaveLength(2)
  })

  test("gives a request that finished without raising no exception rather than an empty one", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1"), run.finish("req-1"))

    const { rows } = await theReaderReads(log)

    expect(theOnlyRequest(rows).exception).toBeNull()
  })

  test("threads its owning Run's rails_root onto the request row", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.header(), run.start("req-1"), run.finish("req-1"))

    const { rows } = await theReaderReads(log)

    expect(theOnlyRequest(rows).railsRoot).toBe("/home/dev/example-app")
  })

  test("leaves a request's rails_root unknown when its Run's run_header was never seen", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    // No run.header() here: the Reader attached mid-stream.
    await appendToSidecar(log, run.start("req-1"), run.finish("req-1"))

    const { rows } = await theReaderReads(log)

    expect(theOnlyRequest(rows).railsRoot).toBeNull()
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

    expect(theOnlyRequest(rows).timeline.map(describeEvent)).toEqual([
      statement,
      "  \u21b3 app/controllers/posts_controller.rb:9",
    ])
    // The count and the timeline are one thing counted and the same thing listed.
    expect(theOnlyRequest(rows)).toMatchObject({ sqlCount: 1, logCount: 1 })
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

    expect(theOnlyRequest(rows).timeline.map(describeEvent)).toEqual(["SELECT 1", "about to run SELECT 1"])
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

    expect(theOnlyRequest(rows).timeline.map(describeEvent)).toEqual(["SELECT 1", "SELECT 2", "  Post Load (0.2ms)  SELECT 1"])
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
    expect(theOnlyRequest(rows).timeline).toHaveLength(2)
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

/**
 * The three states the wire never carries: *in-flight*, *Interrupted* and *Partial request*
 * appear nowhere in an envelope, and the fold concludes each of them from evidence in the
 * file — never from a clock, and never from a threshold.
 */
describe("what the fold concludes about a request", () => {
  test("holds a request with a start and no finish in flight", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.header(), run.start("req-1", "GET", "/hangs"), run.route("req-1"))

    const { rows } = await theReaderReads(log)

    expect(row(rows, "/hangs")).toMatchObject({ state: "in-flight", status: null, durationMs: null })
  })

  test("names the controller an in-flight request is stuck in, once its route has arrived", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.start("req-1", "GET", "/admin/reports/monthly.csv"),
      run.route("req-1", "ReportsController", "index"),
      run.log("req-1", "Building monthly report (this may take a while)"),
    )

    const { rows } = await theReaderReads(log)

    expect(row(rows, "/admin/reports/monthly.csv")).toMatchObject({
      state: "in-flight",
      controller: "ReportsController",
      action: "index",
    })
  })

  test("never times an in-flight request out, however long its Run goes on emitting", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const start = run.start("req-1", "GET", "/hangs")
    await appendToSidecar(
      log,
      start,
      // An hour later on the Run's own monotonic clock, and still nothing about this request.
      { ...run.log(null, "still here"), at_mono: start.at_mono + 3_600_000_000_000 },
    )

    const { rows } = await theReaderReads(log)

    expect(row(rows, "/hangs").state).toBe("in-flight")
  })

  test("climbs an in-flight request's elapsed with each of its own events, within its Run's clock", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    // The fixture ticks `at_mono` on 100ms per envelope, so this is two ticks of one clock.
    await appendToSidecar(log, run.start("req-1", "GET", "/hangs"), run.sql("req-1"), run.log("req-1"))

    const { rows } = await theReaderReads(log)

    // Measured to the last thing the request said, and joined to the wall clock there, so
    // the Reader can carry it forward through a silence the file has nothing to say about.
    expect(row(rows, "/hangs").provenElapsed).toEqual({ ms: 200, atWall: EPOCH + 300 })
  })

  test("marks a request Interrupted when its own Run ends under it", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.header(),
      run.start("req-1", "GET", "/reaped"),
      run.route("req-1"),
      run.end(),
    )

    const { rows } = await theReaderReads(log)

    expect(row(rows, "/reaped")).toMatchObject({ state: "interrupted", status: null, durationMs: null })
  })

  test("freezes an Interrupted request's elapsed at the moment its Run ended", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    // start, route, end: three ticks of the fixture's 100ms clock after the start.
    await appendToSidecar(log, run.start("req-1", "GET", "/reaped"), run.route("req-1"), run.end())

    const { rows } = await theReaderReads(log)

    expect(row(rows, "/reaped").provenElapsed?.ms).toBe(200)
  })

  test("concludes Interrupted from the next Run's header alone, with no run_end", async () => {
    const log = await aLogDirectory()
    const reaped = aRun("srv-1")
    const restarted = aRun("srv-2")
    await appendToSidecar(
      log,
      reaped.header(),
      reaped.start("req-1", "GET", "/killed"),
      reaped.route("req-1"),
      // SIGKILL: no at_exit, no run_end. The next boot's header is the whole evidence.
      restarted.header("server", 48_212),
      restarted.start("req-2", "GET", "/after-the-restart"),
    )

    const { rows } = await theReaderReads(log)

    expect(row(rows, "/killed").state).toBe("interrupted")
    expect(row(rows, "/after-the-restart").state).toBe("in-flight")
  })

  test("leaves a live request alone when a rake or console Run starts beside it", async () => {
    const log = await aLogDirectory()
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    const console = aRun("con-3")
    await appendToSidecar(
      log,
      server.header(),
      server.start("req-1", "GET", "/still-serving"),
      rake.header("rake", 91_887),
      console.header("console", 92_014),
    )

    const { rows } = await theReaderReads(log)

    // Neither says anything about the server: it is still there, still serving this request.
    expect(row(rows, "/still-serving").state).toBe("in-flight")
  })

  test("leaves a live request alone when another Run's run_end lands under it", async () => {
    const log = await aLogDirectory()
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    await appendToSidecar(log, server.start("req-1", "GET", "/still-serving"), rake.header("rake"), rake.end())

    const { rows } = await theReaderReads(log)

    expect(row(rows, "/still-serving").state).toBe("in-flight")
  })

  test("takes the finish of a request whose Run only looked ended", async () => {
    const log = await aLogDirectory()
    const server = aRun("srv-1")
    const restarted = aRun("srv-2")
    await appendToSidecar(
      log,
      server.start("req-1", "GET", "/finished-after-all"),
      restarted.header("server", 48_212),
      // The Reader inferred an ending; the file then said otherwise, and evidence wins.
      server.finish("req-1", { status: 200, duration_ms: 12.5 }),
    )

    const { rows } = await theReaderReads(log)

    expect(row(rows, "/finished-after-all")).toMatchObject({ state: "finished", status: 200, durationMs: 12.5 })
  })

  test("leaves a finished request finished when its Run ends afterwards", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1", "GET", "/done"), run.finish("req-1"), run.end())

    const { rows } = await theReaderReads(log)

    expect(row(rows, "/done").state).toBe("finished")
  })
})

/**
 * A *Partial request*: the Reader attached mid-flight, so it has the children and not the
 * parent. Stays marked through the live fold — a start arriving there is the wire out of
 * order, not a recovery — and clears only when a *load-earlier* pull turns up the start
 * itself; see the "load-earlier" describe block below for that half.
 */
describe("a request whose start the Reader never saw", () => {
  test("is a Partial request", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.sql("req-1"), run.log("req-1"))

    const { rows } = await theReaderReads(log)

    expect(theOnlyRequest(rows)).toMatchObject({ requestId: "req-1", partial: true, state: "in-flight" })
  })

  test("is promoted as its finish arrives, and stays Partial through it", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.sql("req-1"),
      run.route("req-1", "ReportsController", "monthly"),
      run.finish("req-1", { status: 200, duration_ms: 91.4 }),
    )

    const { rows } = await theReaderReads(log)

    expect(theOnlyRequest(rows)).toMatchObject({
      partial: true,
      state: "finished",
      controller: "ReportsController",
      action: "monthly",
      status: 200,
      durationMs: 91.4,
    })
  })

  test("stays Partial even if a start turns up for it later", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.sql("req-1"), run.start("req-1", "GET", "/late-start"))

    const { rows } = await theReaderReads(log)

    expect(theOnlyRequest(rows)).toMatchObject({ partial: true, method: "GET", path: "/late-start" })
  })

  test("leaves a request the Reader saw start alone", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.start("req-1"), run.sql("req-1"))

    const { rows } = await theReaderReads(log)

    expect(theOnlyRequest(rows).partial).toBe(false)
  })
})

/**
 * *Run rows*: everything a Run emitted with no owning request, in one row per Run, anchored
 * where the Run first said anything. No gap threshold splits one, because a threshold is the
 * timer this project refuses everywhere else.
 */
describe("Run rows", () => {
  test("gives a Run one row holding everything it emitted unattributed", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(
      log,
      run.header(),
      run.log(null, "=> Booting Puma"),
      run.sql(null, "SELECT sqlite_version(*)"),
      run.start("req-1"),
      run.sql("req-1", "SELECT 1"),
      // Minutes of quiet would sit here in a real file. Nothing splits the row.
      run.log(null, "[ActiveJob] [DeliverWebhookJob] Performed"),
    )

    const { rows } = await theReaderReads(log)

    expect(runs(rows)).toHaveLength(1)
    expect(runRow(rows, "srv-1")).toMatchObject({ runId: "srv-1", sqlCount: 1, logCount: 2 })
    expect(timeline(runRow(rows, "srv-1"))).toEqual([
      "=> Booting Puma",
      "SELECT sqlite_version(*)",
      "[ActiveJob] [DeliverWebhookJob] Performed",
    ])
  })

  test("carries what the run_header said about the process", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.header("rake", 91_887))

    const { rows } = await theReaderReads(log)

    expect(runRow(rows, "srv-1")).toMatchObject({
      runKind: "rake",
      pid: 91_887,
      railsVersion: "8.0.2",
      appName: "ExampleApp",
      railsRoot: "/home/dev/example-app",
    })
  })

  test("anchors the Run row at the append position where its run_header landed", async () => {
    const log = await aLogDirectory()
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    await appendToSidecar(
      log,
      server.header(),
      server.start("req-1", "GET", "/first"),
      rake.header("rake", 91_887),
      rake.sql(null),
      server.start("req-2", "GET", "/second"),
    )

    const { rows } = await theReaderReads(log)

    // Two Runs writing at once, each row where the file put it — neither slabbed above or
    // below the other.
    expect(rows.map((candidate) => (candidate.kind === "run" ? candidate.runId : candidate.path))).toEqual([
      "srv-1",
      "/first",
      "rake-2",
      "/second",
    ])
  })

  test("draws a Run marker where a server Run started", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    await appendToSidecar(log, run.header("server"))

    const { rows } = await theReaderReads(log)

    expect(runRow(rows, "srv-1").marker).toBe(true)
  })

  test("gives a rake Run and a console Run a row but no marker", async () => {
    const log = await aLogDirectory()
    const rake = aRun("rake-1")
    const console = aRun("con-2")
    await appendToSidecar(log, rake.header("rake", 91_887), rake.sql(null), console.header("console", 92_014))

    const { rows } = await theReaderReads(log)

    // A marker means "this Run started here". Neither of these ended the Run above it, so a
    // marker over the rows below would be a claim about traffic it has nothing to do with.
    expect(runRow(rows, "rake-1")).toMatchObject({ marker: false, sqlCount: 1 })
    expect(runRow(rows, "con-2").marker).toBe(false)
  })

  test("gives a Run the Reader attached inside a row, and no marker", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    // No header: the load-on-open window began after this Run booted.
    await appendToSidecar(log, run.log(null, "[ActiveJob] [SendDigestJob] Performing"))

    const { rows } = await theReaderReads(log)

    expect(runRow(rows, "srv-1")).toMatchObject({ marker: false, runKind: null, reopened: false, logCount: 1 })
  })

  test("gives a Run that emitted nothing unattributed no empty row of its own", async () => {
    const log = await aLogDirectory()
    // A forked Puma worker: its own Run, inheriting a boot that already happened, so it
    // writes no header of its own. A row with nothing in it is a home for nothing.
    const worker = aRun("srv-1-worker")
    await appendToSidecar(log, worker.start("req-1"), worker.sql("req-1"), worker.finish("req-1"))

    const { rows } = await theReaderReads(log)

    expect(runs(rows)).toHaveLength(0)
  })

  test("drops ActiveRecord's own line beside an unattributed query, as it does inside a request", async () => {
    const statement = 'SELECT "orders".* FROM "orders" WHERE "orders"."state" = ?'
    const log = await aLogDirectory()
    const run = aRun("rake-1")
    await appendToSidecar(
      log,
      run.header("rake", 91_887),
      run.sql(null, statement),
      run.log(null, `  Order Load (2.2ms)  ${statement}`, { severity: "debug", source: "rails" }),
    )

    const { rows } = await theReaderReads(log)

    expect(timeline(runRow(rows, "rake-1"))).toEqual([statement])
    expect(runRow(rows, "rake-1")).toMatchObject({ sqlCount: 1, logCount: 0 })
  })

  test("never doubles a Run row when the same bytes are read twice", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const events = [run.header(), run.log(null, "=> Booting Puma")]
    await appendToSidecar(log, ...events)
    const reader = await theReaderReads(log)

    await replaceSidecar(log, ...events, run.log(null, "Listening on http://127.0.0.1:3000"))
    await reader.caughtUp()

    expect(runs(reader.rows)).toHaveLength(1)
    expect(runRow(reader.rows, "srv-1").logCount).toBe(2)
  })
})

/**
 * The *Memory bound*: the fold holds no more events than the Reader opened on, and the
 * oldest rows leave first once it does. Two events to a row here — a start and a finish —
 * so a test can say how many rows a number of events comes to.
 */
function finishedRequests(run: ReturnType<typeof aRun>, count: number, from = 0) {
  return Array.from({ length: count }, (_, index) => [
    run.start(`req-${from + index}`, "GET", `/posts/${from + index}`),
    run.finish(`req-${from + index}`),
  ]).flat()
}

describe("the Memory bound", () => {
  test("gives up its oldest rows once it holds more events than it opened on", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const reader = await theReaderReads(log)

    // Ten rows past the bound, arriving live: the load-on-open window cannot overrun it,
    // because the same number sizes both.
    await appendToSidecar(log, ...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 10))
    await reader.caughtUp()

    expect(reader.rows).toHaveLength(LOAD_ON_OPEN_EVENTS / 2)
    expect(requests(reader.rows).at(0)?.path).toBe("/posts/10")
    expect(requests(reader.rows).at(-1)?.path).toBe(`/posts/${LOAD_ON_OPEN_EVENTS / 2 + 9}`)
    // Collectively over the ceiling before eviction, but no single one of these small rows
    // ever is, and more than one is left standing: none carries the last-row-standing mark.
    expect(reader.rows.every((candidate) => !candidate.overBound)).toBe(true)
  })

  // #63: the fold's own report of what it let go of, which is what lets the *Console* drop
  // the same rows' lines without a bound of its own.
  test("reports the id of every row it evicts, oldest first", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const reader = await theReaderReads(log)

    // Attached on a small, already-finished request first — under the bound — so the burst
    // below is read incrementally by the in-memory ring rather than through the load-on-open
    // backward scan a first read over an already-oversized file would take instead: that scan
    // would trim it to the ceiling on disk, before `evictToBound` ever ran to report it (#62).
    await appendToSidecar(log, run.start("req-attach"), run.finish("req-attach"))
    await reader.caughtUp()

    await appendToSidecar(log, ...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 10))
    await reader.caughtUp()

    expect(reader.evicted).toEqual([
      { id: "request req-attach", requestId: "req-attach" },
      ...Array.from({ length: 10 }, (_, index) => ({ id: `request req-${index}`, requestId: `req-${index}` })),
    ])
  })

  test("never evicts a request that is still in flight, however much arrives after it", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const reader = await theReaderReads(log)
    await appendToSidecar(log, run.start("req-hanging", "GET", "/reports"))
    await reader.caughtUp()

    await appendToSidecar(log, ...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 10, 100))
    await reader.caughtUp()

    // The oldest row in the table, and the one the Reader exists to show: a request that
    // hangs. Evicting it would be a timeout — one measured in other people's traffic.
    expect(reader.rows.at(0)?.id).toBe("request req-hanging")
    expect(row(reader.rows, "/reports").state).toBe("in-flight")
  })

  test("stops a finished request taking Trailing events the instant its row is evicted", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const reader = await theReaderReads(log)
    await appendToSidecar(log, run.header(), run.start("req-1"), run.finish("req-1"))
    await reader.caughtUp()

    await appendToSidecar(log, ...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2, 100))
    await reader.caughtUp()
    // The event that would have been a Trailing event, arriving after the horizon closed.
    await appendToSidecar(log, run.sql("req-1", "SELECT 'after the horizon'"))
    await reader.caughtUp()

    // Not a row of its own — a Partial request would be the fold claiming to have met a
    // request it has in fact forgotten — and not attributed to anything: its Run holds it.
    expect(requests(reader.rows).map((request) => request.requestId)).not.toContain("req-1")
    expect(runs(reader.rows).flatMap(timeline)).toContain("SELECT 'after the horizon'")
  })

  test("marks a Run row reopened when its evicted Run says something unattributed again", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const reader = await theReaderReads(log)
    // A server Run, so its first row carries a Run marker — which is the row this test
    // evicts, to check the marker does not survive onto the row that replaces it.
    await appendToSidecar(log, run.header(), run.sql(null))
    await reader.caughtUp()
    expect(runRow(reader.rows, "srv-1").marker).toBe(true)

    // Enough other traffic to push the Run row — the oldest row in the table — past the
    // bound and out.
    await appendToSidecar(log, ...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 10, 100))
    await reader.caughtUp()
    expect(runs(reader.rows)).toHaveLength(0)

    // The same Run, saying something unattributed again.
    await appendToSidecar(log, run.log(null, "[ActiveJob] [SendDigestJob] Performing"))
    await reader.caughtUp()

    // A fresh, header-less row — marked apart from a Run the Reader only ever attached
    // inside, which never had a row taken from it in the first place — and never alongside
    // a Run marker, which this row has no header of its own to draw one from.
    expect(runRow(reader.rows, "srv-1")).toMatchObject({ marker: false, runKind: null, reopened: true })
  })

  test("marks the last row standing over bound when a rake burst outgrows the ceiling alone", async () => {
    const log = await aLogDirectory()
    const run = aRun("rake-1")
    const reader = await theReaderReads(log)

    // Attached on a header alone, well under the bound, so the burst below is read as it
    // arrives rather than through the load-on-open scan a first read over an already-huge
    // file would take — that scan would trim it to the ceiling on its own, on disk, before
    // the in-memory ring ever saw more than it could hold.
    await appendToSidecar(log, run.header("rake"))
    await reader.caughtUp()

    // One Run, saying more unattributed things than the ceiling allows, with nothing else in
    // the file for the bound to evict instead.
    const burst = Array.from({ length: LOAD_ON_OPEN_EVENTS + 10 }, (_, index) => run.log(null, `record ${index}`))
    await appendToSidecar(log, ...burst)
    await reader.caughtUp()

    expect(reader.rows).toHaveLength(1)
    expect(runRow(reader.rows, "rake-1").overBound).toBe(true)
  })

  test("marks a Request row the same way, when it alone outgrows the ceiling", async () => {
    const log = await aLogDirectory()
    const run = aRun("srv-1")
    const reader = await theReaderReads(log)

    // Attached on the start alone, for the same reason as above.
    await appendToSidecar(log, run.start("req-1"))
    await reader.caughtUp()

    // No run_header and nothing unattributed, so this request's row is the only row the fold
    // ever opens: an N+1 with more queries than the ceiling, all its own.
    const queries = Array.from({ length: LOAD_ON_OPEN_EVENTS + 10 }, (_, index) => run.sql("req-1", `SELECT ${index}`))
    await appendToSidecar(log, ...queries, run.finish("req-1"))
    await reader.caughtUp()

    expect(reader.rows).toHaveLength(1)
    expect(row(reader.rows, "/posts/12").overBound).toBe(true)
  })

  test("never reads as trimmed: every event the last row standing holds is still there", async () => {
    const log = await aLogDirectory()
    const run = aRun("rake-1")
    const reader = await theReaderReads(log)

    await appendToSidecar(log, run.header("rake"))
    await reader.caughtUp()

    const burst = Array.from({ length: LOAD_ON_OPEN_EVENTS + 10 }, (_, index) => run.log(null, `record ${index}`))
    await appendToSidecar(log, ...burst)
    await reader.caughtUp()

    const oversized = runRow(reader.rows, "rake-1")
    expect(oversized.overBound).toBe(true)
    expect(oversized.logCount).toBe(burst.length)
    expect(oversized.timeline).toHaveLength(burst.length)
  })

  test("moves the mark rather than leaving it on two rows at once", async () => {
    const log = await aLogDirectory()
    const first = aRun("rake-1")
    const reader = await theReaderReads(log)

    await appendToSidecar(log, first.header("rake"))
    await reader.caughtUp()

    const firstBurst = Array.from({ length: LOAD_ON_OPEN_EVENTS + 10 }, (_, index) => first.log(null, `first ${index}`))
    await appendToSidecar(log, ...firstBurst)
    await reader.caughtUp()
    expect(runRow(reader.rows, "rake-1").overBound).toBe(true)

    // A second Run bursts the same way, appended once the file is already attached to — so
    // this too is read as it arrives rather than rescanned as history. The first Run's row is
    // the oldest in the table and evictable — a Run row always is — so the bound now has
    // somewhere else to look, and takes it: the mark is never on two rows at once.
    const second = aRun("rake-2")
    const secondBurst = Array.from({ length: LOAD_ON_OPEN_EVENTS + 10 }, (_, index) => second.log(null, `second ${index}`))
    await appendToSidecar(log, second.header("rake"), ...secondBurst)
    await reader.caughtUp()

    expect(runs(reader.rows).map((candidate) => candidate.runId)).toEqual(["rake-2"])
    expect(runRow(reader.rows, "rake-2").overBound).toBe(true)
  })
})

/**
 * Load-earlier: the same backward scan the Reader opened on, continued from an earlier
 * point when the developer asks for it. A file with more than the load-on-open figure in it
 * is the whole apparatus — what the load-on-open figure leaves behind is what the control goes and gets.
 */
async function aSidecarWithHistory(log: string) {
  const server = aRun("srv-1")
  const rake = aRun("rake-1")
  const head = [
    server.header(),
    rake.log(null, "rake-1 counted the posts"),
    server.start("req-1"),
    server.sql("req-1", "SELECT 'the query before the history'"),
  ]
  const filler = Array.from({ length: LOAD_ON_OPEN_EVENTS }, (_, index) =>
    server.log(null, `filler ${index}`),
  )
  await appendToSidecar(log, ...head, ...filler, server.finish("req-1"))
  return { server }
}

describe("load-earlier", () => {
  test("opens the rows the earlier block holds above the rows already there", async () => {
    const log = await aLogDirectory()
    await aSidecarWithHistory(log)
    const reader = await theReaderReads(log)

    expect(runs(reader.rows).map((run) => run.runId)).toEqual(["srv-1"])

    await reader.loadEarlier()

    // The rake Run said nothing inside the loaded history, so its row is new — and it is above the
    // rows that were already there, because that is where its earliest event sits.
    expect(reader.rows.at(0)?.id).toBe("run rake-1")
    expect(timeline(runRow(reader.rows, "rake-1"))).toEqual(["rake-1 counted the posts"])
  })

  test("promotes the request the history cut in half, without moving its row", async () => {
    const log = await aLogDirectory()
    await aSidecarWithHistory(log)
    const reader = await theReaderReads(log)

    const before = reader.rows.indexOf(theOnlyRequest(reader.rows))
    expect(theOnlyRequest(reader.rows).path).toBeNull()
    // Cut in half by the window: the fold met its finish and not its start, so it opened
    // Partial — the mark this test exists to watch clear.
    expect(theOnlyRequest(reader.rows).partial).toBe(true)

    await reader.loadEarlier()

    const request = theOnlyRequest(reader.rows)
    expect(request.path).toBe("/posts/12")
    // The query it ran before the history opened, in front of a timeline it was not in.
    expect(timeline(request)).toEqual(["SELECT 'the query before the history'"])
    expect(reader.rows.indexOf(request)).toBe(before + 1)
    // The pull recovered the very `request_start` the row was missing: not lost, recovered.
    expect(request.partial).toBe(false)
  })

  test("backfills rails_root onto a request opened before the pull recovered its header", async () => {
    const log = await aLogDirectory()
    await aSidecarWithHistory(log)
    const reader = await theReaderReads(log)

    // The request row opened off the finish the load-on-open window caught; the Run row it
    // belongs to opened earlier still, off an unattributed filler line, with no header seen
    // yet either — the same gap the Run marker goes undrawn over.
    expect(theOnlyRequest(reader.rows).railsRoot).toBeNull()

    await reader.loadEarlier()

    // The pull's earlier block carries the header the row opened without — recovered, same
    // as the request's own start above, rather than left reading "unknown" forever.
    expect(theOnlyRequest(reader.rows).railsRoot).toBe("/home/dev/example-app")
  })

  test("leaves a request Partial when the pull does not reach its start", async () => {
    const log = await aLogDirectory()
    const server = aRun("srv-1")
    const filler = Array.from({ length: LOAD_ON_OPEN_EVENTS }, (_, index) => server.log(null, `filler ${index}`))
    // The start sits before even the earlier block reaches: nothing here ever turns it up.
    await appendToSidecar(log, server.header(), server.sql("req-1"), ...filler, server.finish("req-1"))
    const reader = await theReaderReads(log)
    expect(theOnlyRequest(reader.rows).partial).toBe(true)

    await reader.loadEarlier()

    // The header is the oldest event in the file, so the pull stops there — genuinely gone,
    // and the mark says so.
    expect(theOnlyRequest(reader.rows).partial).toBe(true)
  })

  test("keeps what it was asked for rather than evicting it under the next request", async () => {
    const log = await aLogDirectory()
    const { server } = await aSidecarWithHistory(log)
    const reader = await theReaderReads(log)
    await reader.loadEarlier()

    await appendToSidecar(log, ...finishedRequests(server, 20, 500))
    await reader.caughtUp()

    // The bound is on what the Reader accumulates by itself: history the developer went and
    // asked for does not evaporate under the first request to arrive after it.
    expect(reader.rows.at(0)?.id).toBe("run rake-1")
    expect(timeline(runRow(reader.rows, "rake-1"))).toEqual(["rake-1 counted the posts"])
  })

  // #63: the ceiling rises by exactly what a pull brings in, so the ordinary pull evicts
  // nothing — the *Console*, told about a pull's evictions the same way as a live fold's, has
  // nothing to do most of the time this control is clicked.
  test("reports nothing evicted by the ordinary pull, because its ceiling rises with it", async () => {
    const log = await aLogDirectory()
    await aSidecarWithHistory(log)
    const reader = await theReaderReads(log)

    await reader.loadEarlier()

    expect(reader.evicted).toEqual([])
  })
})
