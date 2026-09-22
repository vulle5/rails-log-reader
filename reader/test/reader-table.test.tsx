import { describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"

import { aRun } from "./sidecar.fixtures"
import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"
import type { Envelope } from "../src/shared/wire"
import { activityRows, cellUnder, column, openTheReader, rowShowing, tab } from "./reader.harness"

/**
 * Seam 2: the Activity table over a seeded model — seeded by folding envelopes, so the
 * shape the component is mounted over is the shape Seam 1 produces and not a second one.
 * Testing Library's cleanup unmounts it after each test, which matters: an in-flight row's
 * elapsed pill holds an interval for as long as it is mounted.
 */
function theActivityTable(...envelopes: Envelope[]) {
  return openTheReader(envelopes)
}

/**
 * How long the elapsed pill reads, in seconds. Parsed rather than compared as a string,
 * because the pill measures from the machine's own clock: the last tenth of it is however
 * long this test took to render, and a test that pinned the spelling would be asserting that
 * as well.
 */
function elapsedSeconds(row = firstRow()) {
  const pill = cellUnder(row, "Total").textContent
  if (pill === null || pill === "") throw new Error("the row is showing no elapsed")

  const read = /^(?:(\d+)h )?(?:(\d+)m )?(?:(\d+(?:\.\d)?)s)?$/.exec(pill)
  if (read === null) throw new Error(`the pill reads ${pill}, which is no elapsed this Reader writes`)

  const [hours, minutes, seconds] = [...read].slice(1).map((part) => Number(part ?? 0))
  return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0)
}

function headings() {
  return within(column("Activity table"))
    .getAllByRole("columnheader")
    .map((heading) => heading.textContent)
}

function firstRow() {
  const row = activityRows()[0]
  if (row === undefined) throw new Error("the table has no rows")
  return row
}

function cells(row = firstRow()) {
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent)
}

describe("the Activity table", () => {
  test("heads its columns with what a request cost", () => {
    const run = aRun("srv-1")
    theActivityTable(run.start("req-1"), run.finish("req-1"))

    expect(headings()).toEqual([
      "Started",
      "Status",
      "Method",
      "Path",
      "Controller#action",
      "SQL",
      "Log",
      "DB",
      "View",
      "Total",
    ])
  })

  test("shows one row per request, folded from its three events and its children", () => {
    const run = aRun("srv-1")
    theActivityTable(
      run.start("req-1", "GET", "/posts/12"),
      run.route("req-1", "PostsController", "show"),
      run.sql("req-1"),
      run.sql("req-1"),
      run.log("req-1"),
      run.finish("req-1", { status: 200, duration_ms: 78.3, view_runtime_ms: 61.2, db_runtime_ms: 1.4 }),
    )

    expect(activityRows()).toHaveLength(1)
    expect(cells()).toEqual([
      expect.stringMatching(/^\d\d:\d\d:\d\d\.\d\d\d$/),
      "200",
      "GET",
      "/posts/12",
      "Posts#show",
      "2",
      "1",
      "1.4ms",
      "61ms",
      "78ms",
    ])
  })

  test("gives a request that failed to route a row too, showing its method and path", () => {
    const run = aRun("srv-1")
    theActivityTable(run.start("req-404", "GET", "/pots/12"), run.finish("req-404", { status: 404, duration_ms: 3.1 }))

    expect(cells().slice(1)).toEqual(["404", "GET", "/pots/12", "—", "", "", "", "", "3.1ms"])
  })

  test("keeps rows in the order the fold appended them", () => {
    const run = aRun("srv-1")
    theActivityTable(run.start("req-1", "GET", "/first"), run.start("req-2", "GET", "/second"), run.finish("req-1"))

    expect(activityRows().map((row) => cellUnder(row, "Path").textContent)).toEqual(["/first", "/second"])
  })

  test("leaves a request that has not finished unanswered rather than guessing at it", () => {
    const run = aRun("srv-1", Date.now())
    theActivityTable(run.start("req-1", "GET", "/hangs"), run.route("req-1"))

    // No status, because nothing has been decided yet — but the total is not blank: how long
    // this has been running is measured, not guessed, and is the whole signal a hang gives.
    expect(cells()[1]).toBe("")
    expect(elapsedSeconds()).toBeGreaterThanOrEqual(0.1)
    expect(elapsedSeconds()).toBeLessThan(2)
  })
})

/**
 * The states the fold concluded, on screen. Nothing here is a threshold or a colour of
 * alarm: an in-flight request looks like a request that is still running, however long it
 * has been doing it, and the human draws the conclusion.
 */
