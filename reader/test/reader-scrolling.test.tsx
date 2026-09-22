import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { fireEvent, render, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC, HANGS as DENSE_HANG } from "./traffic.fixtures"
import type { Envelope } from "../src/shared/wire"
import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"
import { Reader } from "../src/ui/Reader"
import { aFold, chip, column, itemsOf, lit, rowShowing, search, select, tab, timeline } from "./reader.harness"

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

afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollHeight", geometry.scrollHeight!)
  Object.defineProperty(HTMLElement.prototype, "clientHeight", geometry.clientHeight!)
  Object.defineProperty(Element.prototype, "scrollTop", geometry.scrollTop!)
})

afterEach(() => {
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
function openTheReader(...envelopes: Envelope[]) {
  const user = userEvent.setup()
  const fold = aFold()

  fold.fold(envelopes)
  const { rerender } = render(<Reader {...fold.props} />)

  /** One `EventSource` message' worth of new activity, rendered the way `main.tsx` renders it. */
  function arrive(...arriving: Envelope[]) {
    fold.fold(arriving)
    rerender(<Reader {...fold.props} />)
  }

  /** What a *load-earlier* click puts into the fold: history from above the oldest row. */
  function pullEarlier(...pulled: Envelope[]) {
    fold.foldEarlier(pulled)
    rerender(<Reader {...fold.props} />)
  }

  return { user, arrive, pullEarlier }
}

type ColumnName = "Console" | "Activity table" | "Detail column"

/**
 * A column's scrollport. It has no role of its own — it is the column's body — so it is found
 * as what directly holds what the column lists: the Console's lines, the Activity table's
 * grid, the Detail column's selection or its placeholder.
 */
function scrollport(name: ColumnName) {
  const region = within(column(name))
  const content =
    name === "Console"
      ? region.getByRole("list")
      : name === "Activity table"
        ? region.getByRole("grid")
        : (region.queryByRole("article") ?? region.getByText(/Nothing selected/))
  return content.parentElement!
}

/**
 * Where every column is asked to be: pinned to the bottom of what it holds. Exact, unlike
 * `atBottom`'s `BOTTOM_SLACK` — the slack is there for a browser's fractional layout, and a
 * fake one that needed it would be a fake that had stopped standing in for anything.
 */
function pinnedToBottom(name: ColumnName) {
  const port = scrollport(name)
  return port.scrollTop === bottomOf(port)
}

/**
 * The one gesture that pauses: `up` pixels of it, in the column named. A scroll is no gesture
 * user-event can make, so it is set where a wheel would leave it and announced with `scroll`.
 */
function scrollUp(name: ColumnName, up = ROW) {
  const port = scrollport(name)
  port.scrollTop = bottomOf(port) - up
  fireEvent.scroll(port)
}

function scrollBackToTheBottom(name: ColumnName) {
  const port = scrollport(name)
  port.scrollTop = bottomOf(port)
  fireEvent.scroll(port)
}

function pill(name: ColumnName) {
  return within(column(name)).queryByRole("button", { name: /new$/ })
}

function schemaChip() {
  return chip("schema", "Filter by query kind")
}

/** Every entry the Detail column is showing, its own timeline's and the trailing section's. */
function detailEntries() {
  const trailing = within(column("Detail column")).queryByRole("region", { name: "After the request finished" })
  return [...itemsOf(timeline()), ...(trailing === null ? [] : itemsOf(within(trailing).getByRole("list")))]
}

const COLUMNS: ColumnName[] = ["Console", "Activity table", "Detail column"]

// ---- the tests ----------------------------------------------------------------------

describe("opening the Reader", () => {
  test("pins all three columns to the bottom of the loaded history", async () => {
    const { user } = openTheReader(...HISTORY)
    await select(user, "/reports/monthly.csv")

    for (const name of COLUMNS) expect([name, pinnedToBottom(name)]).toEqual([name, true])
  })

  test("pins them to the bottom of a busy fold too, where every column overflows several times over", async () => {
    // The hand-written history above is small enough to reason about a count in; this is the
    // volume the columns are actually read at — three Runs, 59 rows and a Console of hundreds
    // — and the opening position is the one thing about it that must not depend on how much
    // there is.
    const { user } = openTheReader(...DENSE_TRAFFIC)
    await select(user, DENSE_HANG.path)

    for (const name of COLUMNS) expect([name, pinnedToBottom(name)]).toEqual([name, true])
  })

  test("shows no pill anywhere, because nothing is paused and nothing has been missed", async () => {
    openTheReader(...HISTORY)

    for (const name of COLUMNS) expect(pill(name)).not.toBeInTheDocument()
  })
})

describe("a following column", () => {
  test("stays on the bottom as things arrive", async () => {
    const { arrive } = openTheReader(...HISTORY)
    const console = scrollport("Console")
    const wasAt = console.scrollTop

    arrive(...aRequest("r4", "/late", 2))

    expect(console.scrollTop).toBeGreaterThan(wasAt)
    expect(pinnedToBottom("Console")).toBe(true)
    expect(pinnedToBottom("Activity table")).toBe(true)
  })
})

describe("scrolling up", () => {
  test("pauses the column it happened in, and that column only", async () => {
    const { arrive } = openTheReader(...HISTORY)
    scrollUp("Console")

    arrive(...aRequest("r4", "/late", 2))

    expect(pinnedToBottom("Console")).toBe(false)
    // The whole of the issue: the Activity table follows new traffic while the Console is
    // being read back through.
    expect(pinnedToBottom("Activity table")).toBe(true)
    expect(pill("Activity table")).not.toBeInTheDocument()
  })

  test("counts what arrives below, and says the count on a pill", async () => {
    const { arrive } = openTheReader(...HISTORY)
    scrollUp("Console")

    arrive(run.log(null, "job one"), run.log(null, "job two"))

    expect(pill("Console")).toHaveTextContent("2 new")
  })

  test("keeps counting as more arrives", async () => {
    const { arrive } = openTheReader(...HISTORY)
    scrollUp("Console")

    arrive(run.log(null, "job one"))
    arrive(run.log(null, "job two"), run.log(null, "job three"))

    expect(pill("Console")).toHaveTextContent("3 new")
  })

  test("counts rows in the Activity table, which is what a row of it is", async () => {
    const { arrive } = openTheReader(...HISTORY)
    scrollUp("Activity table")

    arrive(...aRequest("r4", "/late", 2), ...aRequest("r5", "/later", 2))

    expect(pill("Activity table")).toHaveTextContent("2 new")
    // A row mutating in place is not a row arriving: the count is of rows, and `r4`
    // finishing under a paused table is the same row saying more about itself.
    expect(pill("Console")).not.toBeInTheDocument()
  })

  test("shows no pill while nothing has arrived, so reading back through a quiet column is not covered by one", async () => {
    openTheReader(...HISTORY)

    scrollUp("Console")

    // Paused, and the pill's own text is the reason it is not here: "0 new" would send a
    // reader to look at nothing. Scrolling back down is the way out either way.
    expect(pill("Console")).not.toBeInTheDocument()
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
    const { pullEarlier } = openTheReader(...HISTORY)
    scrollUp("Activity table")

    pullEarlier(...EARLIER)

    // The rows are there — three of them, a Run row and two requests — and above everything
    // the table already held. A pill saying "3 new" would be sending the reader *down* to
    // find history that went *up*.
    expect(rowShowing("/earlier/one")).toBeInTheDocument()
    expect(pill("Activity table")).not.toBeInTheDocument()
  })

  test("leaves the paused table paused, rather than following what it was handed", async () => {
    const { pullEarlier } = openTheReader(...HISTORY)
    scrollUp("Activity table")

    pullEarlier(...EARLIER)

    expect(pinnedToBottom("Activity table")).toBe(false)
  })

  test("counts what arrives below afterwards, the pull having changed nothing about that", async () => {
    const { arrive, pullEarlier } = openTheReader(...HISTORY)
    scrollUp("Activity table")

    pullEarlier(...EARLIER)
    arrive(...aRequest("r4", "/late", 2))

    expect(pill("Activity table")).toHaveTextContent("1 new")
  })
})

describe("resuming", () => {
  test("happens silently when the column is scrolled back to the bottom", async () => {
    const { arrive } = openTheReader(...HISTORY)
    scrollUp("Console")
    arrive(run.log(null, "job one"))

    scrollBackToTheBottom("Console")

    expect(pill("Console")).not.toBeInTheDocument()
    // And it is following again: the next thing to arrive is shown without being asked for.
    arrive(run.log(null, "job two"))
    expect(pinnedToBottom("Console")).toBe(true)
  })

  test("happens on the pill, which takes the column to the bottom and drops the count", async () => {
    const { user, arrive } = openTheReader(...HISTORY)
    scrollUp("Console")
    arrive(run.log(null, "job one"))

    const clicked = pill("Console")
    if (clicked === null) throw new Error("the paused Console has no pill to click")
    await user.click(clicked)

    expect(pinnedToBottom("Console")).toBe(true)
    expect(pill("Console")).not.toBeInTheDocument()
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
    const { arrive } = openTheReader(...HISTORY)
    scrollUp("Activity table")

    // Short of the cap: nothing has been evicted, so nothing here has to be a floor.
    arrive(...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 - 20, 100))

    expect(pill("Activity table")).toHaveTextContent(/^↓ \d+ new$/)
  })

  test("switches to a floor once the table is at the cap and evicting", async () => {
    const { arrive } = openTheReader(...HISTORY)
    scrollUp("Activity table")

    // The first batch pushes the table past the cap, and its own eviction still leaves the
    // rendered length ahead of where it started. It is the *next* batch, folded once every
    // row taken already evicts one, whose rendered length holds still — which is the stall
    // the pill has to say something about.
    arrive(...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 20, 100))
    arrive(...finishedRequests(run, 2, 100_000))

    expect(pill("Activity table")).toHaveTextContent(/^↓ \d+\+ new$/)
  })

  test("shows the floor on the Console too, since #63 ties its retention to the same eviction", async () => {
    const { arrive } = openTheReader(...HISTORY)
    scrollUp("Console")

    arrive(...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 20, 100))
    arrive(...finishedRequests(run, 2, 100_000))

    expect(pill("Console")).toHaveTextContent(/\+ new$/)
  })

  test("leaves the Detail column an exact count, since the Memory bound does not apply to it as a fold", async () => {
    const { user, arrive } = openTheReader(...HISTORY)
    await select(user, "/reports/monthly.csv")
    scrollUp("Detail column")

    arrive(...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 20, 100))
    arrive(...finishedRequests(run, 2, 100_000), run.log(HANGS, "still aggregating"))

    expect(pill("Detail column")).toHaveTextContent("1 new")
    expect(pill("Detail column")).not.toHaveTextContent("+")
  })

  test("resuming a floored pill returns the column to following, unchanged", async () => {
    const { user, arrive } = openTheReader(...HISTORY)
    scrollUp("Activity table")
    arrive(...finishedRequests(run, LOAD_ON_OPEN_EVENTS / 2 + 20, 100))
    arrive(...finishedRequests(run, 2, 100_000))

    const clicked = pill("Activity table")
    if (clicked === null) throw new Error("the paused, floored table has no pill to click")
    await user.click(clicked)

    expect(pinnedToBottom("Activity table")).toBe(true)
    expect(pill("Activity table")).not.toBeInTheDocument()
  })
})

