import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC } from "./traffic.fixtures"
import { NOT_SHOWN_CAPTION } from "../src/ui/grouping"
import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"
import type { Envelope } from "../src/shared/wire"
import {
  activityRows,
  cellUnder,
  chip,
  column,
  consoleLines,
  lineSaying,
  openTheReader,
  rowShowing,
  showRails,
  tab,
} from "./reader.harness"

/**
 * Every jump the Reader asked for, in order. Recorded rather than measured: happy-dom has
 * no layout, so "did the table scroll" is a question about what was asked of the element and
 * not about where it ended up.
 */
let jumps: Element[] = []
const scrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  jumps = []
  Element.prototype.scrollIntoView = function record(this: Element) {
    jumps.push(this)
  }
})

afterEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView
  // The level chips persist by design, which between tests is one test writing another's
  // filter.
  localStorage.clear()
})

/**
 * Seam 2, the Console's half: the Reader mounted over both folds, seeded from one stream of
 * envelopes — so what the rail is rendered over is what the file would actually produce.
 */
function theReader(...envelopes: Envelope[]) {
  return openTheReader(envelopes)
}

/** What each line says, in rail order — each read whole, since a message is its line's last part. */
function messages() {
  return consoleLines().map((line) => line.textContent)
}

function saying(...said: string[]) {
  return said.map((each) => expect.stringContaining(each))
}

function levelChip(named: string) {
  return chip(named, "Filter by level")
}

function rule() {
  return screen.queryByRole("img", { name: "Hover grouping rule", hidden: true })
}

describe("the Console rail", () => {
  test("shows every App log event in append order, attributed and unattributed alike", () => {
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    theReader(
      server.log(null, "=> Booting Puma"),
      server.start("req-1", "GET", "/posts/12"),
      server.log("req-1", "Feed cache MISS"),
      rake.log(null, "reports:rebuild — 41,209 orders"),
      server.finish("req-1"),
    )

    expect(messages()).toEqual(saying("=> Booting Puma", "Feed cache MISS", "reports:rebuild — 41,209 orders"))
  })

  test("contains no SQL at all, which is the whole reason a logger call is findable here", async () => {
    const { user } = theReader(...DENSE_TRAFFIC)

    // What the developer wrote, and nothing Rails did: 93 of this stream's 159 App log
    // events came from the app itself.
    expect(consoleLines()).toHaveLength(93)
    expect(within(column("Console")).queryAllByRole("code")).toHaveLength(0)

    await showRails(user)

    expect(consoleLines()).toHaveLength(159)
    expect(within(column("Console")).queryAllByRole("code")).toHaveLength(0)
  })

  test("shows every level by default — a floor above debug would hide the developer's own calls", () => {
    const run = aRun("srv-1")
    theReader(
      run.log(null, "a debug line", { severity: "debug" }),
      run.log(null, "an info line", { severity: "info" }),
      run.log(null, "a warning", { severity: "warn" }),
      run.log(null, "an error", { severity: "error" }),
      run.log(null, "a fatal", { severity: "fatal" }),
    )

    expect(messages()).toHaveLength(5)
    expect(lineSaying("a debug line")).toHaveAttribute("data-level", "debug")
  })

  test("labels Rails' own lines rather than dropping them, once they are asked for", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.log("req-1", 'Started GET "/posts/12"', { source: "rails" }),
      run.log("req-1", "Feed cache MISS", { source: "app" }),
    )
    await showRails(user)

    const label = "Rails wrote this line, not the app"
    expect(within(lineSaying("Started GET")).getByTitle(label)).toHaveTextContent(/^rails$/)
    expect(within(lineSaying("Feed cache MISS")).queryByTitle(label)).not.toBeInTheDocument()
  })

  test("shows the custom log_tags a line was written with", () => {
    const run = aRun("srv-1")
    theReader(run.log(null, "Performing DeliverWebhookJob", { tags: ["ActiveJob", "9f2c1a"] }))

    const tags = within(consoleLines()[0]!).getAllByText(/^(ActiveJob|9f2c1a)$/)
    expect(tags.map((tag) => tag.textContent)).toEqual(["ActiveJob", "9f2c1a"])
  })
})

/**
 * Volume is a *level* problem and never an attribution one: the chips are the only thinning
 * the Console has, and they start with nothing thinned.
 */
