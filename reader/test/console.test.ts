import { describe, expect, test } from "bun:test"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC } from "./traffic.fixtures"
import { consoleStream } from "../src/shared/console"
import { activityTable } from "../src/shared/activity"

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