describe("what may never pause a column", () => {
  test("selecting a row, which leaves the Activity table following", async () => {
    const { user, arrive } = openTheReader(...HISTORY)

    await select(user, "/posts")

    arrive(...aRequest("r4", "/late", 2))
    expect(pinnedToBottom("Activity table")).toBe(true)
    expect(pill("Activity table")).not.toBeInTheDocument()
  })
})

describe("what may never resume a column", () => {
  test("a Run boundary, which is one more thing that arrived", async () => {
    const { arrive } = openTheReader(...HISTORY)
    scrollUp("Activity table")

    const restarted = aRun("srv-26-restarted")
    arrive(restarted.header(), restarted.log(null, "boot: environment loaded"))

    expect(pinnedToBottom("Activity table")).toBe(false)
    expect(pinnedToBottom("Console")).toBe(true)
  })

  test("a row-kind tab, which re-derives what the Activity table is listing rather than adding to it", async () => {
    const { user, arrive } = openTheReader(...HISTORY)
    scrollUp("Activity table")
    arrive(...aRequest("r4", "/late", 2))

    await user.click(tab("Requests"))

    expect(pinnedToBottom("Activity table")).toBe(false)
    // The Run row went with the tab, and a row leaving is not a row arriving: the count is
    // what came in below while the reader was away, and it stands.
    expect(pill("Activity table")).toHaveTextContent("1 new")
  })

  test("a level chip, which re-derives what the Console is showing rather than adding to it", async () => {
    const { user, arrive } = openTheReader(...HISTORY)
    scrollUp("Console")
    arrive(run.log(null, "job one"))

    // Rails' own lines are hidden on open, so this reveals a pile of them at once — old
    // lines, every one of them, and none of them new.
    await user.click(chip("rails", "Filter by source"))

    expect(pinnedToBottom("Console")).toBe(false)
    expect(pill("Console")).toHaveTextContent("1 new")
  })
})

