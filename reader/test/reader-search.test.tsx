import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC } from "./traffic.fixtures"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")
const { activityTable } = await import("../src/shared/activity")
const { consoleStream } = await import("../src/shared/console")
const { requestRowId } = await import("../src/shared/activity")
const { rowSelector } = await import("../src/ui/features/activity-table/components/ActivityTable")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { unmount: () => void }[] = []

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount()
  })
  document.body.innerHTML = ""
  localStorage.clear()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/**
 * Seam 2, the search's half: the Reader mounted over both folds seeded from one stream of
 * envelopes, and a term *typed* into the search box — so what is asserted is what lights up
 * on screen, never what a matching function returned.
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

function searchBox(container: HTMLElement) {
  const found = container.querySelector<HTMLInputElement>("input[type='search']")
  if (found === null) throw new Error("the Reader has no search box")
  return found
}

/**
 * Typed the way React hears it: through the native `value` setter, which is what a keystroke
 * goes through, followed by the `input` event a keystroke fires. Setting `.value` directly
 * would be swallowed by React's own tracking of the last value it saw.
 */
async function search(container: HTMLElement, term: string) {
  const box = searchBox(container)
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setValue?.call(box, term)
    box.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

/** Every highlighted stretch inside `region`, as the text it lit. */
function lit(region: Element) {
  return [...region.querySelectorAll("mark.search-match")].map((mark) => mark.textContent)
}

function column(container: HTMLElement, name: string) {
  const region = container.querySelector(`[aria-label="${name}"]`)
  if (region === null) throw new Error(`the Reader has no ${name}`)
  return region
}

/** Found the way the Console finds it, by the fold's own id for the request. */
function requestRow(container: HTMLElement, requestId: string) {
  const found = container.querySelector(rowSelector(requestRowId(requestId)))
  if (found === null) throw new Error(`no row for ${requestId}`)
  return found
}

function cell(container: HTMLElement, requestId: string, named: string) {
  const found = requestRow(container, requestId).querySelector(`.cell-${named}`)
  if (found === null) throw new Error(`the row for ${requestId} has no ${named} cell`)
  return found
}

describe("searching", () => {
  test("lights up a Console line that says the term, whatever case it says it in", async () => {
    const rails = aRun("srv-1")
    const container = await theReader(
      rails.header(),
      rails.start("req-1"),
      rails.log("req-1", "Loaded 3 Posts for the feed"),
      rails.log("req-1", "Cache miss for user 4021"),
    )

    await search(container, "posts")

    expect(lit(column(container, "Console"))).toEqual(["Posts"])
  })

  test("lights up a path and a Controller#action in the Activity table", async () => {
    const rails = aRun("srv-1")
    const container = await theReader(
      rails.header(),
      rails.start("req-1", "GET", "/posts/12"),
      rails.route("req-1", "PostsController", "show"),
      rails.start("req-2", "GET", "/authors/4"),
      rails.route("req-2", "AuthorsController", "show"),
    )

    await search(container, "post")

    expect(lit(cell(container, "req-1", "path"))).toEqual(["post"])
    expect(lit(cell(container, "req-1", "action"))).toEqual(["Post"])
    expect(lit(requestRow(container, "req-2"))).toEqual([])
  })

  test("lights up a match in the SQL text across the highlighter's own tokens, without changing a character", async () => {
    const rails = aRun("srv-1")
    const statement = 'SELECT "posts".* FROM "posts" WHERE "posts"."id" = ? LIMIT ?'
    const container = await theReader(rails.header(), rails.start("req-1"), rails.sql("req-1", statement))

    await click(requestRow(container, "req-1"))
    await search(container, 'POSTS"."ID')

    const sql = column(container, "Detail column").querySelector("code.sql") as Element
    // `"posts"`, `.` and `"id"` are three tokens in three colours, and one match. The match is
    // lit across all three, and each keeps its colour.
    expect(lit(sql).join("")).toBe('posts"."id')
    expect(sql.querySelectorAll(".sql-identifier mark.search-match")).toHaveLength(2)
    expect(sql.textContent).toBe(statement)
  })

  test("lights up a match in a query's callsite", async () => {
    const rails = aRun("srv-1")
    const container = await theReader(
      rails.header(),
      rails.start("req-1"),
      rails.sql("req-1", "SELECT 1", { callsite: "app/controllers/posts_controller.rb:9:in 'PostsController#show'" }),
    )

    await click(requestRow(container, "req-1"))
    await search(container, "posts_controller")

    const callsite = column(container, "Detail column").querySelector(".sql-callsite") as Element
    expect(lit(callsite)).toEqual(["posts_controller"])
  })

  test("lights up a match in a log line's callsite, the ↳ included", async () => {
    const rails = aRun("srv-1")
    const container = await theReader(
      rails.header(),
      rails.start("req-1"),
      rails.log("req-1", "Feed cache MISS", { callsite: "app/controllers/feed_controller.rb:7:in 'FeedController#index'" }),
    )

    await click(requestRow(container, "req-1"))
    await search(container, "\u21b3 app/controllers")

    const callsite = column(container, "Detail column").querySelector(".log-callsite") as Element
    expect(lit(callsite)).toEqual(["\u21b3 ", "app/controllers"])
  })

  test("lights up the timeline's log lines and the heading in the Detail column", async () => {
    const rails = aRun("srv-1")
    const container = await theReader(
      rails.header(),
      rails.start("req-1", "GET", "/feed"),
      rails.route("req-1", "FeedController", "index"),
      rails.log("req-1", "Feed cache MISS for user 4021"),
    )

    await click(requestRow(container, "req-1"))
    await search(container, "feed")

    const detail = column(container, "Detail column")
    expect(lit(detail.querySelector(".detail-heading") as Element)).toEqual(["feed", "Feed"])
    expect(lit(detail.querySelector(".timeline") as Element)).toEqual(["Feed"])
  })

  test("reaches into a collapsed backtrace gap, forcing it open the way it does everywhere else", async () => {
    const rails = aRun("srv-1")
    const container = await theReader(
      rails.header(),
      rails.start("req-1", "POST", "/orders"),
      rails.finish("req-1", {
        status: 500,
        exception: {
          class: "NoMethodError",
          message: "boom",
          backtrace: [
            "app/models/order.rb:44:in `block in recalculate_total!'",
            "puma (6.6.0) lib/puma/server.rb:443:in `process_client'",
          ],
        },
      }),
    )

    await click(requestRow(container, "req-1"))
    const detail = column(container, "Detail column")
    // Collapsed on open: the term below lives inside the marker, not on screen yet.
    expect(detail.querySelector(".backtrace-reveal")).not.toBeNull()

    await search(container, "puma")

    expect(detail.querySelector(".backtrace-reveal")).toBeNull()
    // The frame says "puma" twice — once naming the gem, once in its own path.
    expect(lit(detail.querySelector(".backtrace") as Element)).toEqual(["puma", "puma"])
  })

  test("hides nothing: every row and every line is still there, matching or not", async () => {
    const container = await theReader(...DENSE_TRAFFIC)
    const before = {
      rows: container.querySelectorAll(".activity-row").length,
      lines: container.querySelectorAll(".console-line").length,
    }

    // A term only a handful of rows and lines say, over the busy seed.
    await search(container, "feed")

    expect(container.querySelectorAll("mark.search-match").length).toBeGreaterThan(0)
    expect(container.querySelectorAll(".activity-row")).toHaveLength(before.rows)
    expect(container.querySelectorAll(".console-line")).toHaveLength(before.lines)
  })

  test("hides nothing even when nothing matches", async () => {
    const container = await theReader(...DENSE_TRAFFIC)
    const rows = container.querySelectorAll(".activity-row").length

    await search(container, "nothing in the log says this")

    expect(container.querySelectorAll("mark.search-match")).toHaveLength(0)
    expect(container.querySelectorAll(".activity-row")).toHaveLength(rows)
  })

  test("takes the term literally — what would be a regex is only the characters typed", async () => {
    const rails = aRun("srv-1")
    const container = await theReader(
      rails.header(),
      rails.start("req-1", "GET", "/search?q=a.b"),
      rails.start("req-2", "GET", "/search?q=axb"),
    )

    await search(container, "a.b")

    expect(lit(cell(container, "req-1", "path"))).toEqual(["a.b"])
    expect(lit(cell(container, "req-2", "path"))).toEqual([])
  })

  test("lights every occurrence, not only the first", async () => {
    const rails = aRun("srv-1")
    const container = await theReader(rails.header(), rails.start("req-1", "GET", "/posts/12/posts"))

    await search(container, "posts")

    expect(lit(cell(container, "req-1", "path"))).toEqual(["posts", "posts"])
  })

  test("puts every mark out again when the box is emptied", async () => {
    const rails = aRun("srv-1")
    const container = await theReader(rails.header(), rails.start("req-1", "GET", "/posts/12"))

    await search(container, "posts")
    await search(container, "")

    expect(container.querySelectorAll("mark.search-match")).toHaveLength(0)
    expect(cell(container, "req-1", "path").textContent).toBe("/posts/12")
  })
})
