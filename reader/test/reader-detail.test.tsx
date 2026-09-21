import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC } from "./traffic.fixtures"
import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"
import type { Envelope } from "../src/shared/wire"
import type { RunIdentity } from "../src/shared/run-identity"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")
const { activityTable } = await import("../src/shared/activity")
const { latchRunIdentity } = await import("../src/shared/run-identity")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * Unmounted rather than just emptied: an in-flight row's elapsed pill holds an interval for
 * as long as it is mounted, and a root left behind goes on ticking into the next test.
 */
const mounted: { unmount: () => void }[] = []

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount()
  })
  document.body.innerHTML = ""
  // The schema chip persists by design, which between tests is one test writing another's
  // filter.
  localStorage.clear()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/**
 * Seam 2, reached the way a developer reaches it: the Reader is mounted over a seeded fold
 * and a row is *clicked*. Nothing here reads the detail column without selecting one first,
 * because "which row is showing" is the only thing the column is about.
 *
 * `railsRoot` is computed the same way `main.tsx` computes it — `latchRunIdentity` over the
 * same envelopes, read off the raw stream rather than off any row — so this helper stays
 * the same seam the browser actually reaches `Reader` through.
 */
async function theReader(...envelopes: Parameters<ReturnType<typeof activityTable>["fold"]>[0]) {
  const { container } = await theReaderReceiving(envelopes)
  return container
}

/**
 * The same seam as `theReader`, as more than one batch: what `useSidecar` calls `activity.fold`
 * and `latchRunIdentity` with separately per `EventSource` message, rather than once. Needed
 * wherever a test cares about the *order* batches arrive in — the *Memory bound* only evicts
 * at the end of a batch, so evicting a row and then having its Run reopen one needs two.
 */