describe("the Detail column", () => {
  test("follows the selected row's own arrivals", async () => {
    const { user, arrive } = openTheReader(...HISTORY)
    await select(user, "/reports/monthly.csv")

    arrive(run.log(HANGS, "still aggregating"))

    expect(pinnedToBottom("Detail column")).toBe(true)
  })

  test("counts them while it is paused, and never the other columns' traffic", async () => {
    const { user, arrive } = openTheReader(...HISTORY)
    await select(user, "/reports/monthly.csv")
    scrollUp("Detail column")

    arrive(run.log(HANGS, "still aggregating"), ...aRequest("r4", "/late", 2))

    expect(pill("Detail column")).toHaveTextContent("1 new")
  })

  test("resets to following whenever Selection changes", async () => {
    const { user, arrive } = openTheReader(...HISTORY)
    await select(user, "/reports/monthly.csv")
    scrollUp("Detail column")
    arrive(run.log(HANGS, "still aggregating"))

    await select(user, "/posts")

    expect(pinnedToBottom("Detail column")).toBe(true)
    expect(pill("Detail column")).not.toBeInTheDocument()
  })

  test("leaves the other two columns exactly as they were when it does", async () => {
    const { user } = openTheReader(...HISTORY)
    scrollUp("Console")
    await select(user, "/reports/monthly.csv")

    expect(pinnedToBottom("Console")).toBe(false)
    expect(pinnedToBottom("Activity table")).toBe(true)
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
    const { user, arrive } = openTheReader(...HISTORY)
    await select(user, "/reports/monthly.csv")
    scrollUp("Detail column")
    arrive(run.log(HANGS, "still aggregating"))

    await user.click(schemaChip())

    // Neither disturbed by the toggle: a paused column stays paused, and the count is what
    // arrived while away — not old queries the chip has just revealed.
    expect(pinnedToBottom("Detail column")).toBe(false)
    expect(pill("Detail column")).toHaveTextContent("1 new")
  })

  test("never pauses or resumes the column on its own", async () => {
    const { user } = openTheReader(...HISTORY)
    await select(user, "/reports/monthly.csv")

    await user.click(schemaChip())

    expect(pinnedToBottom("Detail column")).toBe(true)
    expect(pill("Detail column")).not.toBeInTheDocument()
  })

  test("leaves the other two columns exactly as they were when it does", async () => {
    const { user } = openTheReader(...HISTORY)
    scrollUp("Console")
    await select(user, "/reports/monthly.csv")

    await user.click(schemaChip())

    expect(pinnedToBottom("Console")).toBe(false)
    expect(pinnedToBottom("Activity table")).toBe(true)
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
    const { user } = openTheReader(...HISTORY, ...aRequest("big1", "/n-plus-one", LARGE))
    await select(user, "/n-plus-one")

    expect(detailEntries()).toHaveLength(LARGE)
  })

  test("finds and highlights a match planted deep in the timeline, exactly as for any other match", async () => {
    const { user } = openTheReader(...HISTORY, ...aRequest("big2", "/n-plus-one", LARGE))
    await select(user, "/n-plus-one")

    await search(user, "step 901")

    expect(lit(scrollport("Detail column"))).toEqual(["step 901"])
  })

  test("keeps following across live-tail batches, and still pauses and resumes on scroll", async () => {
    const { user, arrive } = openTheReader(...HISTORY, ...aRequest("big3", "/n-plus-one", LARGE, false))
    await select(user, "/n-plus-one")

    arrive(run.log("big3", "batch one"))
    expect(pinnedToBottom("Detail column")).toBe(true)

    scrollUp("Detail column")
    arrive(run.log("big3", "batch two"))
    expect(pinnedToBottom("Detail column")).toBe(false)
    expect(pill("Detail column")).toHaveTextContent("1 new")

    scrollBackToTheBottom("Detail column")
    expect(pill("Detail column")).not.toBeInTheDocument()
    arrive(run.log("big3", "batch three"))
    expect(pinnedToBottom("Detail column")).toBe(true)
  })

  test("keeps the SCHEMA/EXPLAIN chip and the trailing section working at this volume", async () => {
    const { user, arrive } = openTheReader(
      ...HISTORY,
      ...aRequest("big4", "/n-plus-one", LARGE, false),
      run.sql("big4", 'PRAGMA table_info("posts")', { name: "SCHEMA" }),
      run.finish("big4"),
    )
    await select(user, "/n-plus-one")

    // SCHEMA hidden by default: one child of `LARGE + 1` does not show.
    expect(itemsOf(timeline())).toHaveLength(LARGE)

    await user.click(schemaChip())
    expect(itemsOf(timeline())).toHaveLength(LARGE + 1)

    arrive(run.log("big4", "after the request finished"))
    const trailing = within(column("Detail column")).getByRole("region", { name: "After the request finished" })
    expect(itemsOf(within(trailing).getByRole("list"))).toHaveLength(1)
  })

  test("a Run row's large timeline gets the same treatment, since Timeline is shared", async () => {
    const burst: Envelope[] = []
    for (let each = 0; each < LARGE; each += 1) {
      burst.push(each % 2 === 0 ? run.sql(null) : run.log(null, `burst step ${each}`))
    }
    const { user } = openTheReader(...HISTORY, ...burst)
    await select(user, "server")

    // Plus the two boot lines `HISTORY` already opened this Run row with.
    expect(detailEntries()).toHaveLength(LARGE + 2)
  })
})
