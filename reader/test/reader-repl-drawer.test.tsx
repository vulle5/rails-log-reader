import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { act, screen, within } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"

import { aRun } from "./sidecar.fixtures"
import {
  collapseConsole,
  column,
  consoleCollapsed,
  expandConsole,
  foldRepl,
  lineSaying,
  openRepl,
  openTheReader,
  replDrawer,
  replOpen,
} from "./reader.harness"

/**
 * The *REPL* drawer's frame, through the rendered Reader: folded and opened by the button in its
 * header, and sized by the separator along its top edge, read through the drawn height it reports.
 *
 * happy-dom does no layout, so the one input the drawer reads — the height the Reader has — is
 * supplied as the window's: a window resize is `innerHeight` changing and a `resize` dispatched.
 *
 * Every height here is out of the window's 900px, less the 12px of the three 4px gaps above,
 * under and between the rows, which leaves the drawer 728px once the columns above keep their
 * 160px minimum.
 */

const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight")

beforeAll(() => {
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 })
})

afterAll(() => {
  Object.defineProperty(window, "innerHeight", innerHeight!)
})

beforeEach(() => {
  window.innerHeight = 900
})

afterEach(() => {
  localStorage.clear()
})

function edge() {
  return screen.getByRole("separator", { name: "REPL" })
}

function drawn() {
  return Number(edge().getAttribute("aria-valuenow"))
}

function heading() {
  return within(replDrawer()).getByRole("heading", { name: "REPL" })
}

/** The drawer's body: the REPL's prompt, which a folded drawer drops. */
function prompt() {
  return within(replDrawer()).queryByRole("textbox", { name: "Ruby" })
}

/** Drags the drawer's top edge `by` pixels — downwards when positive. */
async function drag(user: UserEvent, by: number) {
  const target = edge()
  const from = 500
  await user.pointer([
    { keys: "[MouseLeft>]", target, coords: { clientY: from } },
    { target, coords: { clientY: from + by } },
    { keys: "[/MouseLeft]", target, coords: { clientY: from + by } },
  ])
}

async function press(user: UserEvent, keys: string) {
  act(() => edge().focus())
  await user.keyboard(keys)
}

function resizeTo(height: number) {
  window.innerHeight = height
  act(() => {
    window.dispatchEvent(new Event("resize"))
  })
}

/** Opens the drawer on a first visit, where it starts folded. */
async function openedTheReader(...args: Parameters<typeof openTheReader>) {
  const view = openTheReader(...args)
  await openRepl(view.user)
  return view
}

describe("the REPL drawer", () => {
  test("is headed REPL the way a column is, beside the Console, the Activity table and the Detail column", () => {
    openTheReader()

    expect(heading()).toBeInTheDocument()
    expect(column("Console")).toBeInTheDocument()
    expect(column("Activity table")).toBeInTheDocument()
    expect(column("Detail column")).toBeInTheDocument()
  })

  test("is folded to its header on a first visit", () => {
    openTheReader()

    expect(replOpen()).toBe(false)
    expect(prompt()).not.toBeInTheDocument()
    expect(drawn()).toBe(32)
  })

  test("opens at its default height", async () => {
    await openedTheReader()

    expect(within(replDrawer()).getByRole("button", { name: "Fold REPL" })).toHaveAttribute("aria-expanded", "true")
    expect(prompt()).toBeInTheDocument()
    expect(drawn()).toBe(288)
  })

  test("keeps the same header open and folded, dropping only the body", async () => {
    const { user } = openTheReader()
    const header = heading()

    await openRepl(user)
    expect(heading()).toBe(header)

    await foldRepl(user)
    expect(heading()).toBe(header)
    expect(prompt()).not.toBeInTheDocument()
  })

  test("opens by a click anywhere on its folded header", async () => {
    const { user } = openTheReader()

    await user.click(heading())

    expect(replOpen()).toBe(true)
  })
})

