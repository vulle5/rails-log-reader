import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC } from "./traffic.fixtures"
import { NOT_SHOWN_CAPTION } from "../src/ui/grouping"
import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")
const { activityTable } = await import("../src/shared/activity")
const { consoleStream } = await import("../src/shared/console")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { unmount: () => void }[] = []

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
  act(() => {
    for (const root of mounted.splice(0)) root.unmount()
  })
  document.body.innerHTML = ""
  // The level chips persist by design, which between tests is one test writing another's
  // filter.
  localStorage.clear()
})

/**
 * Seam 2, the Console's half: the Reader mounted over both folds, seeded from one stream of
 * envelopes — so what the rail is rendered over is what the file would actually produce.
 */
async function theReader(...envelopes: Parameters<ReturnType<typeof activityTable>["fold"]>[0]) {
  const activity = activityTable()
  const stream = consoleStream()
  const evicted = activity.fold(envelopes)
  stream.fold(envelopes)
  stream.evict(evicted)

  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => {
    const root = createRoot(container)
    mounted.push(root)
    root.render(<Reader rows={activity.rows} lines={stream.lines} />)
  })
  return container
}

function lines(container: HTMLElement) {
  return [...container.querySelectorAll(".console-line")]
}

function messages(container: HTMLElement) {
  return lines(container).map((line) => line.querySelector(".console-message")?.textContent)
}

function lineSaying(container: HTMLElement, said: string) {
  const found = lines(container).find((line) => line.textContent?.includes(said))
  if (found === undefined) throw new Error(`no Console line saying ${said}`)
  return found
}

async function hover(line: Element) {
  await act(async () => {
    line.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }))
  })
}

async function unhover(line: Element) {
  await act(async () => {
    line.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }))
  })
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

function chip(container: HTMLElement, named: string, group = "Filter by level") {
  const found = [...container.querySelectorAll(`[role='group'][aria-label='${group}'] button`)].find(
    (candidate) => candidate.textContent === named,
  )
  if (found === undefined) throw new Error(`no ${named} chip in ${group}`)
  return found
}

/** Rails' own lines start hidden, so a test about them has to ask for them first. */
async function showRails(container: HTMLElement) {
  await click(chip(container, "rails", "Filter by source"))
}

function tab(container: HTMLElement, name: string) {
  const found = [...container.querySelectorAll("[role='tab']")].find((candidate) =>
    candidate.textContent?.startsWith(name),
  )
  if (found === undefined) throw new Error(`no ${name} tab`)
  return found
}

function rule(container: HTMLElement) {
  return container.querySelector(".grouping-rule")
}

describe("the Console rail", () => {
  test("shows every App log event in append order, attributed and unattributed alike", async () => {
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    const container = await theReader(
      server.log(null, "=> Booting Puma"),
      server.start("req-1", "GET", "/posts/12"),
      server.log("req-1", "Feed cache MISS"),
      rake.log(null, "reports:rebuild — 41,209 orders"),
      server.finish("req-1"),
    )

    expect(messages(container)).toEqual(["=> Booting Puma", "Feed cache MISS", "reports:rebuild — 41,209 orders"])
  })

  test("contains no SQL at all, which is the whole reason a logger call is findable here", async () => {
    const container = await theReader(...DENSE_TRAFFIC)

    // What the developer wrote, and nothing Rails did: 93 of this stream's 159 App log
    // events came from the app itself.
    expect(lines(container)).toHaveLength(93)
    expect(container.querySelectorAll('[aria-label="Console"] .sql')).toHaveLength(0)

    await showRails(container)

    expect(lines(container)).toHaveLength(159)
    expect(container.querySelectorAll('[aria-label="Console"] .sql')).toHaveLength(0)
  })

  test("shows every level by default — a floor above debug would hide the developer's own calls", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.log(null, "a debug line", { severity: "debug" }),
      run.log(null, "an info line", { severity: "info" }),
      run.log(null, "a warning", { severity: "warn" }),
      run.log(null, "an error", { severity: "error" }),
      run.log(null, "a fatal", { severity: "fatal" }),
    )

    expect(messages(container)).toHaveLength(5)
    expect(lineSaying(container, "a debug line").className).toContain("log-debug")
  })

  test("labels Rails' own lines rather than dropping them, once they are asked for", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.log("req-1", "Started GET \"/posts/12\"", { source: "rails" }),
      run.log("req-1", "Feed cache MISS", { source: "app" }),
    )
    await showRails(container)

    const rails = lineSaying(container, "Started GET")
    expect(rails.querySelector(".console-source")?.textContent).toBe("rails")
    expect(lineSaying(container, "Feed cache MISS").querySelector(".console-source")).toBeNull()
  })

  test("shows the custom log_tags a line was written with", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.log(null, "Performing DeliverWebhookJob", { tags: ["ActiveJob", "9f2c1a"] }))

    expect([...lines(container)[0]!.querySelectorAll(".console-tag")].map((tag) => tag.textContent)).toEqual([
      "ActiveJob",
      "9f2c1a",
    ])
  })
})

