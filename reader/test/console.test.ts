import { describe, expect, test } from "bun:test"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC } from "./traffic.fixtures"
import { consoleStream } from "../src/shared/console"
import { activityTable, requestRowId, runRowId, type EvictedRow } from "../src/shared/activity"

/**
 * Seam 1, the Console's half: envelopes in append order become *Console* lines. The Console
 * reads the envelope stream and never the Activity fold, which is what makes "every App log
 * event, attributed or not" true by construction rather than by remembering to keep one.
 */

function theConsole(...envelopes: Parameters<ReturnType<typeof consoleStream>["fold"]>[0]) {
  const stream = consoleStream()
  stream.fold(envelopes)
  return stream
}

function messages(stream: ReturnType<typeof consoleStream>) {
  return stream.lines.map((line) => line.event.payload.message)
}

describe("the Console stream", () => {
  test("keeps every App log event in append order, attributed and unattributed alike", () => {
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    const stream = theConsole(
      server.log(null, "=> Booting Puma"),
      server.start("req-1"),
      server.log("req-1", "Feed cache MISS"),
      rake.log(null, "reports:rebuild — 41,209 orders"),
      server.log("req-1", "Feed cache WRITE"),
    )

    expect(messages(stream)).toEqual([
      "=> Booting Puma",
      "Feed cache MISS",
      "reports:rebuild — 41,209 orders",
      "Feed cache WRITE",
    ])
  })

  test("contains no SQL at all, however the query was attributed", () => {
    const run = aRun("srv-1")
    const stream = theConsole(
      run.header(),
      run.start("req-1"),
      run.sql("req-1"),
      run.sql(null),
      run.log("req-1", "the only line here"),
      run.finish("req-1"),
      run.end(),
    )

    expect(messages(stream)).toEqual(["the only line here"])
  })

  test("keeps the Echo, which is the one place it is kept", () => {
    // The detail column drops this line — the same query said again and worse. The Console
    // is the log, so the log is what it shows.
    const run = aRun("srv-1")
    const stream = theConsole(
      run.sql("req-1", 'SELECT "posts".* FROM "posts"'),
      run.log("req-1", '  Post Load (0.4ms)  SELECT "posts".* FROM "posts"', { source: "rails" }),
    )

    expect(messages(stream)).toHaveLength(1)
  })

  test("names the Activity table row each line selects: its request's, or its Run's", () => {
    const run = aRun("srv-1")
    const stream = theConsole(run.log("req-1", "attributed"), run.log(null, "unattributed"))

    expect(stream.lines.map((line) => line.owner)).toEqual(["request req-1", "run srv-1"])
  })

  test("names a row the Activity fold actually holds, for every line of a dense stream", () => {
    // The two folds read the same file and must agree about what a row is called: a Console
    // click that named a row nothing holds would select nothing at all.
    const activity = activityTable()
    activity.fold(DENSE_TRAFFIC)
    const stream = theConsole(...DENSE_TRAFFIC)
    const held = new Set(activity.rows.map((row) => row.id))

    expect(stream.lines).toHaveLength(159)
    expect(stream.lines.filter((line) => !held.has(line.owner))).toEqual([])
  })

  test("is safe to hand the same bytes twice, because `(run_id, seq)` is the event identity", () => {
    const run = aRun("srv-1")
    const [first, second] = [run.log(null, "once"), run.log(null, "twice")]
    const stream = consoleStream()

    stream.fold([first, second])
    stream.fold([first, second])

    expect(messages(stream)).toEqual(["once", "twice"])
  })

  test("keys each line by that same identity, so two Runs' first lines are two lines", () => {
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    const stream = theConsole(server.log(null, "from the server"), rake.log(null, "from the rake task"))

    expect(new Set(stream.lines.map((line) => line.id)).size).toBe(2)
  })
})

/** An evicted Run row: `activityTable` never gives a Run row a `requestId`. */
function evictedRun(runId: string): EvictedRow {
  return { id: runRowId(runId), requestId: null }
}

