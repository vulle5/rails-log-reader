import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"

import { aRun } from "./sidecar.fixtures"
import type { Envelope } from "../src/shared/wire"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")
const { activityTable, requestRowId } = await import("../src/shared/activity")
const { consoleStream } = await import("../src/shared/console")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * The three *auto-scrolls*, through the columns that own them. `auto-scroll.test.ts` has the
 * rule itself; this is about the three of them being three — that scrolling one column back
 * says nothing about the other two — and about the things that must never move any of them:
 * a selection, a Run boundary, a filter.
 *
 * happy-dom does no layout, so the layout is supplied: every row is `ROW` pixels tall, every
 * column is `PORT` pixels of scrollport, and `scrollTop` clamps to the range a browser would
 * clamp it to. That is the whole of what the DOM contributes to this feature — a scrollport
 * reports where it is, and the rule reads it — so faking it is faking the input, not the
 * answer.
 */

/** Tall enough that a handful of rows overflows it, so a test can scroll at all. */
const PORT = 60
const ROW = 20

const geometry = {
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
}

const scrolledTo = new WeakMap<Element, number>()

beforeAll(() => {
  // A row is a Console line, a table row or a timeline entry — every one of them an `li` or
  // a `tr`, which is what makes one measure enough for all three columns.
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return this.querySelectorAll("li, tr").length * ROW
    },
  })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => PORT })
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return scrolledTo.get(this) ?? 0
    },
    set(this: Element, top: number) {
      scrolledTo.set(this, Math.min(Math.max(top, 0), bottomOf(this)))
    },
  })
})

afterAll(async () => {
  Object.defineProperty(Element.prototype, "scrollHeight", geometry.scrollHeight!)
  Object.defineProperty(HTMLElement.prototype, "clientHeight", geometry.clientHeight!)
  Object.defineProperty(Element.prototype, "scrollTop", geometry.scrollTop!)
  await GlobalRegistrator.unregister()
})

const mounted: { unmount: () => void }[] = []

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount()
  })
  document.body.innerHTML = ""
  localStorage.clear()
})

/** How far down a scrollport goes: what "the bottom" means, and what a browser clamps to. */
function bottomOf(port: Element) {
  return Math.max(port.scrollHeight - (port as HTMLElement).clientHeight, 0)
}

// ---- the traffic --------------------------------------------------------------------

const run = aRun("srv-26")

/** A request with `children` events under it, so a detail column has something to scroll. */
function aRequest(id: string, path: string, children: number, finishes = true): Envelope[] {
  const envelopes: Envelope[] = [run.start(id, "GET", path), run.route(id)]
  for (let each = 0; each < children; each += 1) {
    envelopes.push(each % 2 === 0 ? run.sql(id) : run.log(id, `${path} step ${each}`))
  }
  return finishes ? [...envelopes, run.finish(id)] : envelopes
}

/** The request that hangs: still in flight, so more of its own events can arrive later. */
const HANGS = "hang26"

const HISTORY: Envelope[] = [
  run.header(),
  run.log(null, "boot: environment loaded"),
  run.log(null, "boot: listening on 3000"),
  ...aRequest("r1", "/posts", 6),
  ...aRequest("r2", "/posts/12", 2),
  ...aRequest("r3", "/comments", 2),
  ...aRequest(HANGS, "/reports/monthly.csv", 6, false),
]

// ---- mounting -----------------------------------------------------------------------

/**
 * The Reader over both folds, seeded from one stream of envelopes and fed more the way the
 * live Sidecar feeds them: folded, then handed over as new arrays, which is exactly what
 * `useSidecar` does.
 */
async function openTheReader(...envelopes: Envelope[]) {
  const activity = activityTable()
  const stream = consoleStream()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted.push(root)

  async function arrive(...arriving: Envelope[]) {
    activity.fold(arriving)
    stream.fold(arriving)
    await act(async () => root.render(<Reader rows={[...activity.rows]} lines={[...stream.lines]} />))
  }

  await arrive(...envelopes)
  return { container, arrive }
}

function column(container: HTMLElement, name: string) {
  const region = container.querySelector(`[aria-label="${name}"]`)
  if (region === null) throw new Error(`the Reader has no ${name}`)
  return region
}

function scrollport(container: HTMLElement, name: string) {
  const port = column(container, name).querySelector(".column-body")
  if (port === null) throw new Error(`${name} has no scrollport`)
  return port as HTMLElement
}

/** Where every column is asked to be: pinned to the bottom of what it holds. */
function atBottom(container: HTMLElement, name: string) {
  const port = scrollport(container, name)
  return port.scrollTop === bottomOf(port)
}

/** The one gesture that pauses: `up` pixels of it, in the column named. */
async function scrollUp(container: HTMLElement, name: string, up = ROW) {
  const port = scrollport(container, name)
  port.scrollTop = bottomOf(port) - up
  await act(async () => port.dispatchEvent(new Event("scroll")))
}

async function scrollBackToTheBottom(container: HTMLElement, name: string) {
  const port = scrollport(container, name)
  port.scrollTop = bottomOf(port)
  await act(async () => port.dispatchEvent(new Event("scroll")))
}

function pill(container: HTMLElement, name: string) {
  return column(container, name).querySelector(".new-pill")
}

async function click(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))
}

async function selectRow(container: HTMLElement, requestId: string) {
  const row = container.querySelector(`[data-row="${requestRowId(requestId)}"]`)
  if (row === null) throw new Error(`no row for ${requestId}`)
  await click(row)
}

const COLUMNS = ["Console", "Activity table", "Detail column"]

// ---- the tests ----------------------------------------------------------------------

