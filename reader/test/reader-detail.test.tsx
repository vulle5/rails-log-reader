import { afterEach, describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC } from "./traffic.fixtures"
import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"
import type { Envelope } from "../src/shared/wire"
import {
  cellUnder,
  chip,
  column,
  folded,
  isQuery,
  itemsOf,
  openTheReaderOver,
  rowShowing,
  select,
  timeline,
  wholeText,
} from "./reader.harness"

afterEach(() => {
  // The schema chip persists by design, which between tests is one test writing another's
  // filter.
  localStorage.clear()
})

/**
 * Seam 2, reached the way a developer reaches it: the Reader is mounted over a seeded fold
 * and a row is *clicked*. Nothing here reads the detail column without selecting one first,
 * because "which row is showing" is the only thing the column is about.
 *
 * `railsRoot` is computed the same way `main.tsx` computes it — `latchRunIdentity` over the
 * same envelopes, read off the raw stream rather than off any row — so this stays the same
 * seam the browser actually reaches `Reader` through.
 */
function theReader(...envelopes: Envelope[]) {
  return theReaderReceiving(envelopes)
}

/**
 * The same seam as `theReader`, as more than one batch: what `useSidecar` calls `activity.fold`
 * and `latchRunIdentity` with separately per `EventSource` message, rather than once. Needed
 * wherever a test cares about the *order* batches arrive in — the *Memory bound* only evicts
 * at the end of a batch, so evicting a row and then having its Run reopen one needs two.
 */
function theReaderReceiving(...batches: (readonly Envelope[])[]) {
  return openTheReaderOver(folded(...batches))
}

function detail() {
  return column("Detail column")
}

/**
 * Every entry of the request's own timeline, each read whole: the query it ran, or the line it
 * printed. Its own list, never the trailing section's — the whole point of that one is that
 * it is not this one.
 */
function timelineSays() {
  return itemsOf(timeline()).map((entry) => within(entry).queryByRole("code")?.textContent ?? entry.textContent)
}

/** A log line's text is its entry's; the entry holds its severity and tags beside it. */
function says(...said: string[]) {
  return said.map((each) => expect.stringContaining(each))
}

function queries() {
  return itemsOf(timeline()).filter(isQuery)
}

function logLines() {
  return itemsOf(timeline()).filter((entry) => !isQuery(entry))
}

/** A Callsite line reads `↳ ` and the raw value, however it is split to be opened. */
function callsiteLines(scope: HTMLElement = detail()) {
  const isCallsite = (element: Element) => element.textContent?.startsWith("↳ ") === true
  return within(scope).queryAllByText(
    (_, element) => element !== null && isCallsite(element) && [...element.children].every((child) => !isCallsite(child)),
  )
}

describe("selecting a row", () => {
  test("holds the column open on a placeholder until something is selected", () => {
    const run = aRun("srv-1")
    theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1"))

    expect(detail()).toHaveTextContent("Nothing selected")
  })

  test("fills the column that was already there, rather than opening one", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1"))
    const before = detail()

    await select(user, "/posts/12")

    // The same element, still the third column: selecting changed what it holds and nothing
    // about the layout around it.
    expect(detail()).toBe(before)
    expect(screen.getAllByRole("region")[2]).toBe(before)
    expect(detail()).not.toHaveTextContent("Nothing selected")
  })

  test("marks the row that is showing, and moves the mark on the next click", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/first"), run.start("req-2", "GET", "/second"))

    const first = await select(user, "/first")
    expect(first).toHaveAttribute("aria-current", "true")

    const second = await select(user, "/second")
    expect(second).toHaveAttribute("aria-current", "true")
    expect(first).not.toHaveAttribute("aria-current")
  })

  test("names the request it is showing, so the column can be read on its own", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts/12"), run.route("req-1", "PostsController", "show"))

    await select(user, "/posts/12")

    const article = within(detail()).getByRole("article")
    expect(within(article).getByText("/posts/12")).toBeInTheDocument()
    expect(within(article).getByText("Posts#show")).toBeInTheDocument()
  })

  // #50: one lookup, so the Detail heading's method can never drift from the Activity
  // table's — a DELETE reads the same colour category wherever it renders.
  test("colours its method the same category the Activity table's method cell carries", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "DELETE", "/posts/12"), run.route("req-1", "PostsController", "destroy"))

    const row = await select(user, "/posts/12")

    expect(within(cellUnder(row, "Method")).getByText("DELETE")).toHaveAttribute("data-method", "delete")
    expect(within(detail()).getByText("DELETE")).toHaveAttribute("data-method", "delete")
  })
})

