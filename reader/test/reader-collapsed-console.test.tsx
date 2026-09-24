import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"

import { aRun } from "./sidecar.fixtures"
import {
  chip,
  collapseConsole,
  column,
  consoleLines,
  expandConsole,
  lit,
  openTheReader,
  search,
  select,
} from "./reader.harness"

/**
 * The *Collapsed Console*, through the rendered Reader: folded by its "Collapse Console"
 * button, reopened by the strip that is its one "Expand Console" button.
 *
 * happy-dom does no layout, so the Reader's available width is supplied, as the Column
 * dividers' own tests supply it: every element is `AVAILABLE` pixels wide.
 */

const AVAILABLE = 1600

const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => AVAILABLE })
})

afterAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth!)
})

afterEach(() => {
  localStorage.clear()
})

const run = aRun("srv-125")

const TRAFFIC = [
  run.header(),
  run.log(null, "boot: environment loaded"),
  run.start("req-1", "GET", "/posts"),
  run.log("req-1", "Feed cache MISS"),
  run.log("req-1", "Feed rebuilt", { severity: "warn" }),
  run.finish("req-1"),
]

function divider(name: "Console" | "Detail column") {
  return screen.getByRole("separator", { name })
}

function collapsed() {
  return within(column("Console")).queryByRole("button", { name: "Expand Console" }) !== null
}

async function drag(user: UserEvent, name: "Console" | "Detail column", by: number) {
  const target = divider(name)
  await user.pointer([
    { keys: "[MouseLeft>]", target, coords: { clientX: 1000 } },
    { target, coords: { clientX: 1000 + by } },
    { keys: "[/MouseLeft]", target, coords: { clientX: 1000 + by } },
  ])
}

describe("Collapse Console", () => {
  test("is a button in the Console's header", () => {
    openTheReader(TRAFFIC)

    const header = within(column("Console")).getByRole("heading", { name: "Console" }).parentElement!
    expect(within(header).getByRole("button", { name: "Collapse Console" })).toBeInTheDocument()
  })

  test("folds the Console into the strip, rendering none of its lines", async () => {
    const { user } = openTheReader(TRAFFIC)

    await collapseConsole(user)

    expect(collapsed()).toBe(true)
    expect(within(column("Console")).queryByRole("list")).not.toBeInTheDocument()
    expect(screen.queryByText("Feed cache MISS")).not.toBeInTheDocument()
  })

  test("gives the Console's width to the Activity table, which the Detail column can now grow into", async () => {
    const { user } = openTheReader(TRAFFIC)
    const before = Number(divider("Detail column").getAttribute("aria-valuemax"))

    await collapseConsole(user)

    expect(Number(divider("Detail column").getAttribute("aria-valuemax"))).toBeGreaterThan(before)
  })
})

describe("the Collapsed Console's strip", () => {
  test("is a single button named Expand Console", async () => {
    const { user } = openTheReader(TRAFFIC)

    await collapseConsole(user)

    const buttons = within(column("Console")).getAllByRole("button")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName("Expand Console")
  })

  test("reopens the Console at its saved width", async () => {
    const { user } = openTheReader(TRAFFIC)
    await drag(user, "Console", 60)

    await collapseConsole(user)
    await expandConsole(user)

    expect(collapsed()).toBe(false)
    expect(divider("Console")).toHaveAttribute("aria-valuenow", "420")
    expect(consoleLines().map((line) => line.textContent)).toEqual([
      expect.stringContaining("boot: environment loaded"),
      expect.stringContaining("Feed cache MISS"),
      expect.stringContaining("Feed rebuilt"),
    ])
  })
})

describe("a Collapsed Console across a reload", () => {
  test("stays folded", async () => {
    const { user, unmount } = openTheReader(TRAFFIC)
    await collapseConsole(user)
    unmount()

    openTheReader(TRAFFIC)

    expect(collapsed()).toBe(true)
  })

  test("stays open once it has been reopened", async () => {
    const { user, unmount } = openTheReader(TRAFFIC)
    await collapseConsole(user)
    await expandConsole(user)
    unmount()

    openTheReader(TRAFFIC)

    expect(collapsed()).toBe(false)
  })
})

describe("unfolding", () => {
  test("shows the chips exactly as they were", async () => {
    const { user } = openTheReader(TRAFFIC)
    await user.click(chip("warn", "Filter by level"))
    await user.click(chip("rails", "Filter by source"))

    await collapseConsole(user)
    await expandConsole(user)

    expect(chip("warn", "Filter by level")).toHaveAttribute("aria-pressed", "false")
    expect(chip("rails", "Filter by source")).toHaveAttribute("aria-pressed", "true")
    expect(consoleLines().some((line) => line.textContent?.includes("Feed rebuilt"))).toBe(false)
  })
})

describe("Search and a Collapsed Console", () => {
  test("typing a Search leaves it folded", async () => {
    const { user } = openTheReader(TRAFFIC)
    await collapseConsole(user)

    await search(user, "Feed")

    expect(collapsed()).toBe(true)
  })

  test("the Detail column still lights what the folded Console holds", async () => {
    const { user } = openTheReader(TRAFFIC)
    await select(user, "/posts")
    await collapseConsole(user)

    await search(user, "cache")

    expect(lit(column("Detail column"))).toContain("cache")
  })
})

describe("only the Console folds", () => {
  test("neither the Activity table nor the Detail column has a collapse button", () => {
    openTheReader(TRAFFIC)

    for (const name of ["Activity table", "Detail column"] as const) {
      expect(within(column(name)).queryByRole("button", { name: /^Collapse/ })).not.toBeInTheDocument()
    }
  })
})
