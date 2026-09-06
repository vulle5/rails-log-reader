import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC } from "./traffic.fixtures"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")
const { activityTable } = await import("../src/shared/activity")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ""
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/**
 * Seam 2, reached the way a developer reaches it: the Reader is mounted over a seeded fold
 * and a row is *clicked*. Nothing here reads the detail column without selecting one first,
 * because "which row is showing" is the only thing the column is about.
 */
async function theReader(...envelopes: Parameters<ReturnType<typeof activityTable>["fold"]>[0]) {
  const activity = activityTable()
  activity.fold(envelopes)

  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => createRoot(container).render(<Reader rows={activity.rows} />))
  return container
}

function detail(container: HTMLElement) {
  const body = container.querySelector('[aria-label="Detail column"] .column-body')
  if (body === null) throw new Error("the Reader has no Detail column")
  return body
}

async function select(container: HTMLElement, path: string) {
  const row = [...container.querySelectorAll("tbody tr")].find(
    (candidate) => candidate.querySelector(".cell-path")?.textContent === path,
  )
  if (row === undefined) throw new Error(`no row for ${path}`)

  await act(async () => {
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  return row
}

/**
 * Every entry of the request's own timeline as one string: the query it ran, or the line it
 * printed. Scoped to the timeline hanging directly off the detail — the trailing section
 * renders a timeline of its own, and the whole point of it is that it is not this one.
 */
function timeline(container: HTMLElement) {
  return [...detail(container).querySelectorAll(".detail > .timeline > .entry")].map((entry) =>
    entry.querySelector(".sql")?.textContent ?? entry.querySelector(".log-message")?.textContent,
  )
}

function entries(container: HTMLElement, selector: string) {
  return [...detail(container).querySelectorAll(selector)]
}

describe("selecting a row", () => {
  test("holds the column open on a placeholder until something is selected", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1"))

    expect(detail(container).textContent).toContain("Nothing selected")
  })

  test("fills the column that was already there, rather than opening one", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1"))
    const before = detail(container)

    await select(container, "/posts/12")

    // The same element, still the third column: selecting changed what it holds and nothing
    // about the layout around it.
    expect(detail(container)).toBe(before)
    expect(detail(container).textContent).not.toContain("Nothing selected")
  })

  test("marks the row that is showing, and moves the mark on the next click", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/first"), run.start("req-2", "GET", "/second"))

    const first = await select(container, "/first")
    expect(first.getAttribute("aria-selected")).toBe("true")

    const second = await select(container, "/second")
    expect(second.getAttribute("aria-selected")).toBe("true")
    expect(first.getAttribute("aria-selected")).toBe("false")
  })

  test("names the request it is showing, so the column can be read on its own", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.route("req-1", "PostsController", "show"),
    )

    await select(container, "/posts/12")

    expect(detail(container).querySelector(".detail-heading")?.textContent).toContain("/posts/12")
    expect(detail(container).querySelector(".detail-heading")?.textContent).toContain("Posts#show")
  })
})

describe("the timeline", () => {
  test("interleaves SQL and App log events in the order they were emitted", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/feed"),
      run.sql("req-1", "SELECT 1"),
      run.log("req-1", "Feed cache MISS"),
      run.sql("req-1", "SELECT 2"),
      run.log("req-1", "Feed cache WRITE"),
      run.finish("req-1"),
    )

    await select(container, "/feed")

    expect(timeline(container)).toEqual(["SELECT 1", "Feed cache MISS", "SELECT 2", "Feed cache WRITE"])
  })

  test("shows an App log event's severity and keeps a Rails line labelled apart", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/feed"),
      run.log("req-1", "N+1 suspected", { severity: "warn" }),
      run.log("req-1", "Rendering feed/index.html.erb", { source: "rails" }),
    )

    await select(container, "/feed")

    expect(entries(container, ".entry-log")[0]?.querySelector(".log-severity")?.textContent).toBe("warn")
    expect(entries(container, ".entry-log")[1]?.className).toContain("log-from-rails")
  })

  test("shows a log event's tags, for the team that invested most in logging", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/feed"),
      run.log("req-1", "Performing DeliverWebhookJob", { tags: ["ActiveJob", "9f2c1a"] }),
    )

    await select(container, "/feed")

    expect(entries(container, ".log-tag").map((tag) => tag.textContent)).toEqual(["ActiveJob", "9f2c1a"])
  })
})