describe("the timeline", () => {
  test("interleaves SQL and App log events in the order they were emitted", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/feed"),
      run.sql("req-1", "SELECT 1"),
      run.log("req-1", "Feed cache MISS"),
      run.sql("req-1", "SELECT 2"),
      run.log("req-1", "Feed cache WRITE"),
      run.finish("req-1"),
    )

    await select(user, "/feed")

    expect(timelineSays()).toEqual(says("SELECT 1", "Feed cache MISS", "SELECT 2", "Feed cache WRITE"))
    expect(queries().map((entry) => within(entry).getByRole("code").textContent)).toEqual(["SELECT 1", "SELECT 2"])
  })

  test("shows a query once, not beside the lines Rails logged it as, with its callsite under it", async () => {
    const statement = `SELECT "posts".* FROM "posts" WHERE "posts"."id" = 12 LIMIT 1 /*action='show'*/`
    const callsite = "app/controllers/posts_controller.rb:9:in 'PostsController#show'"
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", statement, { name: "Post Load", callsite }),
      run.log("req-1", `  Post Load (0.2ms)  ${statement}`, { severity: "debug", source: "rails" }),
      run.log("req-1", `  \u21b3 ${callsite}`, { severity: "debug", source: "rails" }),
      run.finish("req-1"),
    )

    await select(user, "/posts/12")

    // The highlighted, bind-carrying event with its callsite — and not Rails' rounded,
    // unhighlighted rendering of the query, nor its loose line naming the same callsite.
    expect(timelineSays()).toEqual([statement])
    expect(callsiteLines(queries()[0]).map((line) => line.textContent)).toEqual([`\u21b3 ${callsite}`])
  })

  test("shows an App log event's severity and keeps a Rails line labelled apart", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/feed"),
      run.log("req-1", "N+1 suspected", { severity: "warn" }),
      run.log("req-1", "Rendering feed/index.html.erb", { source: "rails" }),
    )

    await select(user, "/feed")
    const [warning, rails] = logLines()

    expect(within(warning!).getByText("warn")).toBeInTheDocument()
    expect(warning).toHaveAttribute("data-level", "warn")
    expect(rails).toHaveAttribute("data-source", "rails")
  })

  test("shows an app-sourced log event's callsite under its line, as emitted, and a rails-sourced one's not at all", async () => {
    const own = "app/controllers/feed_controller.rb:7:in 'FeedController#index'"
    const gem = "/home/dev/.gem/ruby/3.4.0/gems/actionview-8.0.2/lib/action_view/template.rb:251:in 'block in render'"
    const run = aRun("srv-1")
    const { user } = theReader(
      run.header(),
      run.start("req-1", "GET", "/feed"),
      run.log("req-1", "Feed cache MISS", { callsite: own }),
      run.log("req-1", "Rendered feed/index.html.erb", { source: "rails", callsite: gem }),
    )

    await select(user, "/feed")

    // Raw: never shortened against rails_root.
    expect(callsiteLines().map((line) => line.textContent)).toEqual([`\u21b3 ${own}`])
    expect(callsiteLines(logLines()[0])).toHaveLength(1)
    expect(timelineSays()).toEqual(says("Feed cache MISS", "Rendered feed/index.html.erb"))
  })

  test("shows no callsite line for a log event that carries none", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/feed"), run.log("req-1", "Feed cache MISS"))

    await select(user, "/feed")

    expect(callsiteLines()).toHaveLength(0)
  })

  test("drops an Echo's callsite along with the Echo", async () => {
    const statement = "SELECT 1"
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/feed"),
      run.sql("req-1", statement),
      run.log("req-1", `  Post Load (0.2ms)  ${statement}`, {
        severity: "debug",
        source: "rails",
        callsite: "/home/dev/.gem/activerecord/lib/active_record/log_subscriber.rb:30:in 'sql'",
      }),
    )

    await select(user, "/feed")

    expect(callsiteLines()).toHaveLength(0)
  })

  test("shows a log event's tags, for the team that invested most in logging", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/feed"),
      run.log("req-1", "Performing DeliverWebhookJob", { tags: ["ActiveJob", "9f2c1a"] }),
    )

    await select(user, "/feed")

    const tags = within(logLines()[0]!).getAllByText(/^(ActiveJob|9f2c1a)$/)
    expect(tags.map((tag) => tag.textContent)).toEqual(["ActiveJob", "9f2c1a"])
  })
})

