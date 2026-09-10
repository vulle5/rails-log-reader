import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { aRun } from "./sidecar.fixtures"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")
const { activityTable } = await import("../src/shared/activity")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * Unmounted rather than just emptied: an in-flight row's elapsed pill holds an interval for
 * as long as it is mounted, and a root left behind goes on ticking into the next test.
 */
const mounted: { unmount: () => void }[] = []

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount()
  })
  document.body.innerHTML = ""
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/**
 * Seam 2: the Activity table over a seeded model — seeded by folding envelopes, so the
 * shape the component is mounted over is the shape Seam 1 produces and not a second one.
 */
async function theActivityTable(...envelopes: Parameters<ReturnType<typeof activityTable>["fold"]>[0]) {
  const activity = activityTable()
  activity.fold(envelopes)

  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => {
    const root = createRoot(container)
    mounted.push(root)
    root.render(<Reader rows={activity.rows} />)
  })

  const table = container.querySelector("table.activity")
  if (table === null) throw new Error("the Activity table did not render a table")
  return table
}

/**
 * How long the elapsed pill reads, in seconds. Parsed rather than compared as a string,
 * because the pill measures from the machine's own clock: the last tenth of it is however
 * long this test took to render, and a test that pinned the spelling would be asserting that
 * as well.
 */
function elapsedSeconds(table: Element) {
  const pill = table.querySelector(".elapsed")?.textContent
  if (pill === undefined) throw new Error("no row is showing an elapsed")

  const read = /^(?:(\d+)h )?(?:(\d+)m )?(?:(\d+(?:\.\d)?)s)?$/.exec(pill)
  if (read === null) throw new Error(`the pill reads ${pill}, which is no elapsed this Reader writes`)

  const [hours, minutes, seconds] = [...read].slice(1).map((part) => Number(part ?? 0))
  return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0)
}

function headings(table: Element) {
  return [...table.querySelectorAll("thead th")].map((heading) => heading.textContent)
}

function cells(table: Element, index = 0) {
  const row = table.querySelectorAll("tbody tr")[index]
  if (row === undefined) throw new Error(`no row ${index} — the table has ${table.querySelectorAll("tbody tr").length}`)
  return [...row.querySelectorAll("td")].map((cell) => cell.textContent)
}