describe("what a row says it is", () => {
  test("shows an in-flight request as a live dot and a climbing elapsed, with no status", () => {
    // A Run writing right now, because what the pill reads is a distance from the clock this
    // test is running on and not a number the file carries.
    const run = aRun("srv-1", Date.now())
    theActivityTable(
      run.start("req-1", "GET", "/admin/reports/monthly.csv"),
      run.route("req-1", "Admin::ReportsController", "monthly"),
      // Two ticks of the fixture's 100ms clock after the start.
      run.log("req-1", "Building monthly report (this may take a while)"),
    )

    expect(cells()[1]).toBe("")
    expect(within(firstRow()).getByRole("img")).toHaveAccessibleName("In flight")
    // It hangs in Admin::ReportsController#monthly, rather than merely hanging.
    expect(cells()[4]).toBe("Admin::Reports#monthly")
    expect(elapsedSeconds()).toBeGreaterThanOrEqual(0.2)
    expect(elapsedSeconds()).toBeLessThan(2)
  })

  test("reads a request that was already hanging when the Reader opened at its true age", () => {
    // The case the pill exists for, and the one a mount-time anchor gets wrong: this hang
    // began four minutes before the Reader was started, so all of it is history by the time
    // the fold sees it and none of the wait is time this tab was open for.
    const run = aRun("srv-1", Date.now() - 240_000)
    theActivityTable(
      run.start("req-1", "GET", "/admin/reports/monthly.csv"),
      run.route("req-1", "Admin::ReportsController", "monthly"),
      run.sql("req-1"),
    )

    // Not the 0.2s of it the file happens to cover: the silence since is the hang.
    expect(elapsedSeconds()).toBeGreaterThan(238)
    expect(elapsedSeconds()).toBeLessThan(245)
  })

  test("styles an Interrupted row distinctly, and never as an error", () => {
    const reaped = aRun("srv-1")
    const restarted = aRun("srv-2")
    theActivityTable(reaped.header(), reaped.start("req-1", "GET", "/killed"), restarted.header("server", 48_212))

    const row = rowShowing("/killed")

    expect(row).toHaveAttribute("data-state", "interrupted")
    // Nothing anywhere in the row — no category, no status, no dot — says error.
    expect(row.outerHTML).not.toContain("error")
    expect(within(row).getByRole("img")).toHaveAccessibleName("Interrupted")
  })

  // #45's other half, on screen. A request whose finish carried no duration at all has
  // finished — dot gone, status shown — and the column that would hold its total falls back to
  // what the Reader proved, frozen, rather than to a number nobody wrote down.
  test("shows a finished request whose finish carried no duration as its proven elapsed", () => {
    const run = aRun("srv-1")
    theActivityTable(run.start("req-1", "GET", "/posts/12"), run.finish("req-1", { status: 200, duration_ms: undefined }))

    expect(cells()[1]).toBe("200")
    expect(within(cellUnder(firstRow(), "Total")).getByText("0.1s")).toHaveAttribute("data-elapsed", "frozen")
    // The 100ms between the request's own two events, and never `0ms` or `NaNms`.
    expect(elapsedSeconds()).toBe(0.1)
  })

  // #47: a request that raised before it had a response finishes with a `null` status, and an
  // empty cell would read as a request that simply had nothing to say there — the one row an
  // error most needs to look like one.
  test("says a finished request that never had a response had no status, rather than leaving it blank", () => {
    const run = aRun("srv-1")
    theActivityTable(
      run.start("req-1", "GET", "/posts"),
      run.finish("req-1", {
        status: null,
        duration_ms: 0.48,
        exception: {
          class: "ActionDispatch::RemoteIp::IpSpoofAttackError",
          message: "IP spoofing attack?!",
          backtrace: [],
        },
      }),
    )

    expect(cells()[1]).toBe("none")
    expect(within(firstRow()).queryByRole("img")).not.toBeInTheDocument()
    const mark = within(cellUnder(firstRow(), "Status")).getByText("none")
    expect(mark).toHaveAttribute("title", "Raised before it had a response")
  })

  test("marks a Partial request, and keeps it marked once its finish promotes it", () => {
    const run = aRun("srv-1")
    theActivityTable(
      run.sql("req-1"), // a child of a request whose start the Reader never saw
      run.route("req-1", "PostsController", "show"),
      run.finish("req-1", { status: 200, duration_ms: 12.5 }),
    )

    expect(within(cellUnder(firstRow(), "Started")).getByText("partial")).toBeInTheDocument()
    expect(cells()[1]).toBe("200")
    expect(cells()[9]).toBe("13ms")
  })

  // #62: the last row standing, over the Memory bound's usual ceiling because taking it too
  // would leave the table empty rather than bounded.
  test("marks the last row standing over bound, never as trimmed", () => {
    const run = aRun("rake-1")
    const burst = Array.from({ length: LOAD_ON_OPEN_EVENTS + 10 }, (_, index) => run.log(null, `record ${index}`))
    theActivityTable(run.header("rake"), ...burst)

    const mark = within(firstRow()).getByText("over bound")
    expect(mark).toHaveTextContent(/^over bound$/)
    expect(mark).not.toHaveTextContent(/trim/i)
  })
})