describe("a query", () => {
  const QUERY_LOGS = `SELECT "posts".* FROM "posts" WHERE "posts"."id" = ? /*action='show',controller='posts'*/`

  function theQuery() {
    const entry = queries()[0]
    if (entry === undefined) throw new Error("the detail column rendered no query")
    return entry
  }

  function statement() {
    return within(theQuery()).getByRole("code")
  }

  test("renders exactly as emitted, QueryLogs comment intact and nothing reformatted", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1", QUERY_LOGS))

    await select(user, "/posts/12")

    // What is read is what pastes into a console: the highlighting added spans, not text.
    expect(statement().textContent).toBe(QUERY_LOGS)
  })

  test("shows its callsite as emitted, whether or not Rails printed a line for it", async () => {
    const callsite = "app/views/posts/index.html.erb:11:in 'block in _app_views_posts_index_html_erb'"
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts"), run.sql("req-1", QUERY_LOGS, { callsite }))

    await select(user, "/posts")

    expect(within(theQuery()).getByText(wholeText(`\u21b3 ${callsite}`))).toBeInTheDocument()
  })

  test("shows no callsite line for a query that carries none", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1", QUERY_LOGS))

    await select(user, "/posts/12")

    expect(callsiteLines(theQuery())).toHaveLength(0)
  })

  test("is highlighted by the tokenizer, keyword and comment apart", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1", QUERY_LOGS))

    await select(user, "/posts/12")
    const tokens = within(statement())

    for (const keyword of ["SELECT", "FROM", "WHERE"]) {
      expect(tokens.getByText(keyword)).toHaveAttribute("data-token", "keyword")
    }
    for (const identifier of tokens.getAllByText('"posts"')) {
      expect(identifier).not.toHaveAttribute("data-token", "keyword")
    }
    expect(tokens.getByText("/*action='show',controller='posts'*/")).toHaveAttribute("data-token", "comment")
  })

  test("shows its name and how long it took", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1", { name: "Post Load", duration_ms: 4.1 }),
    )

    await select(user, "/posts/12")

    expect(within(theQuery()).getByText("Post Load")).toBeInTheDocument()
    expect(within(theQuery()).getByText("4.1ms")).toBeInTheDocument()
  })

  test("marks a query the query cache answered, the way development.log does", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1", "SELECT 1", { cached: true }))

    await select(user, "/posts/12")

    expect(theQuery()).toHaveTextContent("CACHE")
  })

  test("renders its binds as chips labelled as this query's parameter values", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1", { binds: [4021, "rails logs", null, true] }),
    )

    await select(user, "/posts/12")
    // Never "sent to the database": trilogy never parameterizes a query at the wire level,
    // so that phrasing would be false there specifically — and the caption is on screen,
    // because the reading it corrects is the one a developer arrives with.
    const binds = within(theQuery()).getByRole("group", { name: "This query's parameter values" })

    expect(within(binds).getByText("parameter values")).toBeInTheDocument()
    expect(within(binds).getAllByRole("listitem").map((chip) => chip.textContent)).toEqual([
      "4021",
      "rails logs",
      "NULL",
      "true",
    ])
  })

  test("renders an empty bind list as simply no chips, not as an empty container", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1", "SELECT 1", { binds: [] }))

    await select(user, "/posts/12")

    expect(within(theQuery()).queryByRole("group")).not.toBeInTheDocument()
  })

  /** `connection.execute` skips Rails' query-building layer: `name` is a genuine `nil`. */
  test("renders a raw execute — no model, no binds, a nil name — as a plain ordinary row", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "PRAGMA foreign_keys", { name: null, binds: [], row_count: undefined }),
    )

    await select(user, "/posts/12")

    expect(statement().textContent).toBe("PRAGMA foreign_keys")
    // Its duration and its statement, and no name beside them.
    expect(theQuery()).toHaveTextContent(/^0\.4ms\s*PRAGMA foreign_keys$/)
    expect(within(theQuery()).getByText("0.4ms")).toBeInTheDocument()
  })
})

