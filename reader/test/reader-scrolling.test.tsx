import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC, HANGS as DENSE_HANG } from "./traffic.fixtures"
import type { Envelope } from "../src/shared/wire"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")
const { activityTable, requestRowId, runRowId } = await import("../src/shared/activity")
const { consoleStream } = await import("../src/shared/console")
const { LOAD_ON_OPEN_EVENTS } = await import("../src/shared/bounds")

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
  // Cumulative, the way `useSidecar` counts it — `WireStatus.evictedRows` — so a test that
  // fills the *Memory bound* over more than one `arrive` still says the same thing `main.tsx`
  // would.
  let evictedRows = 0

  async function arrive(...arriving: Envelope[]) {
    const evicted = activity.fold(arriving)
    stream.fold(arriving)
    stream.evict(evicted)
    evictedRows += evicted.length
    await act(async () =>
      root.render(<Reader rows={[...activity.rows]} lines={[...stream.lines]} evictedRows={evictedRows} />),
    )
  }

  /**
   * What a *load-earlier* click puts into the fold: a block of history that happened before
   * everything the fold holds, so its rows open above them. The Console is not given it, for
   * the reason `useSidecar` does not give it either — the Console is append order, and this
   * block belongs before the lines it already has rather than after them. It can still evict
   * — see `useSidecar` — so the Console still hears about whatever that takes.
   */
  async function pullEarlier(...pulled: Envelope[]) {
    const evicted = activity.foldEarlier(pulled)
    stream.evict(evicted)
    evictedRows += evicted.length
    await act(async () =>
      root.render(<Reader rows={[...activity.rows]} lines={[...stream.lines]} evictedRows={evictedRows} />),
    )
  }

  await arrive(...envelopes)
  return { container, arrive, pullEarlier }
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

/**
 * Where every column is asked to be: pinned to the bottom of what it holds. Exact, unlike
 * `atBottom`'s `BOTTOM_SLACK` — the slack is there for a browser's fractional layout, and a
 * fake one that needed it would be a fake that had stopped standing in for anything.
 */