async function theReaderReceiving(...batches: (readonly Envelope[])[]) {
  const activity = activityTable()
  let identity: RunIdentity = null
  for (const batch of batches) {
    activity.fold(batch)
    identity = latchRunIdentity(identity, batch)
  }

  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => {
    const root = createRoot(container)
    mounted.push(root)
    root.render(<Reader rows={activity.rows} railsRoot={identity?.railsRoot ?? null} />)
  })
  return { container, rows: activity.rows, identity }
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

  // #50: one lookup, so the Detail heading's method can never drift from the Activity
  // table's — a DELETE reads the same colour class wherever it renders.
  test("colours its method the same class the Activity table's method cell carries", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "DELETE", "/posts/12"),
      run.route("req-1", "PostsController", "destroy"),
    )

    const row = await select(container, "/posts/12")

    expect(row.querySelector(".cell-method")?.className).toBe("cell-method method-delete")
    expect(detail(container).querySelector(".detail-method")?.className).toBe("detail-method method-delete")
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

  test("shows a query once, not beside the lines Rails logged it as, with its callsite under it", async () => {
    const statement = `SELECT "posts".* FROM "posts" WHERE "posts"."id" = 12 LIMIT 1 /*action='show'*/`
    const callsite = "app/controllers/posts_controller.rb:9:in 'PostsController#show'"
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", statement, { name: "Post Load", callsite }),
      run.log("req-1", `  Post Load (0.2ms)  ${statement}`, { severity: "debug", source: "rails" }),
      run.log("req-1", `  \u21b3 ${callsite}`, { severity: "debug", source: "rails" }),
      run.finish("req-1"),
    )

    await select(container, "/posts/12")

    // The highlighted, bind-carrying event with its callsite — and not Rails' rounded,
    // unhighlighted rendering of the query, nor its loose line naming the same callsite.
    expect(timeline(container)).toEqual([statement])
    expect(entries(container, ".entry-sql .sql-callsite").map((line) => line.textContent)).toEqual([
      `\u21b3 ${callsite}`,
    ])
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

  test("shows its callsite as emitted, whether or not Rails printed a line for it", async () => {
    const callsite = "app/views/posts/index.html.erb:11:in 'block in _app_views_posts_index_html_erb'"
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/posts"), run.sql("req-1", QUERY_LOGS, { callsite }))

    await select(container, "/posts")

    expect((await theQuery(container)).querySelector(".sql-callsite")?.textContent).toBe(`\u21b3 ${callsite}`)
  })

  test("shows no callsite line for a query that carries none", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1", QUERY_LOGS))

    await select(container, "/posts/12")

    expect((await theQuery(container)).querySelector(".sql-callsite")).toBeNull()
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
 * #54: `development.log` never shows a SCHEMA or EXPLAIN query — Rails' own log subscriber
 * drops them by name before a line is ever written — so the Detail column hides them the same
 * way on open, with one chip to bring them back for the reload-diagnosis case they exist for.
 */
describe("the schema chip", () => {
  async function click(element: Element) {
    await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  }

  function chip(container: HTMLElement) {
    const found = [...container.querySelectorAll("[aria-label='Filter by query kind'] button")].find(
      (candidate) => candidate.textContent === "schema",
    )
    if (found === undefined) throw new Error("no schema chip")
    return found
  }

  test("hides SCHEMA and EXPLAIN queries on open, among a request's ordinary ones", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT sql FROM sqlite_master", { name: "SCHEMA" }),
      run.sql("req-1", "EXPLAIN SELECT 1", { name: "EXPLAIN" }),
      run.sql("req-1", "SELECT 1", { name: "Post Load" }),
    )

    await select(container, "/posts/12")

    expect(timeline(container)).toEqual(["SELECT 1"])
    expect(chip(container).getAttribute("aria-pressed")).toBe("false")
  })

  test("hides a hidden query's callsite along with it", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT sql FROM sqlite_master", { name: "SCHEMA", callsite: "app/models/post.rb:3:in '<class:Post>'" }),
      run.sql("req-1", "SELECT 1", { name: "Post Load" }),
    )

    await select(container, "/posts/12")

    expect(entries(container, ".sql-callsite")).toHaveLength(0)
  })

  test("brings them back, interleaved where they were emitted, once the chip is on", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT sql FROM sqlite_master", { name: "SCHEMA" }),
      run.sql("req-1", "SELECT 1", { name: "Post Load" }),
    )

    await select(container, "/posts/12")
    await click(chip(container))

    expect(timeline(container)).toEqual(["SELECT sql FROM sqlite_master", "SELECT 1"])
    expect(chip(container).getAttribute("aria-pressed")).toBe("true")
  })

  test("leaves a query named anything else alone", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1", { name: "Post Load" }),
      run.sql("req-1", "PRAGMA foreign_keys", { name: null }),
    )

    await select(container, "/posts/12")

    expect(timeline(container)).toEqual(["SELECT 1", "PRAGMA foreign_keys"])
  })

  test("hides an all-SCHEMA trailing section rather than leaving it empty", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.finish("req-1"),
      run.sql("req-1", "SELECT sql FROM sqlite_master", { name: "SCHEMA" }),
    )

    await select(container, "/posts/12")

    expect(detail(container).querySelector('[aria-label="After the request finished"]')).toBeNull()
  })

  test("persists the choice, like the Console's chips", async () => {
    const run = aRun("srv-1")
    const envelopes = [
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT sql FROM sqlite_master", { name: "SCHEMA" }),
    ] as const

    const first = await theReader(...envelopes)
    await select(first, "/posts/12")
    await click(chip(first))

    act(() => {
      for (const root of mounted.splice(0)) root.unmount()
    })
    document.body.innerHTML = ""

    const second = await theReader(...envelopes)
    await select(second, "/posts/12")

    expect(timeline(second)).toEqual(["SELECT sql FROM sqlite_master"])
    expect(chip(second).getAttribute("aria-pressed")).toBe("true")
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

  test("shows its exception message and the raised frame, gem frames collapsed", async () => {
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
    // The raise site always renders; the two gem frames behind it collapse into one marker.
    expect([...(exception?.querySelectorAll(".backtrace li") ?? [])].map((frame) => frame.textContent)).toEqual([
      "app/models/order.rb:44:in `block in recalculate_total!'",
      "2 frames hidden",
    ])
  })

  test("leaves a request that did not raise without an exception block", async () => {
    const run = aRun("srv-1")
    const container = await theReader(run.start("req-1", "GET", "/posts/12"), run.finish("req-1"))

    await select(container, "/posts/12")

    expect(detail(container).querySelector(".exception")).toBeNull()
  })
})