describe("a query", () => {
  const QUERY_LOGS = `SELECT "posts".* FROM "posts" WHERE "posts"."id" = ? /*action='show',controller='posts'*/`

  async function theQuery(container: HTMLElement) {
    const entry = entries(container, ".entry-sql")[0]
    if (entry === undefined) throw new Error("the detail column rendered no query")
    return entry
  }

  test("renders exactly as emitted, QueryLogs comment intact and nothing reformatted", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1", QUERY_LOGS))

    await select(container, "/posts/12")

    // What is read is what pastes into a console: the highlighting added spans, not text.
    expect((await theQuery(container)).querySelector(".sql")?.textContent).toBe(QUERY_LOGS)
  })

  test("is highlighted by the tokenizer, keyword and comment apart", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1", QUERY_LOGS))

    await select(container, "/posts/12")
    const sql = (await theQuery(container)).querySelector(".sql")

    expect([...(sql?.querySelectorAll(".sql-keyword") ?? [])].map((span) => span.textContent)).toEqual([
      "SELECT",
      "FROM",
      "WHERE",
    ])
    expect(sql?.querySelector(".sql-comment")?.textContent).toBe("/*action='show',controller='posts'*/")
  })

  test("shows its name and how long it took", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1", { name: "Post Load", duration_ms: 4.1 }),
    )

    await select(container, "/posts/12")
    const query = await theQuery(container)

    expect(query.querySelector(".sql-name")?.textContent).toBe("Post Load")
    expect(query.querySelector(".sql-duration")?.textContent).toBe("4.1ms")
  })

  test("marks a query the query cache answered, the way development.log does", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1", { cached: true }),
    )

    await select(container, "/posts/12")

    expect((await theQuery(container)).textContent).toContain("CACHE")
  })

  test("renders its binds as chips labelled as this query's parameter values", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1", { binds: [4021, "rails logs", null, true] }),
    )

    await select(container, "/posts/12")
    const binds = (await theQuery(container)).querySelector(".binds")

    // Never "sent to the database": trilogy never parameterizes a query at the wire level,
    // so that phrasing would be false there specifically — and the caption is on screen,
    // because the reading it corrects is the one a developer arrives with.
    expect(binds?.getAttribute("aria-label")).toBe("This query's parameter values")
    expect(binds?.querySelector(".binds-label")?.textContent).toBe("parameter values")
    expect([...(binds?.querySelectorAll(".bind") ?? [])].map((chip) => chip.textContent)).toEqual([
      "4021",
      "rails logs",
      "NULL",
      "true",
    ])
  })

  test("renders an empty bind list as simply no chips, not as an empty container", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1", { binds: [] }),
    )

    await select(container, "/posts/12")

    expect((await theQuery(container)).querySelector(".binds")).toBeNull()
  })

  /** `connection.execute` skips Rails' query-building layer: `name` is a genuine `nil`. */
  test("renders a raw execute — no model, no binds, a nil name — as a plain ordinary row", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "PRAGMA foreign_keys", { name: null, binds: [], row_count: undefined }),
    )

    await select(container, "/posts/12")
    const query = await theQuery(container)

    expect(query.querySelector(".sql")?.textContent).toBe("PRAGMA foreign_keys")
    expect(query.querySelector(".sql-name")).toBeNull()
    expect(query.querySelector(".sql-duration")?.textContent).toBe("0.4ms")
  })
})

/**
 * The wire cuts a field at its per-field cap and records the original size. Whatever is cut
 * has to say so where it is read: the column's whole promise is that what is on screen is
 * what was emitted, and a statement quietly missing its tail breaks it silently.
 */
describe("a field the Sidecar had to cut", () => {
  test("says so under the query, with what was emitted", async () => {
    const run = aRun("srv-1")
    const start = run.start("req-1", "GET", "/posts/12")
    const query = run.sql("req-1", "SELECT * FROM posts WHERE id IN (1, 2, 3")
    const container = await theReader(start, { ...query, truncated: { sql: 812_400 } })

    await select(container, "/posts/12")

    expect(detail(container).querySelector(".cut")?.textContent).toBe("sql was cut by the Sidecar — 793 KB was emitted")
  })

  test("says so under a backtrace, because uncleaned is a promise only the file can break", async () => {
    const run = aRun("srv-1")
    const finish = run.finish("req-1", {
      status: 500,
      exception: { class: "NoMethodError", message: "boom", backtrace: ["app/models/order.rb:44"] },
    })
    const container = await theReader(run.start("req-1", "POST", "/orders"), {
      ...finish,
      truncated: { backtrace: 300_000 },
    })

    await select(container, "/orders")

    expect(detail(container).querySelector(".exception .cut")?.textContent).toContain("backtrace was cut")
  })

  test("says nothing at all about a query that arrived whole", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1"))

    await select(container, "/posts/12")

    expect(detail(container).querySelector(".cut")).toBeNull()
  })
})