/**
 * #54: `development.log` never shows a SCHEMA or EXPLAIN query — Rails' own log subscriber
 * drops them by name before a line is ever written — so the Detail column hides them the same
 * way on open, with one chip to bring them back for the reload-diagnosis case they exist for.
 */
describe("the schema chip", () => {
  function schemaChip() {
    return chip("schema", "Filter by query kind")
  }

  function trailing() {
    return within(detail()).queryByRole("region", { name: "After the request finished" })
  }

  test("hides SCHEMA and EXPLAIN queries on open, among a request's ordinary ones", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT sql FROM sqlite_master", { name: "SCHEMA" }),
      run.sql("req-1", "EXPLAIN SELECT 1", { name: "EXPLAIN" }),
      run.sql("req-1", "SELECT 1", { name: "Post Load" }),
    )

    await select(user, "/posts/12")

    expect(timelineSays()).toEqual(["SELECT 1"])
    expect(schemaChip()).toHaveAttribute("aria-pressed", "false")
  })

  test("hides a hidden query's callsite along with it", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT sql FROM sqlite_master", { name: "SCHEMA", callsite: "app/models/post.rb:3:in '<class:Post>'" }),
      run.sql("req-1", "SELECT 1", { name: "Post Load" }),
    )

    await select(user, "/posts/12")

    expect(callsiteLines()).toHaveLength(0)
  })

  test("brings them back, interleaved where they were emitted, once the chip is on", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT sql FROM sqlite_master", { name: "SCHEMA" }),
      run.sql("req-1", "SELECT 1", { name: "Post Load" }),
    )

    await select(user, "/posts/12")
    await user.click(schemaChip())

    expect(timelineSays()).toEqual(["SELECT sql FROM sqlite_master", "SELECT 1"])
    expect(schemaChip()).toHaveAttribute("aria-pressed", "true")
  })

  test("leaves a query named anything else alone", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1", { name: "Post Load" }),
      run.sql("req-1", "PRAGMA foreign_keys", { name: null }),
    )

    await select(user, "/posts/12")

    expect(timelineSays()).toEqual(["SELECT 1", "PRAGMA foreign_keys"])
  })

  test("hides an all-SCHEMA trailing section rather than leaving it empty", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.finish("req-1"),
      run.sql("req-1", "SELECT sql FROM sqlite_master", { name: "SCHEMA" }),
    )

    await select(user, "/posts/12")

    expect(trailing()).not.toBeInTheDocument()
  })

  test("persists the choice, like the Console's chips", async () => {
    const run = aRun("srv-1")
    const envelopes = [
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT sql FROM sqlite_master", { name: "SCHEMA" }),
    ]

    const first = theReader(...envelopes)
    await select(first.user, "/posts/12")
    await first.user.click(schemaChip())

    first.unmount()

    const second = theReader(...envelopes)
    await select(second.user, "/posts/12")

    expect(timelineSays()).toEqual(["SELECT sql FROM sqlite_master"])
    expect(schemaChip()).toHaveAttribute("aria-pressed", "true")
  })
})

/**
 * The wire cuts a field at its per-field cap and records the original size. Whatever is cut
 * has to say so where it is read: the column's whole promise is that what is on screen is
 * what was emitted, and a statement quietly missing its tail breaks it silently.
 */
describe("a field the Sidecar had to cut", () => {
  const CUT = /was cut by the Sidecar/

  test("says so under the query, with what was emitted", async () => {
    const run = aRun("srv-1")
    const start = run.start("req-1", "GET", "/posts/12")
    const query = run.sql("req-1", "SELECT * FROM posts WHERE id IN (1, 2, 3")
    const { user } = theReader(start, { ...query, truncated: { sql: 812_400 } })

    await select(user, "/posts/12")

    expect(within(detail()).getByText(CUT)).toHaveTextContent(/^sql was cut by the Sidecar — 793 KB was emitted$/)
  })

  test("says so under a backtrace, because uncleaned is a promise only the file can break", async () => {
    const run = aRun("srv-1")
    const finish = run.finish("req-1", {
      status: 500,
      exception: { class: "NoMethodError", message: "boom", backtrace: ["app/models/order.rb:44"] },
    })
    const { user } = theReader(run.start("req-1", "POST", "/orders"), { ...finish, truncated: { backtrace: 300_000 } })

    await select(user, "/orders")

    expect(within(exception()).getByText(CUT)).toHaveTextContent("backtrace was cut")
  })

  test("says nothing at all about a query that arrived whole", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1"))

    await select(user, "/posts/12")

    expect(within(detail()).queryByText(CUT)).not.toBeInTheDocument()
  })
})

