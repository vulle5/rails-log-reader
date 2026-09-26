import { afterEach, describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"

import { aRun } from "./sidecar.fixtures"
import { column, openTheReader, rowShowing, search, tab } from "./reader.harness"

/**
 * *Table columns* hidden and shown through the trigger in the Activity table's heading and the
 * popover of checkboxes it opens.
 */

const KEY = "rails-log-reader.hidden-table-columns"

afterEach(() => {
  localStorage.clear()
})

function theReader() {
  const run = aRun("srv-1")
  return openTheReader([
    run.header(),
    run.start("req-1", "GET", "/articles/42"),
    run.sql("req-1"),
    run.finish("req-1"),
  ])
}

function trigger() {
  return within(column("Activity table")).getByRole("button", { name: "Table columns" })
}

function popover() {
  return screen.getByRole("group", { name: "Table columns" })
}

function checkbox(name: string) {
  return within(popover()).getByRole("checkbox", { name })
}

function headings() {
  return within(column("Activity table"))
    .getAllByRole("columnheader")
    .map((heading) => heading.textContent)
}

async function hide(user: UserEvent, ...names: string[]) {
  if (trigger().getAttribute("aria-expanded") !== "true") await user.click(trigger())
  for (const name of names) await user.click(checkbox(name))
}

describe("the Table columns popover", () => {
  test("opens from its trigger with a checkbox per table column, in table order, each described", async () => {
    const { user } = theReader()
    expect(trigger()).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("group", { name: "Table columns" })).toBeNull()

    await user.click(trigger())

    expect(trigger()).toHaveAttribute("aria-expanded", "true")
    const boxes = within(popover()).getAllByRole("checkbox")
    expect(boxes).toHaveLength(10)
    for (const box of boxes) expect(box).toBeChecked()
    expect(checkbox("DB")).toHaveAccessibleDescription("Time spent in the database")
    expect(
      [
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
      ].map((name) => boxes.indexOf(checkbox(name))),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test("stays open while toggling, and closes on Escape", async () => {
    const { user } = theReader()
    await hide(user, "DB", "View")

    expect(popover()).toBeInTheDocument()

    await user.keyboard("{Escape}")

    expect(screen.queryByRole("group", { name: "Table columns" })).toBeNull()
    expect(trigger()).toHaveAttribute("aria-expanded", "false")
  })

  test("hands focus back to its trigger on Escape from inside it", async () => {
    const { user } = theReader()
    await hide(user, "DB")

    await user.keyboard("{Escape}")

    expect(trigger()).toHaveFocus()
  })

  test("closes on a click outside it", async () => {
    const { user } = theReader()
    await user.click(trigger())

    await user.click(within(column("Activity table")).getByRole("heading"))

    expect(screen.queryByRole("group", { name: "Table columns" })).toBeNull()
  })

  test("closes on a second click of its trigger", async () => {
    const { user } = theReader()
    await user.click(trigger())
    await user.click(trigger())

    expect(screen.queryByRole("group", { name: "Table columns" })).toBeNull()
  })

  test("is not a menu", async () => {
    const { user } = theReader()
    await user.click(trigger())

    expect(screen.queryByRole("menu")).toBeNull()
  })
})

describe("hiding a table column", () => {
  test.each(["Method", "Path", "Controller#action", "SQL", "Log", "DB", "View"])(
    "removes %s's header and its cells from every row",
    async (name) => {
      const { user } = theReader()
      const request = rowShowing("/articles/42")
      const run = rowShowing("server")
      const cells = (row: HTMLElement) => within(row).getAllByRole("cell").length
      const [requestCells, runCells] = [cells(request), cells(run)]

      await hide(user, name)

      expect(checkbox(name)).not.toBeChecked()
      expect(headings()).not.toContain(name)
      expect(headings()).toHaveLength(9)
      expect(cells(request)).toBe(requestCells - 1)
      // A Run row's description spans a hidden Method, Path or Controller#action: it loses a
      // span, not a cell.
      const described = ["Method", "Path", "Controller#action"].includes(name)
      expect(cells(run)).toBe(described ? runCells : runCells - 1)
    },
  )

  test("applies on every tab", async () => {
    const { user } = theReader()
    await hide(user, "SQL")
    await user.keyboard("{Escape}")

    for (const name of ["Requests", "Runs", "All"]) {
      await user.click(tab(name))
      expect(headings()).not.toContain("SQL")
    }
  })

  test("shows it again when checked again", async () => {
    const { user } = theReader()
    await hide(user, "DB")
    await user.click(checkbox("DB"))

    expect(headings()).toContain("DB")
  })

  test("spans a Run row's description over Status and the shown ones of Method, Path, Controller#action", async () => {
    const { user } = theReader()
    const description = () => within(rowShowing("server")).getAllByRole("cell")[1]!

    expect(description()).toHaveAttribute("colspan", "4")

    await hide(user, "Path")
    expect(description()).toHaveAttribute("colspan", "3")

    await hide(user, "Method", "Controller#action")
    expect(description()).toHaveAttribute("colspan", "1")
  })
})

describe("the fixed three", () => {
  test.each(["Started", "Status", "Total"])("keeps %s checked and aria-disabled", async (name) => {
    const { user } = theReader()
    await user.click(trigger())

    expect(checkbox(name)).toBeChecked()
    expect(checkbox(name)).toHaveAttribute("aria-disabled", "true")
    expect(checkbox(name)).not.toBeDisabled()
    expect(checkbox(name)).not.toHaveAttribute("title")
  })

  test("says Always shown when one is clicked, until the next click in the popover", async () => {
    const { user } = theReader()
    await user.click(trigger())

    await user.click(checkbox("Status"))

    expect(checkbox("Status")).toBeChecked()
    expect(headings()).toContain("Status")
    expect(within(popover()).getByText("Always shown")).toBeInTheDocument()

    await user.click(checkbox("DB"))

    expect(within(popover()).queryByText("Always shown")).toBeNull()
  })

  test("says Always shown on Space, until the next keypress in the popover", async () => {
    const { user } = theReader()
    await user.click(trigger())
    await user.click(checkbox("View"))
    await user.tab()
    expect(checkbox("Total")).toHaveFocus()

    await user.keyboard(" ")

    expect(checkbox("Total")).toBeChecked()
    expect(within(popover()).getByText("Always shown")).toBeInTheDocument()

    await user.keyboard("{Shift}")

    expect(within(popover()).queryByText("Always shown")).toBeNull()
  })
})

describe("the trigger's badge", () => {
  test("is absent while nothing is hidden", () => {
    theReader()

    expect(within(trigger()).queryByText(/hidden/)).toBeNull()
  })

  test("counts what is hidden", async () => {
    const { user } = theReader()
    await hide(user, "DB", "View")

    expect(within(trigger()).getByText("2 hidden")).toBeInTheDocument()
    expect(trigger()).toHaveAccessibleName("Table columns")
    expect(trigger()).toHaveAccessibleDescription("2 hidden")
  })
})

describe("the hidden set", () => {
  test("survives a reload, stored as what is hidden", async () => {
    const { user, unmount } = theReader()
    await hide(user, "SQL", "View")

    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["sql", "view"])

    unmount()
    theReader()

    expect(headings()).toEqual(["Started", "Status", "Method", "Path", "Controller#action", "Log", "DB", "Total"])
  })

  test("is forgotten once everything is shown again", async () => {
    const { user } = theReader()
    await hide(user, "SQL")
    await user.click(checkbox("SQL"))

    expect(localStorage.getItem(KEY)).toBeNull()
  })

  test("never hides one of the fixed three, whatever is stored", () => {
    localStorage.setItem(KEY, JSON.stringify(["started", "status", "total", "db"]))

    theReader()

    expect(headings()).toEqual(["Started", "Status", "Method", "Path", "Controller#action", "SQL", "Log", "View", "Total"])
  })

  test("falls back to all shown when storage is blocked", () => {
    const getItem = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new DOMException("blocked", "SecurityError")
    }

    try {
      theReader()
    } finally {
      Storage.prototype.getItem = getItem
    }

    expect(headings()).toHaveLength(10)
  })
})

describe("Search over a hidden table column", () => {
  test("does not show it again, and still lights the match in the Detail column", async () => {
    const { user } = theReader()
    await hide(user, "Path")
    await user.keyboard("{Escape}")
    await user.click(rowShowing("GET"))

    await search(user, "articles")

    expect(headings()).not.toContain("Path")
    expect(within(column("Detail column")).getAllByRole("mark").length).toBeGreaterThan(0)
  })
})

describe("the Activity table's minimum width", () => {
  test("is unchanged by hiding", async () => {
    const { user } = theReader()
    const room = () => screen.getByRole("separator", { name: "Detail column" }).getAttribute("aria-valuemax")
    const before = room()

    await hide(user, "Method", "Path", "Controller#action", "SQL", "Log", "DB", "View")

    expect(room()).toBe(before)
  })
})