describe("the REPL drawer's top edge", () => {
  test("is a focusable horizontal separator, reporting the drawer's height", async () => {
    await openedTheReader()

    expect(edge()).toHaveAttribute("aria-orientation", "horizontal")
    expect(edge()).toHaveAttribute("aria-valuemin", "120")
    expect(edge()).toHaveAttribute("aria-valuemax", "728")
    act(() => edge().focus())
    expect(edge()).toHaveFocus()
  })

  test("resizes the drawer when dragged, upwards taller", async () => {
    const { user } = await openedTheReader()

    await drag(user, -100)
    expect(drawn()).toBe(388)

    await drag(user, 40)
    expect(drawn()).toBe(348)
  })

  test("stops the drawer at its minimum", async () => {
    const { user } = await openedTheReader()

    // Short of half the minimum, where it would fold instead.
    await drag(user, 200)

    expect(drawn()).toBe(120)
    expect(replOpen()).toBe(true)
  })

  test("stops the drawer where the columns above would go under their minimum", async () => {
    const { user } = await openedTheReader()

    await drag(user, -1000)

    expect(drawn()).toBe(728)
  })

  test("folds the drawer when dragged under half its minimum, and opens it at its minimum dragged back out", async () => {
    const { user } = await openedTheReader()
    await drag(user, -60)

    await drag(user, 300)
    expect(replOpen()).toBe(false)
    expect(drawn()).toBe(32)

    // From the 32px header to 92px: past half the minimum, short of the minimum itself.
    await drag(user, -60)
    expect(replOpen()).toBe(true)
    expect(drawn()).toBe(120)
  })

  test("follows the pointer from the folded header once the drag is past the minimum", async () => {
    const { user } = await openedTheReader()
    await drag(user, -100)
    await foldRepl(user)

    // From the 32px header: 32 + 168.
    await drag(user, -168)

    expect(drawn()).toBe(200)
  })

  test("leaves the height the button reopens at alone until a drag opens it", async () => {
    const { user } = await openedTheReader()
    await drag(user, -100)
    await drag(user, 400)

    await openRepl(user)

    expect(drawn()).toBe(388)
  })

  test("opens the drawer at its minimum by an arrow press", async () => {
    const { user } = await openedTheReader()
    await drag(user, -100)
    await foldRepl(user)

    await press(user, "{ArrowUp}")

    expect(replOpen()).toBe(true)
    expect(drawn()).toBe(120)
  })

  test("moves 16px an arrow press", async () => {
    const { user } = await openedTheReader()

    await press(user, "{ArrowUp}{ArrowUp}{ArrowDown}")

    expect(drawn()).toBe(304)
  })

  test("resets the drawer to its default height on a double-click", async () => {
    const { user } = await openedTheReader()
    await drag(user, -100)

    await user.dblClick(edge())

    expect(drawn()).toBe(288)
  })

  test("resets the drawer to its default height on Enter", async () => {
    const { user } = await openedTheReader()
    await press(user, "{ArrowUp}")

    await press(user, "{Enter}")

    expect(drawn()).toBe(288)
  })
})

describe("a window too short for the requested height", () => {
  test("draws the drawer shorter, and restores the request when it grows again", async () => {
    const { user } = await openedTheReader()
    await drag(user, -212)

    resizeTo(500)
    expect(drawn()).toBe(328)

    resizeTo(900)
    expect(drawn()).toBe(500)
  })

  test("never draws the drawer under its minimum", async () => {
    await openedTheReader()

    resizeTo(200)

    expect(drawn()).toBe(120)
  })
})

describe("the REPL drawer across a reload", () => {
  test("keeps its height and that it was open", async () => {
    const { user, unmount } = await openedTheReader()
    await drag(user, -100)
    unmount()

    openTheReader()

    expect(replOpen()).toBe(true)
    expect(drawn()).toBe(388)
  })

  test("keeps it folded once folded, and reopens it at its height", async () => {
    const { user, unmount } = await openedTheReader()
    await drag(user, -100)
    await foldRepl(user)
    unmount()

    const reloaded = openTheReader()
    expect(replOpen()).toBe(false)

    await openRepl(reloaded.user)
    expect(drawn()).toBe(388)
  })

  test("forgets a height that was reset", async () => {
    const { user, unmount } = await openedTheReader()
    await drag(user, -100)
    await user.dblClick(edge())
    unmount()

    openTheReader()

    expect(drawn()).toBe(288)
  })
})

describe("the Console beside an open REPL drawer", () => {
  const run = aRun("srv-1")
  const TRAFFIC = [run.start("req-1", "GET", "/posts/12"), run.log("req-1", "Feed cache MISS"), run.finish("req-1")]

  test("still folds into the Collapsed Console and opens again", async () => {
    const { user } = await openedTheReader(TRAFFIC)

    await collapseConsole(user)
    expect(consoleCollapsed()).toBe(true)
    expect(replOpen()).toBe(true)

    await expandConsole(user)
    expect(lineSaying("Feed cache MISS")).toBeInTheDocument()
  })

  describe("Hover grouping", () => {
    const boundingClientRect = Element.prototype.getBoundingClientRect

    // A Console line ends where the Console does. Everything else is at the origin, which is
    // enough for the rule to reach its row.
    beforeEach(() => {
      Element.prototype.getBoundingClientRect = function measure(this: Element) {
        const right = column("Console").contains(this) ? 360 : 0
        return { top: 0, bottom: 0, left: 0, right, width: right, height: 0, x: 0, y: 0 } as DOMRect
      }
    })

    afterEach(() => {
      Element.prototype.getBoundingClientRect = boundingClientRect
    })

    test("still draws the rule from a hovered line to its row", async () => {
      const { user } = await openedTheReader(TRAFFIC)

      await user.hover(lineSaying("Feed cache MISS"))

      expect(screen.getByRole("img", { name: "Hover grouping rule", hidden: true })).toBeInTheDocument()
    })
  })
})