describe("what arrived after the request finished", () => {
  async function aTrailingEvent() {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1"),
      run.finish("req-1"),
      run.log("req-1", "Executor#to_complete ran after the body closed"),
    )
    await select(user, "/posts/12")
  }

  test("is shown in a section of its own, never silently inside the timeline", async () => {
    await aTrailingEvent()

    expect(timelineSays()).toEqual(["SELECT 1"])
    const trailing = within(detail()).getByRole("region", { name: "After the request finished" })
    expect(trailing).toHaveTextContent("Executor#to_complete ran after the body closed")
  })

  test("leaves an ordinary request no such section at all", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts/12"), run.sql("req-1"), run.finish("req-1"))

    await select(user, "/posts/12")

    expect(within(detail()).queryByRole("region", { name: "After the request finished" })).not.toBeInTheDocument()
  })
})

function exception() {
  return within(detail()).getByRole("region", { name: "Exception" })
}

/** The backtrace's own items: a frame each, or a marker standing in for the frames it hides. */
function backtraceItems() {
  return itemsOf(within(exception()).getByRole("list", { name: "Backtrace" }))
}

function revealButtons() {
  return within(detail()).queryAllByRole("button", { name: /frames? hidden$/ })
}

async function revealGaps(user: UserEvent) {
  for (const button of revealButtons()) await user.click(button)
}

describe("a request that raised", () => {
  const BACKTRACE = [
    "app/models/order.rb:44:in `block in recalculate_total!'",
    "actionpack (8.0.2) lib/action_controller/metal/rescue.rb:23:in `process_action'",
    "puma (6.6.0) lib/puma/server.rb:443:in `process_client'",
  ]

  test("shows its exception message and the raised frame, gem frames collapsed", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "undefined method `price_cents' for nil", backtrace: BACKTRACE },
      }),
    )

    await select(user, "/orders")

    expect(exception()).toHaveTextContent("NoMethodError")
    expect(exception()).toHaveTextContent("undefined method `price_cents' for nil")
    // The raise site always renders; the two gem frames behind it collapse into one marker.
    expect(backtraceItems().map((frame) => frame.textContent)).toEqual([
      "app/models/order.rb:44:in `block in recalculate_total!'",
      "2 frames hidden",
    ])
  })

  test("leaves a request that did not raise without an exception block", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(run.start("req-1", "GET", "/posts/12"), run.finish("req-1"))

    await select(user, "/posts/12")

    expect(within(detail()).queryByRole("region", { name: "Exception" })).not.toBeInTheDocument()
  })
})