/**
 * Volume is a *level* problem and never an attribution one: the chips are the only thinning
 * the Console has, and they start with nothing thinned.
 */
describe("the level chips", () => {
  async function theReaderWithEveryLevel() {
    const run = aRun("srv-1")
    return theReader(
      run.log(null, "a debug line", { severity: "debug" }),
      run.log(null, "an info line", { severity: "info" }),
      run.log(null, "a warning", { severity: "warn" }),
    )
  }

  test("offers a chip per level, every one of them on", async () => {
    const container = await theReaderWithEveryLevel()

    const chips = [...container.querySelectorAll("[role='group'][aria-label='Filter by level'] button")]
    expect(chips.map((each) => each.textContent)).toEqual(["debug", "info", "warn", "error", "fatal", "unknown"])
    expect(chips.every((each) => each.getAttribute("aria-pressed") === "true")).toBe(true)
  })

  test("thins the Console to the levels left on, and nothing else about it", async () => {
    const container = await theReaderWithEveryLevel()

    await click(chip(container, "debug"))

    expect(messages(container)).toEqual(["an info line", "a warning"])
    expect(chip(container, "debug").getAttribute("aria-pressed")).toBe("false")
  })

  test("persists the choice, because a filter re-set on every reload is one nobody uses", async () => {
    const first = await theReaderWithEveryLevel()
    await click(chip(first, "debug"))

    act(() => {
      for (const root of mounted.splice(0)) root.unmount()
    })
    document.body.innerHTML = ""

    const second = await theReaderWithEveryLevel()
    expect(messages(second)).toEqual(["an info line", "a warning"])
  })
})

/**
 * The other axis the Console is thinned on, and the one that starts thinned: Rails' own
 * lines are most of a real dev app's log, and the Console exists so the handful you wrote is
 * findable among them.
 */
describe("the rails chip", () => {
  async function theReaderWithBothSources() {
    const run = aRun("srv-1")
    return theReader(
      run.log(null, "=> Booting Puma", { source: "rails" }),
      run.log("req-1", "Feed cache MISS", { source: "app" }),
      run.log("req-1", "Started GET \"/posts/12\"", { source: "rails" }),
      run.log("req-1", "Signed out user 4021", { source: "app" }),
    )
  }

  test("hides Rails' own lines on open, so what is left is what you wrote", async () => {
    const container = await theReaderWithBothSources()

    expect(messages(container)).toEqual(["Feed cache MISS", "Signed out user 4021"])
    expect(chip(container, "rails", "Filter by source").getAttribute("aria-pressed")).toBe("false")
  })

  test("brings them back, in append order among the app's own, when it is turned on", async () => {
    const container = await theReaderWithBothSources()

    await showRails(container)

    expect(messages(container)).toEqual([
      "=> Booting Puma",
      "Feed cache MISS",
      'Started GET "/posts/12"',
      "Signed out user 4021",
    ])
  })

  test("thins the rail and never the fold — the detail column still holds what it hides", async () => {
    // Hidden is not dropped: the *Detail column* renders the request's own timeline off the
    // Activity fold, which never had a Console chip to answer to.
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.log("req-1", "Started GET \"/posts/12\"", { source: "rails" }),
      run.finish("req-1"),
    )

    expect(lines(container)).toHaveLength(0)

    const row = container.querySelector("tbody tr")
    await click(row!)

    expect(container.querySelector(".detail .log-message")?.textContent).toBe('Started GET "/posts/12"')
  })

  test("persists the choice, like the level chips beside it", async () => {
    const first = await theReaderWithBothSources()
    await showRails(first)

    act(() => {
      for (const root of mounted.splice(0)) root.unmount()
    })
    document.body.innerHTML = ""

    const second = await theReaderWithBothSources()
    expect(messages(second)).toHaveLength(4)
    expect(chip(second, "rails", "Filter by source").getAttribute("aria-pressed")).toBe("true")
  })
})

