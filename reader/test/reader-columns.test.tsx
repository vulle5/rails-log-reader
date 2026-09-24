import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { act, screen } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"

import { aRun } from "./sidecar.fixtures"
import { collapseConsole, column, consoleCollapsed, expandConsole, lineSaying, openTheReader } from "./reader.harness"

/**
 * The two *Column dividers*, through the rendered Reader: each found as the separator named
 * for the column it sizes, and read through the drawn width it reports.
 *
 * happy-dom does no layout, so the one input the dividers read — the Reader's available width —
 * is supplied: every element is `available` pixels wide, and a window resize is that number
 * changing and a `resize` dispatched. Faking the input, not the answer.
 */

let available = 1600

const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => available })
})

afterAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth!)
})

beforeEach(() => {
  available = 1600
})

afterEach(() => {
  localStorage.clear()
})

function divider(name: "Console" | "Detail column") {
  return screen.getByRole("separator", { name })
}

function drawn(name: "Console" | "Detail column") {
  return Number(divider(name).getAttribute("aria-valuenow"))
}

/** Drags `name`'s divider `by` pixels — rightwards when positive. */
async function drag(user: UserEvent, name: "Console" | "Detail column", by: number) {
  const target = divider(name)
  const from = 1000
  await user.pointer([
    { keys: "[MouseLeft>]", target, coords: { clientX: from } },
    { target, coords: { clientX: from + by } },
    { keys: "[/MouseLeft]", target, coords: { clientX: from + by } },
  ])
}

async function press(user: UserEvent, name: "Console" | "Detail column", keys: string) {
  act(() => divider(name).focus())
  await user.keyboard(keys)
}

function resizeTo(width: number) {
  available = width
  act(() => {
    window.dispatchEvent(new Event("resize"))
  })
}

describe("the Column dividers", () => {
  test("are focusable vertical separators, one per column they size", () => {
    openTheReader()

    for (const name of ["Console", "Detail column"] as const) {
      expect(divider(name)).toHaveAttribute("aria-orientation", "vertical")
      act(() => divider(name).focus())
      expect(divider(name)).toHaveFocus()
    }
  })

  test("open on today's layout: the Console at 360px and the Detail column at 40%", () => {
    openTheReader()

    expect(divider("Console")).toHaveAttribute("aria-valuenow", "360")
    expect(divider("Console")).toHaveAttribute("aria-valuemin", "240")
    expect(divider("Console")).toHaveAttribute("aria-valuemax", "600")
    expect(divider("Detail column")).toHaveAttribute("aria-valuenow", "640")
    expect(divider("Detail column")).toHaveAttribute("aria-valuemin", "380")
    expect(divider("Detail column")).toHaveAttribute("aria-valuemax", "880")
  })

  test("keep the default Detail column at 40% of whatever width the window has", () => {
    openTheReader()

    resizeTo(2000)

    expect(drawn("Detail column")).toBe(800)
    expect(drawn("Console")).toBe(360)
  })
})

describe("dragging a Column divider", () => {
  test("sizes the Console, and the Activity table takes what is left", async () => {
    const { user } = openTheReader()

    await drag(user, "Console", 60)

    expect(drawn("Console")).toBe(420)
    expect(drawn("Detail column")).toBe(640)
    expect(divider("Detail column")).toHaveAttribute("aria-valuemax", "820")
  })

  test("sizes the Detail column from its left edge, so dragging left widens it", async () => {
    const { user } = openTheReader()

    await drag(user, "Detail column", -100)

    expect(drawn("Detail column")).toBe(740)
    expect(drawn("Console")).toBe(360)
    expect(divider("Console")).toHaveAttribute("aria-valuemax", "500")
  })

  test("widens the Detail column past 40%, as far as the Activity table's minimum", async () => {
    const { user } = openTheReader()

    await drag(user, "Detail column", -1000)

    // 1600 − 360 for the Console − 360 for the table.
    expect(drawn("Detail column")).toBe(880)
  })

  test("stops each column at its minimum", async () => {
    const { user } = openTheReader()

    // Short of half the Console's minimum, where it would fold instead.
    await drag(user, "Console", -200)
    await drag(user, "Detail column", 1000)

    expect(drawn("Console")).toBe(240)
    expect(drawn("Detail column")).toBe(380)
  })

  test("stops the Console where the Activity table would go under its minimum", async () => {
    const { user } = openTheReader()

    await drag(user, "Console", 1000)

    expect(drawn("Console")).toBe(600)
  })

  test("keeps a width the developer set when the window resizes", async () => {
    const { user } = openTheReader()
    await drag(user, "Detail column", -60)

    resizeTo(2000)

    expect(drawn("Detail column")).toBe(700)
  })
})

describe("the keyboard on a Column divider", () => {
  test("moves it 16px an arrow press", async () => {
    const { user } = openTheReader()

    await press(user, "Console", "{ArrowRight}")
    await press(user, "Detail column", "{ArrowLeft}{ArrowLeft}")

    expect(drawn("Console")).toBe(376)
    expect(drawn("Detail column")).toBe(672)
  })

  test("never takes the Detail column below its minimum", async () => {
    const { user } = openTheReader()

    await press(user, "Detail column", "{ArrowRight>30/}")

    expect(drawn("Detail column")).toBe(380)
  })
})