describe("highlighting a Host-app backtrace frame", () => {
  const RAILS_ROOT = "/home/dev/example-app"
  const HOST_FRAME = `${RAILS_ROOT}/app/models/order.rb:44:in \`block in recalculate_total!'`
  const GEM_FRAME = "puma (6.6.0) lib/puma/server.rb:443:in `process_client'"

  function frameElements(container: HTMLElement) {
    return [...(detail(container).querySelectorAll(".backtrace li") ?? [])]
  }

  async function revealGaps(container: HTMLElement) {
    for (const button of [...detail(container).querySelectorAll(".backtrace-reveal")]) {
      await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    }
  }

  test("gives only the frame under rails_root the full-contrast colour, style only", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.header(),
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [HOST_FRAME, GEM_FRAME] },
      }),
    )

    await select(container, "/orders")
    await revealGaps(container)
    const frames = frameElements(container)

    expect(frames.map((frame) => frame.textContent)).toEqual([HOST_FRAME, GEM_FRAME])
    expect(frames[0]?.classList.contains("backtrace-host")).toBe(true)
    expect(frames[1]?.classList.contains("backtrace-host")).toBe(false)
    expect(frames).toHaveLength(2)
  })

  test("leaves every frame unhighlighted when the Run's run_header was never seen", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [HOST_FRAME, GEM_FRAME] },
      }),
    )

    await select(container, "/orders")
    await revealGaps(container)

    expect(frameElements(container).some((frame) => frame.classList.contains("backtrace-host"))).toBe(false)
  })

  test("keeps highlighting frames after the Run row that first proved rails_root is evicted and reopens", async () => {
    const run = aRun("srv-1")

    // The header lands, proving `rails_root` — then enough other traffic to push the row it
    // opened, the oldest in the table, past the Memory bound and out. The same shape #44's
    // "marks a Run row reopened" test (`activity-table.test.ts`) drives the eviction with.
    const proves = [run.header(), run.sql(null)]
    const filler = Array.from({ length: LOAD_ON_OPEN_EVENTS / 2 + 10 }, (_, index) => [
      run.start(`req-filler-${index}`, "GET", `/posts/${index}`),
      run.finish(`req-filler-${index}`),
    ]).flat()
    // The same Run, saying something unattributed again: a fresh, header-less row opens for
    // it, whose own `railsRoot` is `null` — the fact this test exists to say does not matter.
    const reopens = [run.log(null, "[ActiveJob] [SendDigestJob] Performing")]
    const raises = [
      run.start("req-boom", "POST", "/orders"),
      run.finish("req-boom", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [HOST_FRAME, GEM_FRAME] },
      }),
    ]

    const { container, rows, identity } = await theReaderReceiving(proves, filler, reopens, raises)

    // The eviction and the reopen both happened: nothing here still says `rails_root`.
    const reopened = rows.find((row) => row.kind === "run" && row.runId === "srv-1")
    expect(reopened).toBeDefined()
    expect(reopened?.railsRoot).toBeNull()
    const boom = rows.find((row) => row.kind === "request" && row.path === "/orders")
    expect(boom).toBeDefined()
    expect(boom?.railsRoot).toBeNull()

    // `RunIdentity` never lost it, and highlighting reads off that rather than off either row.
    expect(identity?.railsRoot).toBe(RAILS_ROOT)
    await select(container, "/orders")
    const frames = frameElements(container)
    expect(frames[0]?.classList.contains("backtrace-host")).toBe(true)
  })
})

/**
 * Everything outside `isHostFrame` collapses to inline markers by default — the raised
 * frame and any Host-app frame render uncollapsed, in their real stack position.
 */