describe("highlighting a Host-app backtrace frame", () => {
  const RAILS_ROOT = "/home/dev/example-app"
  const HOST_FRAME = `${RAILS_ROOT}/app/models/order.rb:44:in \`block in recalculate_total!'`
  const GEM_FRAME = "puma (6.6.0) lib/puma/server.rb:443:in `process_client'"

  test("gives only the frame under rails_root the full-contrast colour, style only", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.header(),
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [HOST_FRAME, GEM_FRAME] },
      }),
    )

    await select(user, "/orders")
    await revealGaps(user)
    const frames = backtraceItems()

    expect(frames.map((frame) => frame.textContent)).toEqual([HOST_FRAME, GEM_FRAME])
    expect(frames[0]).toHaveAttribute("data-frame", "host")
    expect(frames[1]).not.toHaveAttribute("data-frame")
    expect(frames).toHaveLength(2)
  })

  test("leaves every frame unhighlighted when the Run's run_header was never seen", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [HOST_FRAME, GEM_FRAME] },
      }),
    )

    await select(user, "/orders")
    await revealGaps(user)

    for (const frame of backtraceItems()) expect(frame).not.toHaveAttribute("data-frame")
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

    const {
      user,
      fold: { rows, identity },
    } = theReaderReceiving(proves, filler, reopens, raises)

    // The eviction and the reopen both happened: nothing here still says `rails_root`.
    const reopened = rows.find((row) => row.kind === "run" && row.runId === "srv-1")
    expect(reopened).toBeDefined()
    expect(reopened?.railsRoot).toBeNull()
    const boom = rows.find((row) => row.kind === "request" && row.path === "/orders")
    expect(boom).toBeDefined()
    expect(boom?.railsRoot).toBeNull()

    // `RunIdentity` never lost it, and highlighting reads off that rather than off either row.
    expect(identity?.railsRoot).toBe(RAILS_ROOT)
    await select(user, "/orders")
    expect(backtraceItems()[0]).toHaveAttribute("data-frame", "host")
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

  function backtrace() {
    return backtraceItems().map((item) => item.textContent)
  }

  test("renders the raised frame even when it is itself outside rails_root", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.header(),
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, HOST_FRAME] },
      }),
    )

    await select(user, "/orders")

    // The raise site is not folded into the marker's count, even though it fails
    // `isHostFrame` the same as any other gem frame would.
    expect(backtrace()).toEqual([RAISED, HOST_FRAME])
  })

  test("keeps a Host-app frame visible in its real stack position, gaps either side of it", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.header(),
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, GEM_BEFORE, HOST_FRAME, GEM_AFTER] },
      }),
    )

    await select(user, "/orders")

    expect(backtrace()).toEqual([RAISED, "1 frame hidden", HOST_FRAME, "1 frame hidden"])
  })

  test("collapses a trace with no Host-app frame to one marker spanning everything but the raised frame", async () => {
    const run = aRun("srv-1")
    // No run.header(): railsRoot stays null, so nothing can ever be a Host-app frame.
    const { user } = theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, GEM_BEFORE, GEM_AFTER] },
      }),
    )

    await select(user, "/orders")

    // The class and message stay visible above the single marker either way.
    expect(within(exception()).getByText("NoMethodError")).toBeInTheDocument()
    expect(backtrace()).toEqual([RAISED, "2 frames hidden"])
  })

  test("reveals a marker's frames for good, with no control to re-collapse it", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, GEM_BEFORE, GEM_AFTER] },
      }),
    )

    await select(user, "/orders")
    await user.click(revealButtons()[0]!)

    expect(backtrace()).toEqual([RAISED, GEM_BEFORE, GEM_AFTER])
    expect(revealButtons()).toHaveLength(0)
  })

  test("starts fully collapsed again on the next fresh render, once Selection moves away and back", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, GEM_BEFORE, GEM_AFTER] },
      }),
      run.start("req-2", "GET", "/posts/12"),
    )

    await select(user, "/orders")
    await user.click(revealButtons()[0]!)
    expect(backtrace()).toEqual([RAISED, GEM_BEFORE, GEM_AFTER])

    await select(user, "/posts/12")
    await select(user, "/orders")

    expect(backtrace()).toEqual([RAISED, "2 frames hidden"])
  })

  test("leaves the wire's own Cut note alone — collapsing and truncation never reference each other", async () => {
    const run = aRun("srv-1")
    const finish = run.finish("req-1", {
      status: 500,
      exception: { class: "NoMethodError", message: "boom", backtrace: [RAISED, GEM_BEFORE, GEM_AFTER] },
    })
    const { user } = theReader(run.start("req-1", "POST", "/orders"), { ...finish, truncated: { backtrace: 300_000 } })

    await select(user, "/orders")

    expect(backtrace()).toEqual([RAISED, "2 frames hidden"])
    expect(within(exception()).getByText(/was cut by the Sidecar/)).toHaveTextContent("backtrace was cut")
  })

  test("copies every frame regardless of what is still collapsed on screen", async () => {
    const run = aRun("srv-1")
    const backtrace = [RAISED, GEM_BEFORE, GEM_AFTER]
    const { user } = theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", { status: 500, exception: { class: "NoMethodError", message: "boom", backtrace } }),
    )

    await select(user, "/orders")
    // Nothing revealed — the marker is still on screen — yet the copy is the whole trace.
    expect(revealButtons()).toHaveLength(1)
    await user.click(within(exception()).getByRole("button", { name: "Copy exception" }))

    expect(await navigator.clipboard.readText()).toBe(["NoMethodError: boom", ...backtrace].join("\n"))
  })
})

/**
 * A clean plain-text reconstruction, meant for pasting into a bug tracker, a colleague's
 * chat, or an AI assistant — never the block's own markup, and never silent about the paste
 * having happened.
 */