describe("what arrived after the request finished", () => {
  async function aTrailingEvent() {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1"),
      run.finish("req-1"),
      run.log("req-1", "Executor#to_complete ran after the body closed"),
    )
    await select(container, "/posts/12")
    return container
  }

  test("is shown in a section of its own, never silently inside the timeline", async () => {
    const container = await aTrailingEvent()

    expect(timeline(container)).toEqual(["SELECT 1"])
    const trailing = detail(container).querySelector('[aria-label="After the request finished"]')
    expect(trailing?.textContent).toContain("Executor#to_complete ran after the body closed")
  })

  test("leaves an ordinary request no such section at all", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1"), run.finish("req-1"))

    await select(container, "/posts/12")

    expect(detail(container).querySelector('[aria-label="After the request finished"]')).toBeNull()
  })
})

describe("a request that raised", () => {
  const BACKTRACE = [
    "app/models/order.rb:44:in `block in recalculate_total!'",
    "actionpack (8.0.2) lib/action_controller/metal/rescue.rb:23:in `process_action'",
    "puma (6.6.0) lib/puma/server.rb:443:in `process_client'",
  ]

  test("shows its exception with the backtrace full and uncleaned", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "undefined method `price_cents' for nil", backtrace: BACKTRACE },
      }),
    )

    await select(container, "/orders")
    const exception = detail(container).querySelector(".exception")

    expect(exception?.textContent).toContain("NoMethodError")
    expect(exception?.textContent).toContain("undefined method `price_cents' for nil")
    // Every frame, gems included: "the bug was in a gem" stays an answer the Reader can give.
    expect([...(exception?.querySelectorAll(".backtrace li") ?? [])].map((frame) => frame.textContent)).toEqual(
      BACKTRACE,
    )
  })

  test("leaves a request that did not raise without an exception block", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/posts/12"), run.finish("req-1"))

    await select(container, "/posts/12")

    expect(detail(container).querySelector(".exception")).toBeNull()
  })
})

/**
 * The whole point of the column, over the dense seed rather than a crafted pair: the shape
 * has to be visible in the middle of a real request's traffic, not on its own.
 */
describe("the N+1-shaped request in a busy dev app's Sidecar", () => {
  test("reads as a run of near-identical queries, differing only in their bind", async () => {
    const container = await theReader(...DENSE_TRAFFIC)

    await select(container, "/api/v1/feed?page=1")
    const queries = entries(container, ".entry-sql")
    const authorLoads = queries.filter((entry) => entry.querySelector(".sql-name")?.textContent === "Author Load")

    expect(queries).toHaveLength(24)
    expect(authorLoads).toHaveLength(20)
    // Twenty rows the eye can see are the same, and one chip per row that is not — which is
    // what makes the shape obvious without the Reader claiming to have detected anything.
    expect(new Set(authorLoads.map((entry) => entry.querySelector(".sql")?.textContent)).size).toBe(1)
    expect(new Set(authorLoads.map((entry) => entry.querySelector(".bind")?.textContent)).size).toBe(20)
  })

  test("keeps the four logger calls in among them, where they were emitted", async () => {
    const container = await theReader(...DENSE_TRAFFIC)

    await select(container, "/api/v1/feed?page=1")
    const kinds = [...detail(container).querySelectorAll(".detail > .timeline > .entry")].map((entry) =>
      entry.className.includes("entry-sql") ? "sql" : "log",
    )

    expect(kinds).toHaveLength(28)
    // Not a slab of queries with the logger calls above or below them.
    expect(kinds.indexOf("log")).toBeGreaterThan(0)
    expect(kinds.lastIndexOf("sql")).toBeGreaterThan(kinds.lastIndexOf("log"))
  })
})
