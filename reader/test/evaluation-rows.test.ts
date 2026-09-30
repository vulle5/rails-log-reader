import { describe, expect, test } from "bun:test"

import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"
import { activityTable, type ActivityRow, type EvaluationRow, type TimelineEvent } from "../src/shared/activity"
import type { Envelope } from "../src/shared/wire"
import { aRun, EPOCH } from "./sidecar.fixtures"

/**
 * The fold's *Evaluation rows*: what the REPL's console process ran, each evaluation owning the
 * queries and log lines carrying its id, the way a request owns its own.
 */

function folded(...envelopes: Envelope[]) {
  const activity = activityTable()
  activity.fold(envelopes)
  return activity
}

function evaluations(rows: readonly ActivityRow[]): EvaluationRow[] {
  return rows.filter((row) => row.kind === "evaluation")
}

function theOnlyEvaluation(rows: readonly ActivityRow[]) {
  const only = evaluations(rows)
  if (only.length !== 1) throw new Error(`${only.length} Evaluation rows, not one`)
  return only[0] as EvaluationRow
}

/** What a timeline holds, in the order it holds it. */
function said(events: readonly TimelineEvent[]) {
  return events.map((event) => (event.type === "sql" ? event.payload.sql : event.payload.message))
}

describe("an Evaluation row", () => {
  test("opens where its evaluation_start was appended, in flight, saying what ran", () => {
    const server = aRun("srv-1")
    const consoleRun = aRun("con-1")
    const { rows } = folded(
      server.header(),
      consoleRun.header("console", 92_014),
      server.start("req-1"),
      consoleRun.evaluationStart("repl-a-1", "Post.count\nComment.count", true),
    )

    expect(rows.map((row) => row.kind)).toEqual(["run", "run", "request", "evaluation"])
    expect(theOnlyEvaluation(rows)).toMatchObject({
      id: "request repl-a-1",
      evaluationId: "repl-a-1",
      runId: "con-1",
      state: "in-flight",
      partial: false,
      input: "Post.count\nComment.count",
      inputCutFrom: null,
      sandbox: true,
      outcome: null,
      exception: null,
      durationMs: null,
      startedAtWall: EPOCH + 200,
    })
  })

  test("finishes ok with the DB time Rails counted, and lasts from its start to its finish", () => {
    const run = aRun("con-1")
    const { rows } = folded(
      run.header("console"),
      run.evaluationStart("repl-a-1"),
      run.sql("repl-a-1", 'SELECT COUNT(*) FROM "posts"'),
      run.evaluationFinish("repl-a-1", { outcome: "ok", db_runtime_ms: 0.8 }),
    )

    expect(theOnlyEvaluation(rows)).toMatchObject({
      state: "finished",
      outcome: "ok",
      exception: null,
      dbRuntimeMs: 0.8,
      // Two ticks of the fixture's clock, 100ms each.
      durationMs: 200,
    })
  })

  test("finishes raised, with the exception's class and message, saying when the wire cut either", () => {
    const run = aRun("con-1")
    const { rows } = folded(
      run.evaluationStart("repl-a-1", "raise 'x' * 70_000", false, { input: 70_020 }),
      run.evaluationFinish("repl-a-1", { outcome: "raised", class: "RuntimeError", message: "xxx" }, { message: 70_000 }),
    )

    expect(theOnlyEvaluation(rows)).toMatchObject({
      state: "finished",
      outcome: "raised",
      exception: { class: "RuntimeError", message: "xxx" },
      messageCutFrom: 70_000,
      inputCutFrom: 70_020,
      dbRuntimeMs: null,
    })
  })

  test("owns the queries and log lines carrying its id, in the order they were emitted, Echoes dropped", () => {
    const run = aRun("con-1")
    const { rows } = folded(
      run.header("console"),
      run.evaluationStart("repl-a-1"),
      run.log("repl-a-1", "counting"),
      run.sql("repl-a-1", 'SELECT COUNT(*) FROM "posts"'),
      run.log("repl-a-1", '  Post Count (0.1ms)  SELECT COUNT(*) FROM "posts"', { source: "rails" }),
      run.evaluationFinish("repl-a-1"),
    )

    const evaluation = theOnlyEvaluation(rows)
    expect(said(evaluation.timeline)).toEqual(["counting", 'SELECT COUNT(*) FROM "posts"'])
    expect(evaluation).toMatchObject({ sqlCount: 1, logCount: 1, trailing: [] })
  })

  test("files what arrives after its finish in its trailing section", () => {
    const run = aRun("con-1")
    const { rows } = folded(
      run.evaluationStart("repl-a-1"),
      run.evaluationFinish("repl-a-1"),
      run.log("repl-a-1", "after the fact"),
    )

    const evaluation = theOnlyEvaluation(rows)
    expect(evaluation.timeline).toEqual([])
    expect(said(evaluation.trailing)).toEqual(["after the fact"])
    expect(evaluation.logCount).toBe(1)
  })

  test("leaves what the console emits outside it, and what a thread it started emits, in the Run row", () => {
    const run = aRun("con-1")
    const { rows } = folded(
      run.header("console"),
      run.log(null, "Loading development environment"),
      run.evaluationStart("repl-a-1"),
      run.sql(null, 'SELECT COUNT(*) FROM "authors"'),
      run.sql("repl-a-1", 'SELECT COUNT(*) FROM "posts"'),
      run.evaluationFinish("repl-a-1"),
    )

    const runRow = rows.find((row) => row.kind === "run")
    expect(said(runRow?.timeline ?? [])).toEqual(["Loading development environment", 'SELECT COUNT(*) FROM "authors"'])
    expect(said(theOnlyEvaluation(rows).timeline)).toEqual(['SELECT COUNT(*) FROM "posts"'])
  })

  test("gives each evaluation a row of its own", () => {
    const run = aRun("con-1")
    const { rows } = folded(
      run.evaluationStart("repl-a-1", "Post.count"),
      run.evaluationFinish("repl-a-1"),
      run.evaluationStart("repl-a-2", "Post.count"),
      run.evaluationFinish("repl-a-2"),
    )

    expect(evaluations(rows).map((row) => row.evaluationId)).toEqual(["repl-a-1", "repl-a-2"])
  })

  test("is Interrupted by its own Run's run_end, and by no server booting beside it", () => {
    const server = aRun("srv-1")
    const consoleRun = aRun("con-1")
    const activity = folded(consoleRun.header("console"), consoleRun.evaluationStart("repl-a-1"), server.header("server"))

    expect(theOnlyEvaluation(activity.rows).state).toBe("in-flight")

    activity.fold([consoleRun.end()])
    expect(theOnlyEvaluation(activity.rows).state).toBe("interrupted")
  })

  test("becomes an Evaluation row when the finish of one arrives for a row opened by its children", () => {
    const run = aRun("con-1")
    const { rows } = folded(run.header("console"), run.sql("repl-a-1", 'SELECT 1'), run.evaluationFinish("repl-a-1"))

    expect(rows.map((row) => row.kind)).toEqual(["run", "evaluation"])
    expect(theOnlyEvaluation(rows)).toMatchObject({ partial: true, input: null, outcome: "ok", sqlCount: 1 })
  })

  test("lands an old-wire console's queries in its Run row", () => {
    const run = aRun("con-1")
    const { rows } = folded(run.header("console"), run.sql(null, 'SELECT COUNT(*) FROM "posts"'))

    expect(rows.map((row) => row.kind)).toEqual(["run"])
    expect(rows[0]?.sqlCount).toBe(1)
  })
})