function pinnedToBottom(container: HTMLElement, name: string) {
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

function tab(container: HTMLElement, named: string) {
  const found = [...container.querySelectorAll("[role='tab']")].find((each) =>
    each.textContent?.startsWith(named),
  )
  if (found === undefined) throw new Error(`no ${named} tab`)
  return found
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

async function selectRunRow(container: HTMLElement, runId: string) {
  const row = container.querySelector(`[data-row="${runRowId(runId)}"]`)
  if (row === null) throw new Error(`no row for run ${runId}`)
  await click(row)
}

function schemaChip(container: HTMLElement) {
  const found = [...container.querySelectorAll("[aria-label='Filter by query kind'] button")].find(
    (candidate) => candidate.textContent === "schema",
  )
  if (found === undefined) throw new Error("no schema chip")
  return found
}

/** Typed the way React hears it — see `reader-search.test.tsx` for why `.value` alone won't do. */
async function search(container: HTMLElement, term: string) {
  const box = container.querySelector<HTMLInputElement>("input[type='search']")
  if (box === null) throw new Error("the Reader has no search box")
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setValue?.call(box, term)
    box.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

/** Every highlighted stretch inside `region`, as the text it lit. */
function lit(region: Element) {
  return [...region.querySelectorAll("mark.search-match")].map((mark) => mark.textContent)
}

const COLUMNS = ["Console", "Activity table", "Detail column"]

// ---- the tests ----------------------------------------------------------------------

describe("opening the Reader", () => {
  test("pins all three columns to the bottom of the loaded history", async () => {
    const { container } = await openTheReader(...HISTORY)
    await selectRow(container, HANGS)

    for (const name of COLUMNS) expect([name, pinnedToBottom(container, name)]).toEqual([name, true])
  })

  test("pins them to the bottom of a busy fold too, where every column overflows several times over", async () => {
    // The hand-written history above is small enough to reason about a count in; this is the
    // volume the columns are actually read at — three Runs, 59 rows and a Console of hundreds
    // — and the opening position is the one thing about it that must not depend on how much
    // there is.
    const { container } = await openTheReader(...DENSE_TRAFFIC)
    await selectRow(container, DENSE_HANG.requestId)

    for (const name of COLUMNS) expect([name, pinnedToBottom(container, name)]).toEqual([name, true])
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
    expect(pinnedToBottom(container, "Console")).toBe(true)
    expect(pinnedToBottom(container, "Activity table")).toBe(true)
  })
})

describe("scrolling up", () => {
  test("pauses the column it happened in, and that column only", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")

    await arrive(...aRequest("r4", "/late", 2))

    expect(pinnedToBottom(container, "Console")).toBe(false)
    // The whole of the issue: the Activity table follows new traffic while the Console is
    // being read back through.
    expect(pinnedToBottom(container, "Activity table")).toBe(true)
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

describe("load-earlier", () => {
  // The control sits at the top of the Activity table's scrollport, above the oldest row it
  // holds, so reaching it means scrolling up — which is the gesture that pauses the column.
  // Every pull therefore lands in a paused table, and what a paused table does with rows is
  // count them.
  const previously = aRun("srv-25")
  const EARLIER: Envelope[] = [
    previously.header(),
    previously.start("e1", "GET", "/earlier/one"),
    previously.route("e1"),
    previously.finish("e1"),
    previously.start("e2", "GET", "/earlier/two"),
    previously.route("e2"),
    previously.finish("e2"),
  ]

  test("does not count what it prepends, because none of it arrived below", async () => {
    const { container, pullEarlier } = await openTheReader(...HISTORY)
    await scrollUp(container, "Activity table")

    await pullEarlier(...EARLIER)

    // The rows are there — three of them, a Run row and two requests — and above everything
    // the table already held. A pill saying "3 new" would be sending the reader *down* to
    // find history that went *up*.
    expect(container.querySelectorAll('[data-row="request e1"]').length).toBe(1)
    expect(pill(container, "Activity table")).toBeNull()
  })

  test("leaves the paused table paused, rather than following what it was handed", async () => {
    const { container, pullEarlier } = await openTheReader(...HISTORY)
    await scrollUp(container, "Activity table")

    await pullEarlier(...EARLIER)

    expect(pinnedToBottom(container, "Activity table")).toBe(false)
  })

  test("counts what arrives below afterwards, the pull having changed nothing about that", async () => {
    const { container, arrive, pullEarlier } = await openTheReader(...HISTORY)
    await scrollUp(container, "Activity table")

    await pullEarlier(...EARLIER)
    await arrive(...aRequest("r4", "/late", 2))

    expect(pill(container, "Activity table")?.textContent).toContain("1 new")
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
    expect(pinnedToBottom(container, "Console")).toBe(true)
  })

  test("happens on the pill, which takes the column to the bottom and drops the count", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")
    await arrive(run.log(null, "job one"))

    const clicked = pill(container, "Console")
    if (clicked === null) throw new Error("the paused Console has no pill to click")
    await click(clicked)

    expect(pinnedToBottom(container, "Console")).toBe(true)
    expect(pill(container, "Console")).toBeNull()
  })
})

describe("the Memory bound's cap (#64)", () => {
  // Two events to a row, exactly as `activity-table.test.ts`'s own `finishedRequests` counts
  // it, so a test can say how many rows a number of events comes to.
  function finishedRequests(server: ReturnType<typeof aRun>, count: number, from = 0) {
    return Array.from({ length: count }, (_, index) => [
      server.start(`bound-${from + index}`, "GET", `/bound/${from + index}`),
      server.finish(`bound-${from + index}`),
    ]).flat()
  }

  test("stays an exact count while the table has not yet reached the cap", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Activity table")

    // Short of the cap: nothing has been evicted, so nothing here has to be a floor.
    await arrive(...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 - 20, 100))

    expect(pill(container, "Activity table")?.textContent).toMatch(/^↓ \d+ new$/)
  })

  test("switches to a floor once the table is at the cap and evicting", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Activity table")

    // The first batch pushes the table past the cap, and its own eviction still leaves the
    // rendered length ahead of where it started. It is the *next* batch, folded once every
    // row taken already evicts one, whose rendered length holds still — which is the stall
    // the pill has to say something about.
    await arrive(...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 20, 100))
    await arrive(...finishedRequests(run, 2, 100_000))

    expect(pill(container, "Activity table")?.textContent).toMatch(/^↓ \d+\+ new$/)
  })

  test("shows the floor on the Console too, since #63 ties its retention to the same eviction", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")

    await arrive(...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 20, 100))
    await arrive(...finishedRequests(run, 2, 100_000))

    expect(pill(container, "Console")?.textContent).toMatch(/\+ new$/)
  })

  test("leaves the Detail column an exact count, since the Memory bound does not apply to it as a fold", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await selectRow(container, HANGS)
    await scrollUp(container, "Detail column")

    await arrive(...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 20, 100))
    await arrive(...finishedRequests(run, 2, 100_000), run.log(HANGS, "still aggregating"))

    expect(pill(container, "Detail column")?.textContent).toContain("1 new")
    expect(pill(container, "Detail column")?.textContent).not.toContain("+")
  })

  test("resuming a floored pill returns the column to following, unchanged", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Activity table")
    await arrive(...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 20, 100))
    await arrive(...finishedRequests(run, 2, 100_000))

    const clicked = pill(container, "Activity table")
    if (clicked === null) throw new Error("the paused, floored table has no pill to click")
    await click(clicked)

    expect(pinnedToBottom(container, "Activity table")).toBe(true)
    expect(pill(container, "Activity table")).toBeNull()
  })
})