/**
 * Clicking a line is the whole of *Selection* from this side: an attributed line selects the
 * request that printed it, an unattributed one the Run that did.
 */
describe("clicking a Console line", () => {
  test("selects the Request row of an attributed line", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/api/v1/feed"),
      run.log("req-1", "Feed cache MISS"),
      run.finish("req-1"),
    )

    await click(lineSaying(container, "Feed cache MISS"))

    expect(container.querySelector(".detail-path")?.textContent).toBe("/api/v1/feed")
    expect(container.querySelector("tbody tr[aria-selected='true'] .cell-path")?.textContent).toBe("/api/v1/feed")
  })

  test("selects the Run row of an unattributed line, which is no longer homeless", async () => {
    const server = aRun("srv-1")
    const rake = aRun("rake-2")
    const container = await theReader(
      server.header(),
      server.start("req-1", "GET", "/api/v1/feed"),
      rake.header("rake", 91_887),
      rake.log(null, "reports:rebuild — 41,209 orders"),
    )

    await click(lineSaying(container, "reports:rebuild"))

    expect(container.querySelector(".detail-method")?.textContent).toBe("rake")
    expect(container.querySelector("tbody tr[aria-selected='true'] .cell-run")?.textContent).toContain("pid 91887")
  })
})

/**
 * *Hover grouping*: the connection is drawn without moving anything, and pinned by a click
 * because the lit group is lost the moment the mouse moves — which is exactly what happens
 * next.
 */
describe("hovering a Console line", () => {
  async function theReaderWithAGroup() {
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
    const container = await theReaderWithAGroup()

    await hover(lineSaying(container, "Feed cache MISS"))

    expect(rule(container)?.getAttribute("class")).toContain("grouping-rule-connected")
    expect(rule(container)?.getAttribute("d")).toMatch(/^M /)
  })

  test("lights the group and nothing else — no dimming, and no colour coding by request", async () => {
    const container = await theReaderWithAGroup()
    const before = lines(container).map((line) => line.className)

    await hover(lineSaying(container, "Feed cache MISS"))

    const after = lines(container).map((line) => line.className)
    const changed = after.filter((className, at) => className !== before[at])

    // Both of the request's own lines light, and the other request's does not change at all.
    expect(changed).toHaveLength(2)
    expect(lineSaying(container, "Feed cache WRITE").className).toContain("console-line-lit")
    expect(lineSaying(container, "Authenticated user 4021").className).toBe(before[2]!)
    expect(container.querySelector("tbody tr.activity-row-lit .cell-path")?.textContent).toBe("/api/v1/feed")
  })

  test("never scrolls the Activity table, however far away the row is", async () => {
    const container = await theReaderWithAGroup()

    await hover(lineSaying(container, "Feed cache MISS"))

    expect(jumps).toEqual([])
  })

  test("loses the lit group the moment the mouse moves off, which is what pinning is for", async () => {
    const container = await theReaderWithAGroup()
    const line = lineSaying(container, "Feed cache MISS")

    await hover(line)
    await unhover(line)

    expect(container.querySelector(".console-line-lit")).toBeNull()
    expect(rule(container)).toBeNull()
  })

  test("does not select anything: hovering draws the connection without moving anything", async () => {
    const container = await theReaderWithAGroup()

    await hover(lineSaying(container, "Feed cache MISS"))

    expect(container.querySelector("tbody tr[aria-selected='true']")).toBeNull()
    expect(container.querySelector(".placeholder")).not.toBeNull()
  })

  test("ends the rule in a captioned stub when the row is not in the table, rather than connecting", async () => {
    const container = await theReaderWithAGroup()

    // The row a tab filter is hiding is not somewhere the eye can land either — and the stub
    // says which of the two reasons it is, because "off screen" would be false about a row
    // that is not rendered at all. `grouping.test.ts` has the scrolled-past half, which a DOM
    // with no layout cannot reach.
    await click(tab(container, "Runs"))
    await hover(lineSaying(container, "Feed cache MISS"))

    expect(rule(container)?.getAttribute("class")).toContain("grouping-rule-not-shown")
    expect(container.querySelector(".grouping-caption")?.textContent).toBe(NOT_SHOWN_CAPTION)
    expect(jumps).toEqual([])
  })
})