describe("collapsing gem frames in a backtrace", () => {
  const RAILS_ROOT = "/home/dev/example-app"
  const RAISED = "puma (6.6.0) lib/puma/server.rb:443:in `process_client'"
  const HOST_FRAME = `${RAILS_ROOT}/app/models/order.rb:44:in \`block in recalculate_total!'`
  const GEM_BEFORE = "actionpack (8.0.2) lib/action_controller/metal/rescue.rb:23:in `process_action'"
  const GEM_AFTER = "rack (3.1.8) lib/rack/urlmap.rb:74:in `call'"

  function backtraceItems(container: HTMLElement) {
    return [...detail(container).querySelectorAll(".backtrace > li")].map((item) => item.textContent)
  }

  async function reveal(marker: Element) {
    await act(async () => marker.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  }

  test("renders the raised frame even when it is itself outside rails_root", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.header(),
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, HOST_FRAME] },
      }),
    )

    await select(container, "/orders")

    // The raise site is not folded into the marker's count, even though it fails
    // `isHostFrame` the same as any other gem frame would.
    expect(backtraceItems(container)).toEqual([RAISED, HOST_FRAME])
  })

  test("keeps a Host-app frame visible in its real stack position, gaps either side of it", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.header(),
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, GEM_BEFORE, HOST_FRAME, GEM_AFTER] },
      }),
    )

    await select(container, "/orders")

    expect(backtraceItems(container)).toEqual([RAISED, "1 frame hidden", HOST_FRAME, "1 frame hidden"])
  })

  test("collapses a trace with no Host-app frame to one marker spanning everything but the raised frame", async () => {
    const run = aRun("srv-1")
    // No run.header(): railsRoot stays null, so nothing can ever be a Host-app frame.
    const container = await theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, GEM_BEFORE, GEM_AFTER] },
      }),
    )

    await select(container, "/orders")
    const exception = detail(container).querySelector(".exception")

    // The class and message stay visible above the single marker either way.
    expect(exception?.querySelector(".exception-class")?.textContent).toBe("NoMethodError")
    expect(backtraceItems(container)).toEqual([RAISED, "2 frames hidden"])
  })

  test("reveals a marker's frames for good, with no control to re-collapse it", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, GEM_BEFORE, GEM_AFTER] },
      }),
    )

    await select(container, "/orders")
    const marker = detail(container).querySelector(".backtrace-reveal")
    if (marker === null) throw new Error("no marker to reveal")
    await reveal(marker)

    expect(backtraceItems(container)).toEqual([RAISED, GEM_BEFORE, GEM_AFTER])
    expect(detail(container).querySelector(".backtrace-reveal")).toBeNull()
  })

  test("starts fully collapsed again on the next fresh render, once Selection moves away and back", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, GEM_BEFORE, GEM_AFTER] },
      }),
      run.start("req-2", "GET", "/posts/12"),
    )

    await select(container, "/orders")
    const marker = detail(container).querySelector(".backtrace-reveal")
    if (marker === null) throw new Error("no marker to reveal")
    await reveal(marker)
    expect(backtraceItems(container)).toEqual([RAISED, GEM_BEFORE, GEM_AFTER])

    await select(container, "/posts/12")
    await select(container, "/orders")

    expect(backtraceItems(container)).toEqual([RAISED, "2 frames hidden"])
  })

  test("leaves the wire's own Cut note alone — collapsing and truncation never reference each other", async () => {
    const run = aRun("srv-1")
    const finish = run.finish("req-1", {
      status: 500,
      exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, GEM_BEFORE, GEM_AFTER] },
    })
    const container = await theReader(run.start("req-1", "POST", "/orders"), { ...finish, truncated: { backtrace: 300_000 } })

    await select(container, "/orders")

    expect(backtraceItems(container)).toEqual([RAISED, "2 frames hidden"])
    expect(detail(container).querySelector(".exception .cut")?.textContent).toContain("backtrace was cut")
  })

  test("copies every frame regardless of what is still collapsed on screen", async () => {
    const run = aRun("srv-1")
    const backtrace = [RAISED, GEM_BEFORE, GEM_AFTER]
    const container = await theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", { status: 500, exception: { class: "NoMethodError", message: "boom", backtrace } }),
    )

    await select(container, "/orders")
    // Nothing revealed — the marker is still on screen — yet the copy is the whole trace.
    expect(detail(container).querySelector(".backtrace-reveal")).not.toBeNull()
    const button = detail(container).querySelector(".exception .copy-button")
    if (button === null) throw new Error("no copy control")
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })))

    expect(await navigator.clipboard.readText()).toBe(["NoMethodError: boom", ...backtrace].join("\n"))
  })
})