/** An evicted Request row, exactly as `activityTable` reports one. */
function evictedRequest(requestId: string): EvictedRow {
  return { id: requestRowId(requestId), requestId }
}

/**
 * #63: the Console's retention borrows the Activity fold's own eviction rather than counting
 * a bound of its own. `evict` is the seam that carries it — the same `EvictedRow`s
 * `activityTable`'s `fold` and `foldEarlier` report.
 */
describe("evicting a line's owning row", () => {
  test("removes every line whose owner was evicted, and nothing else", () => {
    const run = aRun("srv-1")
    const stream = theConsole(
      run.log("req-1", "kept: from a request still held"),
      run.log(null, "gone: unattributed to the evicted Run"),
      run.log("req-2", "gone: from the evicted request"),
    )

    stream.evict([evictedRun("srv-1"), evictedRequest("req-2")])

    expect(messages(stream)).toEqual(["kept: from a request still held"])
  })

  test("takes the Echo with it, being the same line an ordinary App log event is", () => {
    const run = aRun("srv-1")
    const stream = theConsole(
      run.sql("req-1", 'SELECT "posts".* FROM "posts"'),
      run.log("req-1", '  Post Load (0.4ms)  SELECT "posts".* FROM "posts"', { source: "rails" }),
    )
    expect(stream.lines).toHaveLength(1)

    stream.evict([evictedRequest("req-1")])

    expect(stream.lines).toHaveLength(0)
  })

  test("leaves every other line in its original order", () => {
    const run = aRun("srv-1")
    const stream = theConsole(run.log("req-1", "first"), run.log("req-2", "second"), run.log("req-1", "third"))

    stream.evict([evictedRequest("req-2")])

    expect(messages(stream)).toEqual(["first", "third"])
  })

  test("is a no-op when nothing was evicted", () => {
    const stream = theConsole(aRun("srv-1").log(null, "still here"))

    stream.evict([])

    expect(messages(stream)).toEqual(["still here"])
  })

  test("forgets the evicted lines' own identity, so the same bytes read again read as new", () => {
    // The same reading a Trailing event gets once its request's row is out of memory
    // entirely (#44): forgotten rather than remembered forever with nothing left to point
    // at, which is what `activityTable`'s own dedup sets already do once a row leaves.
    const line = aRun("srv-1").log(null, "reports:rebuild — 41,209 orders")
    const stream = consoleStream()
    stream.fold([line])
    stream.evict([evictedRun("srv-1")])
    expect(stream.lines).toHaveLength(0)

    stream.fold([line])

    expect(messages(stream)).toEqual(["reports:rebuild — 41,209 orders"])
  })

  // The Console's own half of the *attribution horizon*: a request past it does not get a
  // row of its own again, so a line printed for one now belongs to whichever Run wrote it —
  // exactly what `activityTable`'s own `foldOne` already does with a Trailing event past the
  // same horizon (CONTEXT.md, "Trailing event"). Without this, a line arriving for an
  // already-evicted request would carry an `owner` no future eviction will ever name again —
  // an orphan `evict` can never reach.
  test("attributes a later line for an already-evicted request to its Run, not to the row that is gone", () => {
    const run = aRun("srv-1")
    const stream = consoleStream()
    stream.fold([run.log("req-1", "before the row was evicted")])
    stream.evict([evictedRequest("req-1")])
    expect(stream.lines).toHaveLength(0)

    stream.fold([run.log("req-1", "a Trailing event arriving after the horizon closed")])

    expect(stream.lines).toHaveLength(1)
    expect(stream.lines[0]).toMatchObject({ owner: "run srv-1" })
  })

  test("leaves attribution alone for a request whose row is still held", () => {
    const run = aRun("srv-1")
    const stream = theConsole(run.log("req-1", "ordinary line"))

    expect(stream.lines[0]).toMatchObject({ owner: "request req-1" })
  })
})