describe("what may never pause a column", () => {
  test("selecting a row, which leaves the Activity table following", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)

    await selectRow(container, "r1")

    await arrive(...aRequest("r4", "/late", 2))
    expect(pinnedToBottom(container, "Activity table")).toBe(true)
    expect(pill(container, "Activity table")).toBeNull()
  })
})

describe("what may never resume a column", () => {
  test("a Run boundary, which is one more thing that arrived", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Activity table")

    const restarted = aRun("srv-26-restarted")
    await arrive(restarted.header(), restarted.log(null, "boot: environment loaded"))

    expect(pinnedToBottom(container, "Activity table")).toBe(false)
    expect(pinnedToBottom(container, "Console")).toBe(true)
  })

  test("a row-kind tab, which re-derives what the Activity table is listing rather than adding to it", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await scrollUp(container, "Activity table")
    await arrive(...aRequest("r4", "/late", 2))

    await click(tab(container, "Requests"))

    expect(pinnedToBottom(container, "Activity table")).toBe(false)
    // The Run row went with the tab, and a row leaving is not a row arriving: the count is
    // what came in below while the reader was away, and it stands.
    expect(pill(container, "Activity table")?.textContent).toContain("1 new")
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

    expect(pinnedToBottom(container, "Console")).toBe(false)
    expect(pill(container, "Console")?.textContent).toContain("1 new")
  })
})

describe("the Detail column", () => {
  test("follows the selected row's own arrivals", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await selectRow(container, HANGS)

    await arrive(run.log(HANGS, "still aggregating"))

    expect(pinnedToBottom(container, "Detail column")).toBe(true)
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

    expect(pinnedToBottom(container, "Detail column")).toBe(true)
    expect(pill(container, "Detail column")).toBeNull()
  })

  test("leaves the other two columns exactly as they were when it does", async () => {
    const { container } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")
    await selectRow(container, HANGS)

    expect(pinnedToBottom(container, "Console")).toBe(false)
    expect(pinnedToBottom(container, "Activity table")).toBe(true)
  })
})

/**
 * #54's chip is folded into the Detail column's `listing`, exactly as a Console chip is into
 * the Console's, but it is never by itself a `refollowsWhen` change: it thins the selected
 * row's own timeline rather than opening a different one, the same "same stream thinned" case
 * a Console chip already is. Only a new *Selection* refollows.
 */