describe("pinning a Console line", () => {
  async function theReaderWithAGroup() {
    const run = aRun("srv-1")
    return theReader(
      run.header(),
      run.start("req-1", "GET", "/api/v1/feed"),
      run.log("req-1", "Feed cache MISS"),
      run.finish("req-1"),
    )
  }

  test("keeps the group lit once the mouse has moved away", async () => {
    const container = await theReaderWithAGroup()
    const line = lineSaying(container, "Feed cache MISS")

    await hover(line)
    await click(line)
    await unhover(line)

    expect(line.className).toContain("console-line-pinned")
    expect(container.querySelector("tbody tr.activity-row-pinned .cell-path")?.textContent).toBe("/api/v1/feed")
    expect(rule(container)).not.toBeNull()
  })

  test("keeps the pinned group lit while the pointer sweeps other lines, which is what a pin is for", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/api/v1/feed"),
      run.log("req-1", "Feed cache MISS"),
      run.start("req-2", "GET", "/api/v1/me"),
      run.log("req-2", "Authenticated user 4021"),
    )
    const pinnedLine = lineSaying(container, "Feed cache MISS")

    await click(pinnedLine)
    // Moving the mouse is exactly what happens next, and in a busy rail moving it means
    // crossing other lines. A pin a passing hover could put out would not be a pin.
    await hover(lineSaying(container, "Authenticated user 4021"))

    expect(pinnedLine.className).toContain("console-line-pinned")
    expect(container.querySelector("tbody tr.activity-row-pinned .cell-path")?.textContent).toBe("/api/v1/feed")
    // ...and the line being swept over lights on its own, without taking the pin's mark.
    expect(lineSaying(container, "Authenticated user 4021").className).toContain("console-line-lit")
    expect(container.querySelector("tbody tr.activity-row-lit .cell-path")?.textContent).toBe("/api/v1/me")
  })

  test("jumps the Activity table to the row", async () => {
    const container = await theReaderWithAGroup()

    await click(lineSaying(container, "Feed cache MISS"))

    expect(jumps.map((element) => element.querySelector(".cell-path")?.textContent)).toEqual(["/api/v1/feed"])
  })

  test("clears a tab filter that is hiding the row first, then jumps to it", async () => {
    const container = await theReaderWithAGroup()

    await click(tab(container, "Runs"))
    expect(container.querySelector("tbody tr .cell-path")).toBeNull()

    await click(lineSaying(container, "Feed cache MISS"))

    expect(tab(container, "All").getAttribute("aria-selected")).toBe("true")
    expect(jumps.map((element) => element.querySelector(".cell-path")?.textContent)).toEqual(["/api/v1/feed"])
  })

  test("moves the pin to whichever line is clicked next", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/api/v1/feed"),
      run.log("req-1", "Feed cache MISS"),
      run.start("req-2", "GET", "/api/v1/me"),
      run.log("req-2", "Authenticated user 4021"),
    )

    await click(lineSaying(container, "Feed cache MISS"))
    await click(lineSaying(container, "Authenticated user 4021"))

    expect(lineSaying(container, "Feed cache MISS").className).not.toContain("console-line-pinned")
    expect(container.querySelector("tbody tr.activity-row-pinned .cell-path")?.textContent).toBe("/api/v1/me")
  })

  test("keeps the pin off the Activity table's own clicks, which say nothing about the Console", async () => {
    const container = await theReaderWithAGroup()

    await click(lineSaying(container, "Feed cache MISS"))
    const row = container.querySelector("tbody tr.activity-row-run")
    await click(row!)

    expect(container.querySelector(".console-line-pinned")).toBeNull()
    expect(rule(container)).toBeNull()
  })
})

/**
 * #63: a Console line's lifetime is exactly its owning row's, borrowed from the *Memory
 * bound* rather than a second, independently-counted ring. `theReader` above already wires
 * `stream.evict` the way `useSidecar` does, so this is the same seam every other test in this
 * file uses — just enough traffic past the row this one cares about to push it out.
 */
describe("Console retention under the Memory bound", () => {
  test("removes a line the instant the row it belongs to is evicted", async () => {
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

    const container = await theReader(...doomed, ...filler)

    expect(lines(container).some((line) => line.textContent?.includes("the doomed log line"))).toBe(false)
  })

  test("leaves a line alone while its row is still held, rendering exactly as before", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.log("req-1", "Feed cache MISS"),
      run.finish("req-1"),
    )

    expect(messages(container)).toEqual(["Feed cache MISS"])
  })
})