/**
 * #50: method and status coloured independently, from evidence in the row alone — never a
 * threshold, and never one colour standing in for the other's meaning.
 */
describe("colouring methods and statuses", () => {
  test("gives GET, POST, PUT and PATCH and DELETE each their own category, PUT and PATCH sharing one", () => {
    const run = aRun("srv-1")
    theActivityTable(
      run.start("req-1", "GET", "/posts"),
      run.finish("req-1"),
      run.start("req-2", "POST", "/posts"),
      run.finish("req-2"),
      run.start("req-3", "PUT", "/posts/1"),
      run.finish("req-3"),
      run.start("req-4", "PATCH", "/posts/1"),
      run.finish("req-4"),
      run.start("req-5", "DELETE", "/posts/1"),
      run.finish("req-5"),
    )

    const methods = activityRows().map((row) => cellUnder(row, "Method"))

    expect(methods[0]).toHaveAttribute("data-method", "get")
    expect(methods[1]).toHaveAttribute("data-method", "post")
    expect(methods[2]).toHaveAttribute("data-method", "put-patch")
    expect(methods[3]).toHaveAttribute("data-method", "put-patch")
    expect(methods[4]).toHaveAttribute("data-method", "delete")
    expect(methods).toHaveLength(5)
  })

  test("renders HEAD, OPTIONS and a verb it does not recognise as plain neutral text, never GET's colour", () => {
    const run = aRun("srv-1")
    theActivityTable(
      run.start("req-1", "HEAD", "/posts"),
      run.finish("req-1"),
      run.start("req-2", "OPTIONS", "/posts"),
      run.finish("req-2"),
      run.start("req-3", "TRACE", "/posts"),
      run.finish("req-3"),
    )

    for (const row of activityRows()) {
      expect(cellUnder(row, "Method")).toHaveAttribute("data-method", "other")
    }
  })

  test("colours 4xx and 5xx statuses by class, and leaves 1xx, 2xx and 3xx exactly as they render today", () => {
    const run = aRun("srv-1")
    theActivityTable(
      run.start("req-1", "GET", "/a"),
      run.finish("req-1", { status: 200 }),
      run.start("req-2", "GET", "/b"),
      run.finish("req-2", { status: 301 }),
      run.start("req-3", "GET", "/c"),
      run.finish("req-3", { status: 404 }),
      run.start("req-4", "GET", "/d"),
      run.finish("req-4", { status: 422 }),
      run.start("req-5", "GET", "/e"),
      run.finish("req-5", { status: 500 }),
      run.start("req-6", "GET", "/f"),
      run.finish("req-6", { status: 503 }),
    )

    const status = (path: string, said: string) => within(cellUnder(rowShowing(path), "Status")).getByText(said)

    // 200 and 301 render exactly as before: `Highlight` alone, straight in the cell, with no
    // wrapping element to carry a category.
    expect(status("/a", "200")).toBe(cellUnder(rowShowing("/a"), "Status"))
    expect(status("/b", "301")).toBe(cellUnder(rowShowing("/b"), "Status"))

    expect(status("/c", "404")).toHaveAttribute("data-status", "4xx")
    expect(status("/d", "422")).toHaveAttribute("data-status", "4xx")
    expect(status("/e", "500")).toHaveAttribute("data-status", "5xx")
    expect(status("/f", "503")).toHaveAttribute("data-status", "5xx")
  })
})

/**
 * *Run rows* and the *Run marker*: one row per Run holding what it emitted unattributed, and
 * a boundary drawn only where a Run that serves requests started.
 */
