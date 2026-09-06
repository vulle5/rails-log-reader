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

afterEach(() => {
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
  await act(async () => createRoot(container).render(<Reader rows={activity.rows} />))

  const table = container.querySelector("table.activity")
  if (table === null) throw new Error("the Activity table did not render a table")
  return table
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

  test("leaves a request that has not finished blank rather than guessing at it", async () => {
    const run = aRun("srv-1")
    const table = await theActivityTable(run.start("req-1", "GET", "/hangs"), run.route("req-1"))

    expect(cells(table)[1]).toBe("")
    expect(cells(table)[9]).toBe("")
  })
})