describe("the level chips", () => {
  function theReaderWithEveryLevel() {
    const run = aRun("srv-1")
    return theReader(
      run.log(null, "a debug line", { severity: "debug" }),
      run.log(null, "an info line", { severity: "info" }),
      run.log(null, "a warning", { severity: "warn" }),
    )
  }

  test("offers a chip per level, every one of them on", () => {
    theReaderWithEveryLevel()

    const chips = within(screen.getByRole("group", { name: "Filter by level" })).getAllByRole("button")
    expect(chips.map((each) => each.textContent)).toEqual(["debug", "info", "warn", "error", "fatal", "unknown"])
    for (const each of chips) expect(each).toHaveAttribute("aria-pressed", "true")
  })

  test("thins the Console to the levels left on, and nothing else about it", async () => {
    const { user } = theReaderWithEveryLevel()

    await user.click(levelChip("debug"))

    expect(messages()).toEqual(saying("an info line", "a warning"))
    expect(levelChip("debug")).toHaveAttribute("aria-pressed", "false")
  })

  test("persists the choice, because a filter re-set on every reload is one nobody uses", async () => {
    const first = theReaderWithEveryLevel()
    await first.user.click(levelChip("debug"))

    first.unmount()

    theReaderWithEveryLevel()
    expect(messages()).toEqual(saying("an info line", "a warning"))
  })
})

/**
 * The other axis the Console is thinned on, and the one that starts thinned: Rails' own
 * lines are most of a real dev app's log, and the Console exists so the handful you wrote is
 * findable among them.
 */
describe("the rails chip", () => {
  function theReaderWithBothSources() {
    const run = aRun("srv-1")
    return theReader(
      run.log(null, "=> Booting Puma", { source: "rails" }),
      run.log("req-1", "Feed cache MISS", { source: "app" }),
      run.log("req-1", 'Started GET "/posts/12"', { source: "rails" }),
      run.log("req-1", "Signed out user 4021", { source: "app" }),
    )
  }

  test("hides Rails' own lines on open, so what is left is what you wrote", () => {
    theReaderWithBothSources()

    expect(messages()).toEqual(saying("Feed cache MISS", "Signed out user 4021"))
    expect(chip("rails", "Filter by source")).toHaveAttribute("aria-pressed", "false")
  })

  test("brings them back, in append order among the app's own, when it is turned on", async () => {
    const { user } = theReaderWithBothSources()

    await showRails(user)

    expect(messages()).toEqual(saying("=> Booting Puma", "Feed cache MISS", 'Started GET "/posts/12"', "Signed out user 4021"))
  })

  test("thins the rail and never the fold — the detail column still holds what it hides", async () => {
    // Hidden is not dropped: the *Detail column* renders the request's own timeline off the
    // Activity fold, which never had a Console chip to answer to.
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.log("req-1", 'Started GET "/posts/12"', { source: "rails" }),
      run.finish("req-1"),
    )

    expect(consoleLines()).toHaveLength(0)

    await user.click(activityRows()[0]!)

    expect(within(screen.getByRole("list", { name: "Timeline" })).getByText('Started GET "/posts/12"')).toBeInTheDocument()
  })

  test("persists the choice, like the level chips beside it", async () => {
    const first = theReaderWithBothSources()
    await showRails(first.user)

    first.unmount()

    theReaderWithBothSources()
    expect(messages()).toHaveLength(4)
    expect(chip("rails", "Filter by source")).toHaveAttribute("aria-pressed", "true")
  })
})

/**
 * Clicking a line is the whole of *Selection* from this side: an attributed line selects the
 * request that printed it, an unattributed one the Run that did.
 */
describe("clicking a Console line", () => {
  test("selects the Request row of an attributed line", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/api/v1/feed"), run.log("req-1", "Feed cache MISS"), run.finish("req-1"))

    await user.click(lineSaying("Feed cache MISS"))

    expect(within(screen.getByRole("article")).getByText("/api/v1/feed")).toBeInTheDocument()
    expect(cellUnder(screen.getByRole("row", { current: true }), "Path")).toHaveTextContent(/^\/api\/v1\/feed$/)
  })

  test("selects the Run row of an unattributed line, which is no longer homeless", async () => {
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    const { user } = theReader(
      server.header(),
      server.start("req-1", "GET", "/api/v1/feed"),
      rake.header("rake", 91_887),
      rake.log(null, "reports:rebuild — 41,209 orders"),
    )

    await user.click(lineSaying("reports:rebuild"))

    expect(within(screen.getByRole("article")).getByText("rake")).toBeInTheDocument()
    expect(screen.getByRole("row", { current: true })).toHaveTextContent("pid 91887")
  })
})