describe("the Detail column's schema chip", () => {
  test("re-derives what the Detail column is showing rather than adding to it", async () => {
    const { container, arrive } = await openTheReader(...HISTORY)
    await selectRow(container, HANGS)
    await scrollUp(container, "Detail column")
    await arrive(run.log(HANGS, "still aggregating"))

    await click(schemaChip(container))

    // Neither disturbed by the toggle: a paused column stays paused, and the count is what
    // arrived while away — not old queries the chip has just revealed.
    expect(pinnedToBottom(container, "Detail column")).toBe(false)
    expect(pill(container, "Detail column")?.textContent).toContain("1 new")
  })

  test("never pauses or resumes the column on its own", async () => {
    const { container } = await openTheReader(...HISTORY)
    await selectRow(container, HANGS)

    await click(schemaChip(container))

    expect(pinnedToBottom(container, "Detail column")).toBe(true)
    expect(pill(container, "Detail column")).toBeNull()
  })

  test("leaves the other two columns exactly as they were when it does", async () => {
    const { container } = await openTheReader(...HISTORY)
    await scrollUp(container, "Console")
    await selectRow(container, HANGS)

    await click(schemaChip(container))

    expect(pinnedToBottom(container, "Console")).toBe(false)
    expect(pinnedToBottom(container, "Activity table")).toBe(true)
  })
})

/**
 * A render count or a memo boundary is never asserted here — only external behaviour is —
 * so what follows is the same behaviour the small-request tests above already cover,
 * reproduced at a volume large enough that a regression in how a row's own rendering cost
 * scales would show up as one of these assertions failing.
 */
describe("a request with a very large number of children", () => {
  const LARGE = 1200

  test("renders every SQL and log child, nothing thinned and nothing paginated", async () => {
    const { container } = await openTheReader(...HISTORY, ...aRequest("big1", "/n-plus-one", LARGE))
    await selectRow(container, "big1")

    expect(scrollport(container, "Detail column").querySelectorAll(".entry")).toHaveLength(LARGE)
  })

  test("finds and highlights a match planted deep in the timeline, exactly as for any other match", async () => {
    const { container } = await openTheReader(...HISTORY, ...aRequest("big2", "/n-plus-one", LARGE))
    await selectRow(container, "big2")

    await search(container, "step 901")

    expect(lit(scrollport(container, "Detail column"))).toEqual(["step 901"])
  })

  test("keeps following across live-tail batches, and still pauses and resumes on scroll", async () => {
    const { container, arrive } = await openTheReader(...HISTORY, ...aRequest("big3", "/n-plus-one", LARGE, false))
    await selectRow(container, "big3")

    await arrive(run.log("big3", "batch one"))
    expect(pinnedToBottom(container, "Detail column")).toBe(true)

    await scrollUp(container, "Detail column")
    await arrive(run.log("big3", "batch two"))
    expect(pinnedToBottom(container, "Detail column")).toBe(false)
    expect(pill(container, "Detail column")?.textContent).toContain("1 new")

    await scrollBackToTheBottom(container, "Detail column")
    expect(pill(container, "Detail column")).toBeNull()
    await arrive(run.log("big3", "batch three"))
    expect(pinnedToBottom(container, "Detail column")).toBe(true)
  })

  test("keeps the SCHEMA/EXPLAIN chip and the trailing section working at this volume", async () => {
    const { container, arrive } = await openTheReader(
      ...HISTORY,
      ...aRequest("big4", "/n-plus-one", LARGE, false),
      run.sql("big4", 'PRAGMA table_info("posts")', { name: "SCHEMA" }),
      run.finish("big4"),
    )
    await selectRow(container, "big4")
    const timelineEntries = () => scrollport(container, "Detail column").querySelectorAll(".timeline .entry")

    // SCHEMA hidden by default: one child of `LARGE + 1` does not show.
    expect(timelineEntries()).toHaveLength(LARGE)

    await click(schemaChip(container))
    expect(timelineEntries()).toHaveLength(LARGE + 1)

    await arrive(run.log("big4", "after the request finished"))
    const trailing = column(container, "Detail column").querySelector("[aria-label='After the request finished']")
    if (trailing === null) throw new Error("no trailing section")
    expect(trailing.querySelectorAll(".entry")).toHaveLength(1)
  })

  test("a Run row's large timeline gets the same treatment, since Timeline is shared", async () => {
    const burst: Envelope[] = []
    for (let each = 0; each < LARGE; each += 1) {
      burst.push(each % 2 === 0 ? run.sql(null) : run.log(null, `burst step ${each}`))
    }
    const { container } = await openTheReader(...HISTORY, ...burst)
    await selectRunRow(container, run.runId)

    // Plus the two boot lines `HISTORY` already opened this Run row with.
    expect(scrollport(container, "Detail column").querySelectorAll(".entry")).toHaveLength(LARGE + 2)
  })
})