/**
 * A console process killed too hard to write a `run_end`: the Reader, its parent, reports the
 * exit with its pid, and that ends the latest console Run whose `run_header` carried it.
 */
describe("an Evaluation row whose console process exited", () => {
  test("is Interrupted by the exit of its Run's pid", () => {
    const run = aRun("con-1")
    const activity = folded(run.header("console", 92_014), run.evaluationStart("repl-a-1", "sleep 60"))

    activity.consoleExited(92_014)

    expect(theOnlyEvaluation(activity.rows).state).toBe("interrupted")
  })

  test("is left in flight by the exit of another pid", () => {
    const run = aRun("con-1")
    const activity = folded(run.header("console", 92_014), run.evaluationStart("repl-a-1", "sleep 60"))

    activity.consoleExited(92_015)

    expect(theOnlyEvaluation(activity.rows).state).toBe("in-flight")
  })

  test("is left as it finished", () => {
    const run = aRun("con-1")
    const activity = folded(run.header("console", 92_014), run.evaluationStart("repl-a-1"), run.evaluationFinish("repl-a-1"))

    activity.consoleExited(92_014)

    expect(theOnlyEvaluation(activity.rows)).toMatchObject({ state: "finished", outcome: "ok" })
  })

  test("ends only the latest console Run under that pid, and no server's", () => {
    const earlier = aRun("con-1")
    const server = aRun("srv-1")
    const latest = aRun("con-2")
    const activity = folded(
      earlier.header("console", 92_014),
      earlier.evaluationStart("repl-a-1"),
      server.header("server", 92_014),
      server.start("req-1"),
      latest.header("console", 92_014),
      latest.evaluationStart("repl-b-1", "sleep 60"),
    )

    activity.consoleExited(92_014)

    expect(evaluations(activity.rows).map((row) => [row.evaluationId, row.state])).toEqual([
      ["repl-a-1", "in-flight"],
      ["repl-b-1", "interrupted"],
    ])
    expect(activity.rows.find((row) => row.kind === "request")?.state).toBe("in-flight")
  })

  test("is Interrupted when its events arrive after the exit, which travels apart from the Sidecar", () => {
    const run = aRun("con-1")
    const activity = folded(run.header("console", 92_014))

    activity.consoleExited(92_014)
    activity.fold([run.evaluationStart("repl-a-1", "Process.kill(:KILL, Process.pid)")])

    expect(theOnlyEvaluation(activity.rows).state).toBe("interrupted")
  })

  test("still finishes when its finish arrives after the exit", () => {
    const run = aRun("con-1")
    const activity = folded(run.header("console", 92_014), run.evaluationStart("repl-a-1"))

    activity.consoleExited(92_014)
    activity.fold([run.evaluationFinish("repl-a-1")])

    expect(theOnlyEvaluation(activity.rows).state).toBe("finished")
  })
})