/**
 * *Hover grouping*: the connection is drawn without moving anything, and pinned by a click
 * because the lit group is lost the moment the mouse moves — which is exactly what happens
 * next.
 */
describe("hovering a Console line", () => {
  function theReaderWithAGroup() {
    const run = aRun("srv-1")
    return theReader(
      run.header(),
      run.start("req-1", "GET", "/api/v1/feed"),
      run.log("req-1", "Feed cache MISS"),
      run.log("req-1", "Feed cache WRITE"),
      run.finish("req-1"),
      run.start("req-2", "GET", "/api/v1/me"),
      run.log("req-2", "Authenticated user 4021"),
      run.finish("req-2"),
    )
  }

  test("draws a gutter rule from the line to its Activity table row", async () => {
    const { user } = theReaderWithAGroup()

    await user.hover(lineSaying("Feed cache MISS"))

    expect(rule()).toHaveAttribute("data-rule", "connected")
    expect(rule()).toHaveAttribute("d", expect.stringMatching(/^M /))
  })

  test("lights the group and nothing else — no dimming, and no colour coding by request", async () => {
    const { user } = theReaderWithAGroup()
    const before = consoleLines().map((line) => line.outerHTML)

    await user.hover(lineSaying("Feed cache MISS"))

    const after = consoleLines().map((line) => line.outerHTML)
    const changed = after.filter((line, at) => line !== before[at])

    // Both of the request's own lines light, and the other request's does not change at all.
    expect(changed).toHaveLength(2)
    expect(lineSaying("Feed cache WRITE")).toHaveAttribute("data-grouping", "lit")
    expect(lineSaying("Authenticated user 4021").outerHTML).toBe(before[2]!)
    expect(rowShowing("/api/v1/feed")).toHaveAttribute("data-grouping", "lit")
    expect(rowShowing("/api/v1/me")).not.toHaveAttribute("data-grouping")
  })

  test("never scrolls the Activity table, however far away the row is", async () => {
    const { user } = theReaderWithAGroup()

    await user.hover(lineSaying("Feed cache MISS"))

    expect(jumps).toEqual([])
  })

  test("loses the lit group the moment the mouse moves off, which is what pinning is for", async () => {
    const { user } = theReaderWithAGroup()
    const line = lineSaying("Feed cache MISS")

    await user.hover(line)
    await user.unhover(line)

    for (const each of consoleLines()) expect(each).not.toHaveAttribute("data-grouping")
    expect(rule()).not.toBeInTheDocument()
  })

  test("does not select anything: hovering draws the connection without moving anything", async () => {
    const { user } = theReaderWithAGroup()

    await user.hover(lineSaying("Feed cache MISS"))

    expect(screen.queryByRole("row", { current: true })).not.toBeInTheDocument()
    expect(within(column("Detail column")).getByText(/Nothing selected/)).toBeInTheDocument()
  })

  test("ends the rule in a captioned stub when the row is not in the table, rather than connecting", async () => {
    const { user } = theReaderWithAGroup()

    // The row a tab filter is hiding is not somewhere the eye can land either — and the stub
    // says which of the two reasons it is, because "off screen" would be false about a row
    // that is not rendered at all. `grouping.test.ts` has the scrolled-past half, which a DOM
    // with no layout cannot reach.
    await user.click(tab("Runs"))
    await user.hover(lineSaying("Feed cache MISS"))

    expect(rule()).toHaveAttribute("data-rule", "not-shown")
    expect(screen.getByText(NOT_SHOWN_CAPTION)).toBeInTheDocument()
    expect(jumps).toEqual([])
  })
})