describe("the Activity table", () => {
  test("heads its columns with what a request cost", async () => {
    const run = aRun("srv-1")
    const table = await theActivityTable(run.start("req-1"), run.finish("req-1"))

    expect(headings(table)).toEqual([
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

  test("shows one row per request, folded from its three events and its children", async () => {
    const run = aRun("srv-1")
    const table = await theActivityTable(
      run.start("req-1", "GET", "/posts/12"),
      run.route("req-1", "PostsController", "show"),
      run.sql("req-1"),
      run.sql("req-1"),
      run.log("req-1"),
      run.finish("req-1", { status: 200, duration_ms: 78.3, view_runtime_ms: 61.2, db_runtime_ms: 1.4 }),
    )

    expect(table.querySelectorAll("tbody tr")).toHaveLength(1)
    expect(cells(table)).toEqual([
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

  test("gives a request that failed to route a row too, showing its method and path", async () => {
    const run = aRun("srv-1")
    const table = await theActivityTable(
      run.start("req-404", "GET", "/pots/12"),
      run.finish("req-404", { status: 404, duration_ms: 3.1 }),
    )

    expect(cells(table).slice(1)).toEqual(["404", "GET", "/pots/12", "—", "", "", "", "", "3.1ms"])
  })

  test("keeps rows in the order the fold appended them", async () => {
    const run = aRun("srv-1")
    const table = await theActivityTable(
      run.start("req-1", "GET", "/first"),
      run.start("req-2", "GET", "/second"),
      run.finish("req-1"),
    )

    expect([...table.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[3]?.textContent)).toEqual([
      "/first",
      "/second",
    ])
  })

  test("leaves a request that has not finished unanswered rather than guessing at it", async () => {
    const run = aRun("srv-1", Date.now())
    const table = await theActivityTable(run.start("req-1", "GET", "/hangs"), run.route("req-1"))

    // No status, because nothing has been decided yet — but the total is not blank: how long
    // this has been running is measured, not guessed, and is the whole signal a hang gives.
    expect(cells(table)[1]).toBe("")
    expect(elapsedSeconds(table)).toBeGreaterThanOrEqual(0.1)
    expect(elapsedSeconds(table)).toBeLessThan(2)
  })
})

/**
 * The states the fold concluded, on screen. Nothing here is a threshold or a colour of
 * alarm: an in-flight request looks like a request that is still running, however long it
 * has been doing it, and the human draws the conclusion.
 */
describe("what a row says it is", () => {
  test("shows an in-flight request as a live dot and a climbing elapsed, with no status", async () => {
    // A Run writing right now, because what the pill reads is a distance from the clock this
    // test is running on and not a number the file carries.
    const run = aRun("srv-1", Date.now())
    const table = await theActivityTable(
      run.start("req-1", "GET", "/admin/reports/monthly.csv"),
      run.route("req-1", "Admin::ReportsController", "monthly"),
      // Two ticks of the fixture's 100ms clock after the start.
      run.log("req-1", "Building monthly report (this may take a while)"),
    )

    expect(cells(table)[1]).toBe("")
    expect(table.querySelector(".state-dot")?.getAttribute("aria-label")).toBe("In flight")
    // It hangs in Admin::ReportsController#monthly, rather than merely hanging.
    expect(cells(table)[4]).toBe("Admin::Reports#monthly")
    expect(elapsedSeconds(table)).toBeGreaterThanOrEqual(0.2)
    expect(elapsedSeconds(table)).toBeLessThan(2)
  })

  test("reads a request that was already hanging when the Reader opened at its true age", async () => {
    // The case the pill exists for, and the one a mount-time anchor gets wrong: this hang
    // began four minutes before the Reader was started, so all of it is history by the time
    // the fold sees it and none of the wait is time this tab was open for.
    const run = aRun("srv-1", Date.now() - 240_000)
    const table = await theActivityTable(
      run.start("req-1", "GET", "/admin/reports/monthly.csv"),
      run.route("req-1", "Admin::ReportsController", "monthly"),
      run.sql("req-1"),
    )

    // Not the 0.2s of it the file happens to cover: the silence since is the hang.
    expect(elapsedSeconds(table)).toBeGreaterThan(238)
    expect(elapsedSeconds(table)).toBeLessThan(245)
  })

  test("styles an Interrupted row distinctly, and never as an error", async () => {
    const reaped = aRun("srv-1")
    const restarted = aRun("srv-2")
    const table = await theActivityTable(
      reaped.header(),
      reaped.start("req-1", "GET", "/killed"),
      restarted.header("server", 48_212),
    )

    const row = [...table.querySelectorAll("tbody tr")].find(
      (candidate) => candidate.querySelector(".cell-path")?.textContent === "/killed",
    )

    expect(row?.className).toContain("activity-row-interrupted")
    expect(row?.className).not.toContain("error")
    expect(row?.querySelector(".state-dot")?.getAttribute("aria-label")).toBe("Interrupted")
  })

  test("marks a Partial request, and keeps it marked once its finish promotes it", async () => {
    const run = aRun("srv-1")
    const table = await theActivityTable(
      run.sql("req-1"), // a child of a request whose start the Reader never saw
      run.route("req-1", "PostsController", "show"),
      run.finish("req-1", { status: 200, duration_ms: 12.5 }),
    )

    expect(table.querySelector(".partial-mark")?.textContent).toBe("partial")
    expect(cells(table)[1]).toBe("200")
    expect(cells(table)[9]).toBe("13ms")
  })
})

/**
 * *Run rows* and the *Run marker*: one row per Run holding what it emitted unattributed, and
 * a boundary drawn only where a Run that serves requests started.
 */
describe("Run rows", () => {
  test("gives a Run's unattributed output a row naming the process it came from", async () => {
    const run = aRun("srv-1")
    const table = await theActivityTable(
      run.header("rake", 91_887),
      run.sql(null),
      run.log(null, "reports:rebuild — 41,209 orders to process"),
    )

    const row = table.querySelector("tbody tr.activity-row-run")

    expect(row?.querySelector(".cell-run")?.textContent).toContain("rake")
    expect(row?.querySelector(".cell-run")?.textContent).toContain("pid 91887")
    expect([...(row?.querySelectorAll(".cell-count") ?? [])].map((cell) => cell.textContent)).toEqual(["1", "1"])
  })

  test("draws a Run marker where a server Run started, and none where a rake Run did", async () => {
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    const table = await theActivityTable(server.header("server"), rake.header("rake", 91_887), rake.sql(null))

    const [serverRow, rakeRow] = [...table.querySelectorAll("tbody tr.activity-row-run")]

    expect(serverRow?.className).toContain("activity-row-marker")
    expect(serverRow?.textContent).toContain("Run started")
    expect(rakeRow?.className).not.toContain("activity-row-marker")
    expect(rakeRow?.textContent).not.toContain("Run started")
  })
})

/**
 * Tabs filter by row kind and by nothing else — never by method, status or controller, which
 * v1 rules out. Each carries a count of what it holds, whichever tab is showing.
 */
describe("the row-kind tabs", () => {
  async function theReaderWithBothKinds() {
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    const table = await theActivityTable(
      server.header(),
      server.log(null, "=> Booting Puma"),
      server.start("req-1", "GET", "/first"),
      server.finish("req-1"),
      rake.header("rake", 91_887),
      rake.sql(null),
      server.start("req-2", "GET", "/second"),
    )

    // The tabs sit in the column heading, above the table rather than inside it.
    const reader = table.closest(".reader-shell")
    if (reader === null) throw new Error("the Activity table is not inside the Reader")
    return reader as HTMLElement
  }

  function tab(container: HTMLElement, name: string) {
    const found = [...container.querySelectorAll("[role='tab']")].find((candidate) =>
      candidate.textContent?.startsWith(name),
    )
    if (found === undefined) throw new Error(`no ${name} tab`)
    return found
  }

  function paths(container: HTMLElement) {
    return [...container.querySelectorAll("tbody tr")].map(
      (row) => row.querySelector(".cell-path")?.textContent ?? row.querySelector(".cell-run")?.textContent ?? "",
    )
  }

  test("offers Requests, Runs and All, each carrying a count", async () => {
    const container = await theReaderWithBothKinds()

    expect([...container.querySelectorAll("[role='tab']")].map((each) => each.textContent)).toEqual([
      "Requests2",
      "Runs2",
      "All4",
    ])
  })

  test("shows every row on open, previous Runs included", async () => {
    const container = await theReaderWithBothKinds()

    expect(tab(container, "All").getAttribute("aria-selected")).toBe("true")
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4)
  })

  test("counts what the Reader holds rather than what is on screen, so switching moves no number", async () => {
    const container = await theReaderWithBothKinds()

    await act(async () => {
      tab(container, "Runs").dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect([...container.querySelectorAll("[role='tab']")].map((each) => each.textContent)).toEqual([
      "Requests2",
      "Runs2",
      "All4",
    ])
  })

  test("filters to request rows, keeping them in the order the fold appended them", async () => {
    const container = await theReaderWithBothKinds()

    await act(async () => {
      tab(container, "Requests").dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(paths(container)).toEqual(["/first", "/second"])
  })

  test("filters to Run rows", async () => {
    const container = await theReaderWithBothKinds()

    await act(async () => {
      tab(container, "Runs").dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    const shown = [...container.querySelectorAll("tbody tr")]

    expect(shown).toHaveLength(2)
    expect(shown.every((row) => row.className.includes("activity-row-run"))).toBe(true)
  })
})

/**
 * The *load-earlier* control. Reaching further back is a thing the developer asks for, so
 * what is tested here is the asking: that there is a control to click when there is
 * something to go and get, that clicking it says so once, and that it is gone rather than
 * dead when the scan has reached the top of the Sidecar.
 */
describe("load-earlier", () => {
  async function theReaderReaching(earlier: { available: boolean; loading: boolean }, onLoadEarlier = () => {}) {
    const container = document.createElement("div")
    document.body.append(container)
    await act(async () => {
      const root = createRoot(container)
      mounted.push(root)
      root.render(<Reader earlier={earlier} onLoadEarlier={onLoadEarlier} />)
    })
    return container
  }

  function control(container: HTMLElement) {
    return container.querySelector(".load-earlier-button")
  }

  test("offers the control above the oldest row, where what it gets will appear", async () => {
    const container = await theReaderReaching({ available: true, loading: false })

    const activity = container.querySelector("[aria-label='Activity table'] .column-body")
    expect(control(container)?.textContent).toBe("Load earlier")
    expect(activity?.firstElementChild?.className).toBe("load-earlier")
  })

  test("asks once per click, and says the scan is running while it is", async () => {
    let asked = 0
    const container = await theReaderReaching({ available: true, loading: false }, () => {
      asked += 1
    })

    await act(async () => {
      control(container)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(asked).toBe(1)

    const running = await theReaderReaching({ available: true, loading: true })
    expect(control(running)?.textContent).toBe("Loading earlier…")
    expect((control(running) as HTMLButtonElement).disabled).toBe(true)
  })

  test("is absent, rather than dead, once the scan has reached the top of the Sidecar", async () => {
    const container = await theReaderReaching({ available: false, loading: false })

    expect(control(container)).toBeNull()
  })
})
