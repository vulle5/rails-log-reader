import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { act, screen, within } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"

import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"
import type { Envelope } from "../src/shared/wire"
import { Reader } from "../src/ui/Reader"
import { aRun } from "./sidecar.fixtures"
import {
  aFold,
  chip,
  collapseConsole,
  column,
  consoleCollapsed,
  consoleLines,
  expandConsole,
  lit,
  openTheReader,
  openTheReaderOver,
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

    expect(consoleCollapsed()).toBe(true)
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

    expect(consoleCollapsed()).toBe(false)
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

    expect(consoleCollapsed()).toBe(true)
  })

  test("stays open once it has been reopened", async () => {
    const { user, unmount } = openTheReader(TRAFFIC)
    await collapseConsole(user)
    await expandConsole(user)
    unmount()

    openTheReader(TRAFFIC)

    expect(consoleCollapsed()).toBe(false)
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

    expect(consoleCollapsed()).toBe(true)
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

describe("the Unseen count", () => {
  const later = aRun("srv-126")

  /** The Reader over `TRAFFIC`, and new envelopes arriving the way `main.tsx` renders them. */
  function openLive() {
    const fold = aFold()
    fold.fold(TRAFFIC)
    const view = openTheReaderOver(fold)

    function arrive(arriving: readonly Envelope[]) {
      fold.fold(arriving)
      view.rerender(<Reader {...fold.props} />)
    }

    return { ...view, arrive }
  }

  function strip() {
    return within(column("Console")).getByRole("button", { name: /^Expand Console/ })
  }

  test("is not shown when nothing has arrived since the Console folded", async () => {
    const { user } = openLive()

    await collapseConsole(user)

    expect(strip()).toHaveAccessibleName("Expand Console")
  })

  test("counts lines arriving while the Console is folded", async () => {
    const { user, arrive } = openLive()
    await collapseConsole(user)

    arrive([later.log(null, "one"), later.log(null, "two")])

    expect(strip()).toHaveAccessibleName("Expand Console, 2 unseen lines")
    expect(within(strip()).getByText("2")).toBeInTheDocument()
  })

  test("names a single line in the singular", async () => {
    const { user, arrive } = openLive()
    await collapseConsole(user)

    arrive([later.log(null, "one")])

    expect(strip()).toHaveAccessibleName("Expand Console, 1 unseen line")
  })

  test("does not count lines its chips would hide", async () => {
    const { user, arrive } = openLive()
    await user.click(chip("warn", "Filter by level"))
    await collapseConsole(user)

    arrive([
      later.log(null, "a warning", { severity: "warn" }),
      later.log(null, "Rails' own", { source: "rails" }),
      later.log(null, "shown"),
    ])

    expect(strip()).toHaveAccessibleName("Expand Console, 1 unseen line")
  })

  test("takes off lines the Memory bound evicts while the Console is folded", async () => {
    const { user, arrive } = openLive()
    await collapseConsole(user)
    arrive([later.start("req-doomed", "GET", "/doomed"), later.log("req-doomed", "doomed"), later.finish("req-doomed")])
    expect(strip()).toHaveAccessibleName("Expand Console, 1 unseen line")

    // Enough finished requests after it to push its row out of the ring.
    arrive(
      Array.from({ length: LOAD_ON_OPEN_EVENTS }, (_, index) => [
        later.start(`req-${index}`, "GET", `/filler/${index}`),
        later.finish(`req-${index}`),
      ]).flat(),
    )

    expect(strip()).toHaveAccessibleName("Expand Console")
  })

  test("is cleared by unfolding", async () => {
    const { user, arrive } = openLive()
    await collapseConsole(user)
    arrive([later.log(null, "one")])

    await expandConsole(user)
    await collapseConsole(user)

    expect(strip()).toHaveAccessibleName("Expand Console")
  })

  test("reads 99+ above 99", async () => {
    const { user, arrive } = openLive()
    await collapseConsole(user)

    arrive(Array.from({ length: 100 }, (_, index) => later.log(null, `line ${index}`)))

    expect(strip()).toHaveAccessibleName("Expand Console, 100 unseen lines")
    expect(within(strip()).getByText("99+")).toBeInTheDocument()
  })

  test("starts at zero on a reload onto a folded Console, once the history has arrived", async () => {
    const { user, unmount } = openTheReader(TRAFFIC)
    await collapseConsole(user)
    unmount()

    const fold = aFold()
    const view = openTheReaderOver(fold, { historyLoaded: false })
    fold.fold(TRAFFIC)
    view.rerender(<Reader {...fold.props} historyLoaded={false} />)
    expect(strip()).toHaveAccessibleName("Expand Console")

    view.rerender(<Reader {...fold.props} historyLoaded={true} />)
    expect(strip()).toHaveAccessibleName("Expand Console")

    fold.fold([later.log(null, "news")])
    view.rerender(<Reader {...fold.props} historyLoaded={true} />)
    expect(strip()).toHaveAccessibleName("Expand Console, 1 unseen line")
  })
})

describe("dragging the Console's divider past its minimum", () => {
  test("folds the Console once the drag is under half its minimum", async () => {
    const { user } = openTheReader(TRAFFIC)

    await drag(user, "Console", -250)

    expect(consoleCollapsed()).toBe(true)
  })

  test("leaves the Console at its minimum when the drag ends short of that", async () => {
    const { user } = openTheReader(TRAFFIC)

    await drag(user, "Console", -230)

    expect(consoleCollapsed()).toBe(false)
    expect(divider("Console")).toHaveAttribute("aria-valuenow", "240")
  })

  test("reopens it when the same drag comes back out past half its minimum", async () => {
    const { user } = openTheReader(TRAFFIC)
    const target = divider("Console")

    await user.pointer([
      { keys: "[MouseLeft>]", target, coords: { clientX: 1000 } },
      { target, coords: { clientX: 700 } },
      { target, coords: { clientX: 800 } },
      { keys: "[/MouseLeft]", target, coords: { clientX: 800 } },
    ])

    expect(consoleCollapsed()).toBe(false)
    expect(divider("Console")).toHaveAttribute("aria-valuenow", "360")
  })

  test("is remembered across a reload, like a fold by the button", async () => {
    const { user, unmount } = openTheReader(TRAFFIC)
    await drag(user, "Console", -250)
    unmount()

    openTheReader(TRAFFIC)

    expect(consoleCollapsed()).toBe(true)
  })
})

describe("the keyboard on the Console's divider", () => {
  test("folds the Console by arrowing it below its minimum", async () => {
    const { user } = openTheReader(TRAFFIC)
    await drag(user, "Console", -120)

    act(() => divider("Console").focus())
    await user.keyboard("{ArrowLeft}")

    expect(consoleCollapsed()).toBe(true)
  })

  test("stops at the minimum before folding, from a width off the arrow's step", async () => {
    const { user } = openTheReader(TRAFFIC)
    await drag(user, "Console", -110)

    act(() => divider("Console").focus())
    await user.keyboard("{ArrowLeft}")

    expect(consoleCollapsed()).toBe(false)
    expect(divider("Console")).toHaveAttribute("aria-valuenow", "240")

    await user.keyboard("{ArrowLeft}")

    expect(consoleCollapsed()).toBe(true)
  })

  test("unfolds a Collapsed Console by arrowing it outward", async () => {
    const { user } = openTheReader(TRAFFIC)
    await collapseConsole(user)

    act(() => divider("Console").focus())
    await user.keyboard("{ArrowRight}")

    expect(consoleCollapsed()).toBe(false)
    expect(divider("Console")).toHaveAttribute("aria-valuenow", "360")
  })
})

describe("dragging the Collapsed Console's divider outward", () => {
  test("reports the strip's width while folded", async () => {
    const { user } = openTheReader(TRAFFIC)

    await collapseConsole(user)

    expect(divider("Console")).toHaveAttribute("aria-valuenow", "32")
  })

  test("unfolds the Console once past half its minimum", async () => {
    const { user } = openTheReader(TRAFFIC)
    await collapseConsole(user)

    await drag(user, "Console", 200)

    expect(consoleCollapsed()).toBe(false)
  })

  test("leaves it folded short of that", async () => {
    const { user } = openTheReader(TRAFFIC)
    await collapseConsole(user)

    await drag(user, "Console", 50)

    expect(consoleCollapsed()).toBe(true)
  })
})

describe("unfolding after a fold", () => {
  test("restores the last width at or above the minimum, by the strip", async () => {
    const { user } = openTheReader(TRAFFIC)
    await drag(user, "Console", 60)
    await drag(user, "Console", -400)

    await expandConsole(user)

    expect(divider("Console")).toHaveAttribute("aria-valuenow", "420")
  })

  test("restores it by dragging outward", async () => {
    const { user } = openTheReader(TRAFFIC)
    await drag(user, "Console", 60)
    await drag(user, "Console", -400)

    await drag(user, "Console", 200)

    expect(divider("Console")).toHaveAttribute("aria-valuenow", "420")
  })

  test("restores the minimum a drag passed through on its way to folding", async () => {
    const { user } = openTheReader(TRAFFIC)
    await drag(user, "Console", -200)
    await drag(user, "Console", -200)

    await expandConsole(user)

    expect(divider("Console")).toHaveAttribute("aria-valuenow", "240")
  })

  test("restores it after a reload onto a drag-folded Console", async () => {
    const { user, unmount } = openTheReader(TRAFFIC)
    await drag(user, "Console", 60)
    await drag(user, "Console", -400)
    unmount()

    const reopened = openTheReader(TRAFFIC)
    await expandConsole(reopened.user)

    expect(divider("Console")).toHaveAttribute("aria-valuenow", "420")
  })
})