describe("pinning a Console line", () => {
  function theReaderWithAGroup() {
    const run = aRun("srv-1")
    return theReader(
      run.header(),
      run.start("req-1", "GET", "/api/v1/feed"),
      run.log("req-1", "Feed cache MISS"),
      run.finish("req-1"),
    )
  }

  test("keeps the group lit once the mouse has moved away", async () => {
    const { user } = theReaderWithAGroup()
    const line = lineSaying("Feed cache MISS")

    await user.hover(line)
    await user.click(line)
    await user.unhover(line)

    expect(line).toHaveAttribute("data-grouping", "pinned")
    expect(rowShowing("/api/v1/feed")).toHaveAttribute("data-grouping", "pinned")
    expect(rule()).toBeInTheDocument()
  })

  test("keeps the pinned group lit while the pointer sweeps other lines, which is what a pin is for", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/api/v1/feed"),
      run.log("req-1", "Feed cache MISS"),
      run.start("req-2", "GET", "/api/v1/me"),
      run.log("req-2", "Authenticated user 4021"),
    )
    const pinnedLine = lineSaying("Feed cache MISS")

    await user.click(pinnedLine)
    // Moving the mouse is exactly what happens next, and in a busy rail moving it means
    // crossing other lines. A pin a passing hover could put out would not be a pin.
    await user.hover(lineSaying("Authenticated user 4021"))

    expect(pinnedLine).toHaveAttribute("data-grouping", "pinned")
    expect(rowShowing("/api/v1/feed")).toHaveAttribute("data-grouping", "pinned")
    // ...and the line being swept over lights on its own, without taking the pin's mark.
    expect(lineSaying("Authenticated user 4021")).toHaveAttribute("data-grouping", "lit")
    expect(rowShowing("/api/v1/me")).toHaveAttribute("data-grouping", "lit")
  })

  test("jumps the Activity table to the row", async () => {
    const { user } = theReaderWithAGroup()

    await user.click(lineSaying("Feed cache MISS"))

    expect(jumps).toEqual([rowShowing("/api/v1/feed")])
  })

  test("clears a tab filter that is hiding the row first, then jumps to it", async () => {
    const { user } = theReaderWithAGroup()

    await user.click(tab("Runs"))
    expect(within(column("Activity table")).queryByText("/api/v1/feed")).not.toBeInTheDocument()

    await user.click(lineSaying("Feed cache MISS"))

    expect(tab("All")).toHaveAttribute("aria-selected", "true")
    expect(jumps).toEqual([rowShowing("/api/v1/feed")])
  })

  test("moves the pin to whichever line is clicked next", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/api/v1/feed"),
      run.log("req-1", "Feed cache MISS"),
      run.start("req-2", "GET", "/api/v1/me"),
      run.log("req-2", "Authenticated user 4021"),
    )

    await user.click(lineSaying("Feed cache MISS"))
    await user.click(lineSaying("Authenticated user 4021"))

    expect(lineSaying("Feed cache MISS")).not.toHaveAttribute("data-grouping", expect.stringContaining("pinned"))
    expect(rowShowing("/api/v1/feed")).not.toHaveAttribute("data-grouping", expect.stringContaining("pinned"))
    expect(rowShowing("/api/v1/me")).toHaveAttribute("data-grouping", expect.stringContaining("pinned"))
  })

  test("keeps the pin off the Activity table's own clicks, which say nothing about the Console", async () => {
    const { user } = theReaderWithAGroup()

    await user.click(lineSaying("Feed cache MISS"))
    await user.click(rowShowing("server"))

    for (const each of consoleLines()) expect(each).not.toHaveAttribute("data-grouping")
    expect(rule()).not.toBeInTheDocument()
  })
})

/**
 * #63: a Console line's lifetime is exactly its owning row's, borrowed from the *Memory
 * bound* rather than a second, independently-counted ring. `openTheReader` already wires
 * `stream.evict` the way `useSidecar` does, so this is the same seam every other test in this
 * file uses — just enough traffic past the row this one cares about to push it out.
 */
describe("Console retention under the Memory bound", () => {
  test("removes a line the instant the row it belongs to is evicted", () => {
    const run = aRun("srv-1")
    const doomed = [
      run.start("req-old", "GET", "/posts/1"),
      run.log("req-old", "the doomed log line"),
      run.finish("req-old"),
    ]
    // Enough finished requests after it to push the oldest row — this one — out of the ring.
    const filler = Array.from({ length: LOAD_ON_OPEN_EVENTS }, (_, index) => [
      run.start(`req-${index}`, "GET", `/posts/${index + 2}`),
      run.finish(`req-${index}`),
    ]).flat()

    theReader(...doomed, ...filler)

    expect(within(column("Console")).queryByText("the doomed log line")).not.toBeInTheDocument()
  })

  test("leaves a line alone while its row is still held, rendering exactly as before", () => {
    const run = aRun("srv-1")
    theReader(run.start("req-1", "GET", "/posts/12"), run.log("req-1", "Feed cache MISS"), run.finish("req-1"))

    expect(messages()).toEqual(saying("Feed cache MISS"))
  })
})