describe("opening the Reader", () => {
  test("pins all three columns to the bottom of the loaded history", async () => {
    const { container } = await openTheReader(...HISTORY)
    await selectRow(container, HANGS)

    for (const name of COLUMNS) expect([name, atBottom(container, name)]).toEqual([name, true])
  })

  test("shows no pill anywhere, because nothing is paused and nothing has been missed", async () => {
    const { container } = await openTheReader(...HISTORY)

    for (const name of COLUMNS) expect(pill(container, name)).toBeNull()
  })
})

describe("a following column", () => {
  test("stays on the bottom as things arrive", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    const console = scrollport(container, "Console")
    const wasAt = console.scrollTop

    await arrive(...aRequest("r4", "/late", 2))

    expect(console.scrollTop).toBeGreaterThan(wasAt)
    expect(atBottom(container, "Console")).toBe(true)
    expect(atBottom(container, "Activity table")).toBe(true)
  })
})

describe("scrolling up", () => {
  test("pauses the column it happened in, and that column only", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")

    await arrive(...aRequest("r4", "/late", 2))

    expect(atBottom(container, "Console")).toBe(false)
    // The whole of the issue: the Activity table follows new traffic while the Console is
    // being read back through.
    expect(atBottom(container, "Activity table")).toBe(true)
    expect(pill(container, "Activity table")).toBeNull()
  })

  test("counts what arrives below, and says the count on a pill", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")

    await arrive(run.log(null, "job one"), run.log(null, "job two"))

    expect(pill(container, "Console")?.textContent).toContain("2 new")
  })

  test("keeps counting as more arrives", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")

    await arrive(run.log(null, "job one"))
    await arrive(run.log(null, "job two"), run.log(null, "job three"))

    expect(pill(container, "Console")?.textContent).toContain("3 new")
  })

  test("counts rows in the Activity table, which is what a row of it is", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Activity table")

    await arrive(...aRequest("r4", "/late", 2), ...aRequest("r5", "/later", 2))

    expect(pill(container, "Activity table")?.textContent).toContain("2 new")
    // A row mutating in place is not a row arriving: the count is of rows, and `r4`
    // finishing under a paused table is the same row saying more about itself.
    expect(pill(container, "Console")).toBeNull()
  })

  test("shows no pill while nothing has arrived, so reading back through a quiet column is not covered by one", async () => {
    const { container } = await openTheReader(...HISTORY)

    await scrollUp(container, "Console")

    // Paused, and the pill's own text is the reason it is not here: "0 new" would send a
    // reader to look at nothing. Scrolling back down is the way out either way.
    expect(pill(container, "Console")).toBeNull()
  })
})

describe("resuming", () => {
  test("happens silently when the column is scrolled back to the bottom", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")
    await arrive(run.log(null, "job one"))

    await scrollBackToTheBottom(container, "Console")

    expect(pill(container, "Console")).toBeNull()
    // And it is following again: the next thing to arrive is shown without being asked for.
    await arrive(run.log(null, "job two"))
    expect(atBottom(container, "Console")).toBe(true)
  })

  test("happens on the pill, which takes the column to the bottom and drops the count", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")
    await arrive(run.log(null, "job one"))

    const clicked = pill(container, "Console")
    if (clicked === null) throw new Error("the paused Console has no pill to click")
    await click(clicked)

    expect(atBottom(container, "Console")).toBe(true)
    expect(pill(container, "Console")).toBeNull()
  })
})

describe("what may never pause a column", () => {
  test("selecting a row, which leaves the Activity table following", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)

    await selectRow(container, "r1")

    await arrive(...aRequest("r4", "/late", 2))
    expect(atBottom(container, "Activity table")).toBe(true)
    expect(pill(container, "Activity table")).toBeNull()
  })
})

describe("what may never resume a column", () => {
  test("a Run boundary, which is one more thing that arrived", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Activity table")

    const restarted = aRun("srv-26-restarted")
    await arrive(restarted.header(), restarted.log(null, "boot: environment loaded"))

    expect(atBottom(container, "Activity table")).toBe(false)
    expect(atBottom(container, "Console")).toBe(true)
  })

  test("a level chip, which re-derives what the Console is showing rather than adding to it", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")
    await arrive(run.log(null, "job one"))

    // Rails' own lines are hidden on open, so this reveals a pile of them at once — old
    // lines, every one of them, and none of them new.
    const rails = column(container, "Console").querySelector("[aria-label='Filter by source'] button")
    if (rails === null) throw new Error("the Console has no source chip")
    await click(rails)

    expect(atBottom(container, "Console")).toBe(false)
    expect(pill(container, "Console")?.textContent).toContain("1 new")
  })
})

describe("the Detail column", () => {
  test("follows the selected row's own arrivals", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await selectRow(container, HANGS)

    await arrive(run.log(HANGS, "still aggregating"))

    expect(atBottom(container, "Detail column")).toBe(true)
  })

  test("counts them while it is paused, and never the other columns' traffic", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await selectRow(container, HANGS)
    await scrollUp(container, "Detail column")

    await arrive(run.log(HANGS, "still aggregating"), ...aRequest("r4", "/late", 2))

    expect(pill(container, "Detail column")?.textContent).toContain("1 new")
  })

  test("resets to following whenever Selection changes", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await selectRow(container, HANGS)
    await scrollUp(container, "Detail column")
    await arrive(run.log(HANGS, "still aggregating"))

    await selectRow(container, "r1")

    expect(atBottom(container, "Detail column")).toBe(true)
    expect(pill(container, "Detail column")).toBeNull()
  })

  test("leaves the other two columns exactly as they were when it does", async () => {
    const { container } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")
    await selectRow(container, HANGS)

    expect(atBottom(container, "Console")).toBe(false)
    expect(atBottom(container, "Activity table")).toBe(true)
  })
})