describe("resetting a Column divider", () => {
  test("by double-click returns its column to the default", async () => {
    const { user } = openTheReader()
    await drag(user, "Console", 80)
    await drag(user, "Detail column", -80)

    await user.dblClick(divider("Console"))
    await user.dblClick(divider("Detail column"))

    expect(drawn("Console")).toBe(360)
    expect(drawn("Detail column")).toBe(640)
  })

  test("by Enter returns its column to the default", async () => {
    const { user } = openTheReader()
    await press(user, "Console", "{ArrowLeft}")
    await press(user, "Detail column", "{ArrowLeft}")

    await press(user, "Console", "{Enter}")
    await press(user, "Detail column", "{Enter}")

    expect(drawn("Console")).toBe(360)
    expect(drawn("Detail column")).toBe(640)
  })

  test("returns the Detail column to following 40% of the window", async () => {
    const { user } = openTheReader()
    await drag(user, "Detail column", -80)
    await press(user, "Detail column", "{Enter}")

    resizeTo(2000)

    expect(drawn("Detail column")).toBe(800)
  })
})

describe("column widths across a reload", () => {
  test("survive it, drawn on the first render", async () => {
    const { user, unmount } = openTheReader()
    await drag(user, "Console", -40)
    await drag(user, "Detail column", -160)
    unmount()

    openTheReader()

    expect(drawn("Console")).toBe(320)
    expect(drawn("Detail column")).toBe(800)
  })

  test("are forgotten by a reset", async () => {
    const { user, unmount } = openTheReader()
    await drag(user, "Console", -40)
    await drag(user, "Detail column", -160)
    await user.dblClick(divider("Console"))
    await user.dblClick(divider("Detail column"))
    unmount()

    openTheReader()
    resizeTo(2000)

    expect(drawn("Console")).toBe(360)
    expect(drawn("Detail column")).toBe(800)
  })
})

describe("a window too narrow for the requested widths", () => {
  test("takes width from the Detail column first, then the Console, each down to its minimum", async () => {
    const { user } = openTheReader()
    await drag(user, "Console", 40)
    await drag(user, "Detail column", -60)

    resizeTo(1300)
    expect(drawn("Detail column")).toBe(540)
    expect(drawn("Console")).toBe(400)

    resizeTo(1000)
    expect(drawn("Detail column")).toBe(380)
    expect(drawn("Console")).toBe(260)

    resizeTo(980)
    expect(drawn("Detail column")).toBe(380)
    expect(drawn("Console")).toBe(240)
    expect(consoleCollapsed()).toBe(false)
  })

  test("folds the Console once it cannot hold all three minimums", () => {
    openTheReader()

    resizeTo(979)

    expect(consoleCollapsed()).toBe(true)
    expect(drawn("Console")).toBe(32)
    // Its default 40%, now the fold has freed the room for it.
    expect(drawn("Detail column")).toBe(392)
  })

  test("reopens a Console it folded as soon as there is room", () => {
    openTheReader()
    resizeTo(900)

    resizeTo(980)

    expect(consoleCollapsed()).toBe(false)
    expect(drawn("Console")).toBe(240)
  })

  test("does not remember the fold it made across a reload", () => {
    const { unmount } = openTheReader()
    resizeTo(900)
    unmount()

    available = 1600
    openTheReader()

    expect(consoleCollapsed()).toBe(false)
  })

  test("leaves a fold the developer made folded when it widens again", async () => {
    const { user } = openTheReader()
    await collapseConsole(user)
    resizeTo(900)

    resizeTo(1600)

    expect(consoleCollapsed()).toBe(true)
  })

  test("opens a Console it folded when asked, at its minimum", async () => {
    const { user } = openTheReader()
    resizeTo(900)

    await expandConsole(user)

    expect(consoleCollapsed()).toBe(false)
    expect(drawn("Console")).toBe(240)
    expect(drawn("Detail column")).toBe(380)
  })

  test("folds the Console again when narrowed anew after it was opened", async () => {
    const { user } = openTheReader()
    resizeTo(900)
    await expandConsole(user)
    resizeTo(1600)

    resizeTo(900)

    expect(consoleCollapsed()).toBe(true)
  })

  test("keeps the Console folded to its strip and the Detail column at its minimum, however narrow", () => {
    openTheReader()

    resizeTo(500)

    expect(drawn("Console")).toBe(32)
    expect(drawn("Detail column")).toBe(380)
  })

  test("restores exactly the requested widths when it widens again", async () => {
    const { user } = openTheReader()
    await drag(user, "Console", 40)
    await drag(user, "Detail column", -60)

    resizeTo(700)
    resizeTo(1600)

    expect(consoleCollapsed()).toBe(false)
    expect(drawn("Console")).toBe(400)
    expect(drawn("Detail column")).toBe(700)
  })
})

describe("Hover grouping beside a moved divider", () => {
  const boundingClientRect = Element.prototype.getBoundingClientRect

  // A Console line ends where the Console does: at its divider. Everything else is at the
  // origin, which is enough for the rule to reach its row.
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function measure(this: Element) {
      const right = column("Console").contains(this) ? drawn("Console") : 0
      return { top: 0, bottom: 0, left: 0, right, width: right, height: 0, x: 0, y: 0 } as DOMRect
    }
  })

  afterEach(() => {
    Element.prototype.getBoundingClientRect = boundingClientRect
  })

  test("redraws the rule from where the Console now ends", async () => {
    const run = aRun("srv-1")
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts/12"),
      run.log("req-1", "Feed cache MISS"),
      run.finish("req-1"),
    ])
    await user.hover(lineSaying("Feed cache MISS"))

    await press(user, "Console", "{ArrowRight}")

    const rule = screen.getByRole("img", { name: "Hover grouping rule", hidden: true })
    expect(rule).toHaveAttribute("d", expect.stringMatching(/^M 376 /))
  })
})