describe("an Evaluation row under the Memory bound", () => {
  /** Enough finished requests to push the fold past its ceiling on their own. */
  function traffic(count: number) {
    const server = aRun("srv-1")
    return Array.from({ length: count }, (_, at) => [server.start(`req-${at}`), server.finish(`req-${at}`)]).flat()
  }

  test("is never evicted while in flight", () => {
    const run = aRun("con-1")
    const activity = folded(run.evaluationStart("repl-a-1"), ...traffic(LOAD_ON_OPEN_EVENTS))

    expect(evaluations(activity.rows).map((row) => row.evaluationId)).toEqual(["repl-a-1"])
  })

  test("is evicted like a request once finished, and past it its events are the Run's", () => {
    const run = aRun("con-1")
    const activity = activityTable()
    activity.fold([run.evaluationStart("repl-a-1"), run.evaluationFinish("repl-a-1")])
    const evicted = activity.fold(traffic(LOAD_ON_OPEN_EVENTS))

    expect(evicted).toContainEqual({ id: "request repl-a-1", requestId: "repl-a-1" })
    expect(evaluations(activity.rows)).toEqual([])

    activity.fold([run.log("repl-a-1", "too late")])
    expect(activity.rows.at(-1)).toMatchObject({ kind: "run", runId: "con-1", logCount: 1 })
  })

  test("is Interrupted by its console's exit after the bound took its Run row", () => {
    const run = aRun("con-1")
    const activity = activityTable()
    activity.fold([run.header("console", 92_014), run.log(null, "Loading development environment"), run.evaluationStart("repl-a-1", "sleep 60")])
    activity.fold(traffic(LOAD_ON_OPEN_EVENTS))
    expect(activity.rows.some((row) => row.kind === "run" && row.runId === "con-1")).toBe(false)

    activity.consoleExited(92_014)

    expect(theOnlyEvaluation(activity.rows).state).toBe("interrupted")
  })
})