describe("Run rows", () => {
  function runRows() {
    return activityRows().filter((row) => row.getAttribute("data-kind") === "run")
  }

  test("gives a Run's unattributed output a row naming the process it came from", () => {
    const run = aRun("srv-1")
    theActivityTable(run.header("rake", 91_887), run.sql(null), run.log(null, "reports:rebuild — 41,209 orders to process"))

    const [row] = runRows()
    if (row === undefined) throw new Error("the table has no Run row")
    const [, said, sql, log] = within(row).getAllByRole("cell")

    expect(said).toHaveTextContent("rake")
    expect(said).toHaveTextContent("pid 91887")
    expect([sql?.textContent, log?.textContent]).toEqual(["1", "1"])
  })

  test("draws a Run marker where a server Run started, and none where a rake Run did", () => {
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    theActivityTable(server.header("server"), rake.header("rake", 91_887), rake.sql(null))

    const [serverRow, rakeRow] = runRows()

    expect(serverRow).toHaveAttribute("data-marker")
    expect(serverRow).toHaveTextContent("Run started")
    expect(rakeRow).not.toHaveAttribute("data-marker")
    expect(rakeRow).not.toHaveTextContent("Run started")
  })
})

/**
 * Tabs filter by row kind and by nothing else — never by method, status or controller, which
 * v1 rules out. Each carries a count of what it holds, whichever tab is showing.
 */
describe("the row-kind tabs", () => {
  function theReaderWithBothKinds() {
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    return theActivityTable(
      server.header(),
      server.log(null, "=> Booting Puma"),
      server.start("req-1", "GET", "/first"),
      server.finish("req-1"),
      rake.header("rake", 91_887),
      rake.sql(null),
      server.start("req-2", "GET", "/second"),
    )
  }

  function tabs() {
    // The tabs sit in the column heading, above the table rather than inside it.
    return within(column("Activity table"))
      .getAllByRole("tab")
      .map((each) => each.textContent)
  }

  test("offers Requests, Runs and All, each carrying a count", () => {
    theReaderWithBothKinds()

    expect(tabs()).toEqual(["Requests2", "Runs2", "All4"])
  })

  test("shows every row on open, previous Runs included", () => {
    theReaderWithBothKinds()

    expect(tab("All")).toHaveAttribute("aria-selected", "true")
    expect(activityRows()).toHaveLength(4)
  })

  test("counts what the Reader holds rather than what is on screen, so switching moves no number", async () => {
    const { user } = theReaderWithBothKinds()

    await user.click(tab("Runs"))

    expect(tabs()).toEqual(["Requests2", "Runs2", "All4"])
  })

  test("filters to request rows, keeping them in the order the fold appended them", async () => {
    const { user } = theReaderWithBothKinds()

    await user.click(tab("Requests"))

    expect(activityRows().map((row) => cellUnder(row, "Path").textContent)).toEqual(["/first", "/second"])
  })

  test("filters to Run rows", async () => {
    const { user } = theReaderWithBothKinds()

    await user.click(tab("Runs"))

    const shown = activityRows()
    expect(shown).toHaveLength(2)
    for (const row of shown) expect(row).toHaveAttribute("data-kind", "run")
  })
})

/**
 * The *load-earlier* control. Reaching further back is a thing the developer asks for, so
 * what is tested here is the asking: that there is a control to click when there is
 * something to go and get, that clicking it says so once, and that it is gone rather than
 * dead when the scan has reached the top of the Sidecar.
 */
describe("load-earlier", () => {
  function theReaderReaching(earlier: { available: boolean; loading: boolean }, onLoadEarlier = () => {}) {
    return openTheReader([], { earlier, onLoadEarlier })
  }

  function control() {
    return within(column("Activity table")).queryByRole("button", { name: /earlier/ })
  }

  test("offers the control above the oldest row, where what it gets will appear", () => {
    theReaderReaching({ available: true, loading: false })

    const table = within(column("Activity table")).getByRole("grid")
    expect(control()).toHaveTextContent(/^Load earlier$/)
    expect(control()!.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test("asks once per click, and says the scan is running while it is", async () => {
    let asked = 0
    const { user, unmount } = theReaderReaching({ available: true, loading: false }, () => {
      asked += 1
    })

    await user.click(control()!)

    expect(asked).toBe(1)

    unmount()
    theReaderReaching({ available: true, loading: true })
    expect(control()).toHaveTextContent(/^Loading earlier…$/)
    expect(control()).toBeDisabled()
  })

  test("is absent, rather than dead, once the scan has reached the top of the Sidecar", () => {
    theReaderReaching({ available: false, loading: false })

    expect(control()).not.toBeInTheDocument()
  })
})