describe("copying an exception", () => {
  function copyButton() {
    return within(exception()).getByRole("button", { name: "Copy exception" })
  }

  test("appears in the Exception block and nowhere else", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "POST", "/orders"),
      run.sql("req-1", "SELECT 1"),
      run.log("req-1", "about to raise"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "RuntimeError", message: "boom", backtrace: ["order.rb:1"] },
      }),
    )

    await select(user, "/orders")

    expect(within(detail()).getAllByRole("button", { name: /copy/i })).toEqual([copyButton()])
    // SQL queries and App log lines are easy enough to select-and-copy by hand.
    expect(within(queries()[0]!).queryByRole("button", { name: /copy/i })).not.toBeInTheDocument()
    expect(within(logLines()[0]!).queryByRole("button", { name: /copy/i })).not.toBeInTheDocument()
  })

  test("copies the class and message, then one backtrace frame per line, no UI chrome", async () => {
    const run = aRun("srv-1")
    const backtrace = ["app/models/order.rb:44:in `block in recalculate_total!'", "puma (6.6.0) lib/puma/server.rb:443"]
    const { user } = theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", {
        status: 500,
        exception: { class: "NoMethodError", message: "undefined method `price_cents' for nil", backtrace },
      }),
    )

    await select(user, "/orders")
    await user.click(copyButton())

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
    const { user } = theReader(run.start("req-1", "POST", "/orders"), { ...finish, truncated: { backtrace: 300_000 } })

    await select(user, "/orders")
    const note = within(exception()).getByText(/was cut by the Sidecar/).textContent
    await user.click(copyButton())

    expect(note).not.toBeNull()
    expect(await navigator.clipboard.readText()).toBe(`NoMethodError: boom\napp/models/order.rb:44\n# ${note}`)
  })

  test("gives a visible confirmation after a successful copy, rather than copying silently", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.start("req-1", "POST", "/orders"),
      run.finish("req-1", { status: 500, exception: { class: "RuntimeError", message: "boom", backtrace: [] } }),
    )

    await select(user, "/orders")
    expect(copyButton()).not.toHaveTextContent("Copied")

    await user.click(copyButton())

    expect(copyButton()).toHaveTextContent("Copied")
  })
})

/**
 * The whole point of the column, over the dense seed rather than a crafted pair: the shape
 * has to be visible in the middle of a real request's traffic, not on its own.
 */
describe("the N+1-shaped request in a busy dev app's Sidecar", () => {
  test("reads as a run of near-identical queries, differing only in their bind", async () => {
    const { user } = theReader(...DENSE_TRAFFIC)

    await select(user, "/api/v1/feed?page=1")
    const authorLoads = queries().filter((entry) => within(entry).queryByText("Author Load") !== null)

    expect(queries()).toHaveLength(24)
    expect(authorLoads).toHaveLength(20)
    // Twenty rows the eye can see are the same, and one chip per row that is not — which is
    // what makes the shape obvious without the Reader claiming to have detected anything.
    expect(new Set(authorLoads.map((entry) => within(entry).getByRole("code").textContent)).size).toBe(1)
    expect(new Set(authorLoads.map((entry) => within(entry).getAllByRole("listitem")[0]?.textContent)).size).toBe(20)
  })

  test("keeps the four logger calls in among them, where they were emitted", async () => {
    const { user } = theReader(...DENSE_TRAFFIC)

    await select(user, "/api/v1/feed?page=1")
    const kinds = itemsOf(timeline()).map((entry) => (isQuery(entry) ? "sql" : "log"))

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
  test("opens what its Run emitted with no owning request", async () => {
    const run = aRun("rake-1")
    const { user } = theReader(
      run.header("rake", 91_887),
      run.log(null, "reports:rebuild — 41,209 orders to process"),
      run.sql(null, 'SELECT COUNT(*) FROM "orders"'),
    )

    await select(user, "rake")

    expect(detail()).toHaveTextContent("rake")
    expect(detail()).toHaveTextContent("pid 91887")
    expect(timelineSays()).toEqual(says("reports:rebuild — 41,209 orders to process", 'SELECT COUNT(*) FROM "orders"'))
  })

  test("keeps the requests of the same Run out of it", async () => {
    const run = aRun("srv-1")
    const { user } = theReader(
      run.header(),
      run.log(null, "=> Booting Puma"),
      run.start("req-1", "GET", "/posts/12"),
      run.sql("req-1", "SELECT 1"),
      run.finish("req-1"),
    )

    await select(user, "server")

    expect(timelineSays()).toEqual(says("=> Booting Puma"))
  })
})