/**
 * A clean plain-text reconstruction, meant for pasting into a bug tracker, a colleague's
 * chat, or an AI assistant — never the block's own markup, and never silent about the paste
 * having happened.
 */
describe("copying an exception", () => {
  async function click(element: Element) {
    await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  }

  function copyButton(container: HTMLElement, scope = ".exception") {
    const found = detail(container).querySelector(`${scope} .copy-button`)
    if (found === null) throw new Error("no copy control")
    return found
  }

  test("appears in the Exception block and nowhere else", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "POST", "/orders"),
      run.sql("req-1", "SELECT 1"),
      run.log("req-1", "about to raise"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "RuntimeError", message: "boom", backtrace: ["order.rb:1"] },
      }),
    )

    await select(container, "/orders")

    expect(detail(container).querySelectorAll(".exception .copy-button")).toHaveLength(1)
    // SQL queries and App log lines are easy enough to select-and-copy by hand.
    expect(detail(container).querySelector(".entry-sql .copy-button")).toBeNull()
    expect(detail(container).querySelector(".entry-log .copy-button")).toBeNull()
  })

  test("copies the class and message, then one backtrace frame per line, no UI chrome", async () => {
    const run = aRun("srv-1")
    const backtrace = ["app/models/order.rb:44:in `block in recalculate_total!'", "puma (6.6.0) lib/puma/server.rb:443"]
    const container = await theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "undefined method `price_cents' for nil", backtrace },
      }),
    )

    await select(container, "/orders")
    await click(copyButton(container))

    expect(await navigator.clipboard.readText()).toBe(
      ["NoMethodError: undefined method `price_cents' for nil", ...backtrace].join("\n"),
    )
  })

  test("ends the copied text with the same cut wording the on-screen note gives", async () => {
    const run = aRun("srv-1")
    const finish = run.finish("req-1", {
      status: 500,
      exception: { class: "NoMethodError", message: "boom", backtrace: ["app/models/order.rb:44"] },
    })
    const container = await theReader(run.start("req-1", "POST", "/orders"), { ...finish, truncated: { backtrace: 300_000 } })

    await select(container, "/orders")
    const note = detail(container).querySelector(".exception .cut")?.textContent
    await click(copyButton(container))

    expect(note).not.toBeUndefined()
    expect(await navigator.clipboard.readText()).toBe(
      `NoMethodError: boom\napp/models/order.rb:44\n# ${note}`,
    )
  })

  test("gives a visible confirmation after a successful copy, rather than copying silently", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", { status: 500, exception: { class: "RuntimeError", message: "boom", backtrace: [] } }),
    )

    await select(container, "/orders")
    const button = copyButton(container)
    expect(button.textContent).not.toContain("Copied")

    await click(button)

    expect(copyButton(container).textContent).toContain("Copied")
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

/**
 * A *Run row* selects like any other row, and opens the same timeline: everything that Run
 * emitted with no owning request. The division of labour with the Console is the glossary's
 * — the Console is where you read *when* something happened, and this is where you read
 * *what*.
 */
describe("selecting a Run row", () => {
  async function selectTheRunRow(container: HTMLElement) {
    const row = container.querySelector("tbody tr.activity-row-run")
    if (row === null) throw new Error("the Activity table has no Run row")

    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  }

  test("opens what its Run emitted with no owning request", async () => {
    const run = aRun("rake-1")
    const container = await theReader(
      run.header("rake", 91_887),
      run.log(null, "reports:rebuild — 41,209 orders to process"),
      run.sql(null, 'SELECT COUNT(*) FROM "orders"'),
    )

    await selectTheRunRow(container)

    expect(detail(container).textContent).toContain("rake")
    expect(detail(container).textContent).toContain("pid 91887")
    expect(timeline(container)).toEqual([
      "reports:rebuild — 41,209 orders to process",
      'SELECT COUNT(*) FROM "orders"',
    ])
  })

  test("keeps the requests of the same Run out of it", async () => {
    const run = aRun("srv-1")
    const container = await theReader(
      run.header(),
      run.log(null, "=> Booting Puma"),
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1"),
      run.finish("req-1"),
    )

    await selectTheRunRow(container)

    expect(timeline(container)).toEqual(["=> Booting Puma"])
  })
})
