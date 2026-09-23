import { afterEach, describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC } from "./traffic.fixtures"
import type { Envelope } from "../src/shared/wire"
import {
  activityRows,
  cellUnder,
  column,
  consoleLines,
  lit,
  openTheReader,
  rowShowing,
  search,
  select,
  timeline,
  wholeText,
} from "./reader.harness"

afterEach(() => {
  localStorage.clear()
})

/**
 * Seam 2, the search's half: the Reader mounted over both folds seeded from one stream of
 * envelopes, and a term *typed* into the search box — so what is asserted is what lights up
 * on screen, never what a matching function returned.
 */
function theReader(...envelopes: Envelope[]) {
  return openTheReader(envelopes)
}

function detail() {
  return column("Detail column")
}

/** Every mark anywhere in the Reader. */
function everyMark() {
  return lit(document.body)
}

describe("searching", () => {
  test("lights up a Console line that says the term, whatever case it says it in", async () => {
    const rails = aRun("srv-1")
    const { user } = theReader(
      rails.header(),
      rails.start("req-1"),
      rails.log("req-1", "Loaded 3 Posts for the feed"),
      rails.log("req-1", "Cache miss for user 4021"),
    )

    await search(user, "posts")

    expect(lit(column("Console"))).toEqual(["Posts"])
  })

  test("lights up a path and a Controller#action in the Activity table", async () => {
    const rails = aRun("srv-1")
    const { user } = theReader(
      rails.header(),
      rails.start("req-1", "GET", "/posts/12"),
      rails.route("req-1", "PostsController", "show"),
      rails.start("req-2", "GET", "/authors/4"),
      rails.route("req-2", "AuthorsController", "show"),
    )
    // Found before searching: a lit path is no longer one piece of text to find it by.
    const posts = rowShowing("/posts/12")
    const authors = rowShowing("/authors/4")

    await search(user, "post")

    expect(lit(cellUnder(posts, "Path"))).toEqual(["post"])
    expect(lit(cellUnder(posts, "Controller#action"))).toEqual(["Post"])
    expect(lit(authors)).toEqual([])
  })

  test("lights up a match in the SQL text across the highlighter's own tokens, without changing a character", async () => {
    const rails = aRun("srv-1")
    const statement = 'SELECT "posts".* FROM "posts" WHERE "posts"."id" = ? LIMIT ?'
    const { user } = theReader(rails.header(), rails.start("req-1"), rails.sql("req-1", statement))

    await select(user, "/posts/12")
    await search(user, 'POSTS"."ID')

    const sql = within(detail()).getByRole("code")
    const marks = within(sql).getAllByRole("mark")
    // `"posts"`, `.` and `"id"` are three tokens in three colours, and one match. The match is
    // lit across all three, and each keeps its colour.
    expect(lit(sql).join("")).toBe('posts"."id')
    expect(marks).toHaveLength(3)
    expect(marks[0]!.parentElement).toHaveAttribute("data-token", "identifier")
    expect(marks[1]!.parentElement).not.toHaveAttribute("data-token", "identifier")
    expect(marks[2]!.parentElement).toHaveAttribute("data-token", "identifier")
    expect(sql.textContent).toBe(statement)
  })

  test("lights up a match in a query's callsite", async () => {
    const rails = aRun("srv-1")
    const callsite = "app/controllers/posts_controller.rb:9:in 'PostsController#show'"
    const { user } = theReader(rails.header(), rails.start("req-1"), rails.sql("req-1", "SELECT 1", { callsite }))

    await select(user, "/posts/12")
    await search(user, "posts_controller")

    expect(lit(within(detail()).getByText(wholeText(`\u21b3 ${callsite}`)))).toEqual(["posts_controller"])
  })

  test("lights up a match in a log line's callsite, the ↳ included", async () => {
    const rails = aRun("srv-1")
    const callsite = "app/controllers/feed_controller.rb:7:in 'FeedController#index'"
    const { user } = theReader(rails.header(), rails.start("req-1"), rails.log("req-1", "Feed cache MISS", { callsite }))

    await select(user, "/posts/12")
    await search(user, "\u21b3 app/controllers")

    expect(lit(within(detail()).getByText(wholeText(`\u21b3 ${callsite}`)))).toEqual(["\u21b3 ", "app/controllers"])
  })

  test("finds nothing in a rails-sourced log line's callsite, which is not shown", async () => {
    const rails = aRun("srv-1")
    const { user } = theReader(
      rails.header(),
      rails.start("req-1"),
      rails.log("req-1", "Rendered feed/index.html.erb", {
        source: "rails",
        callsite: "/home/dev/.gem/actionview-8.0.2/lib/action_view/template.rb:251:in 'block in render'",
      }),
    )

    await select(user, "/posts/12")
    await search(user, "action_view")

    expect(lit(detail())).toEqual([])
  })

  test("lights up the timeline's log lines and the heading in the Detail column", async () => {
    const rails = aRun("srv-1")
    const { user } = theReader(
      rails.header(),
      rails.start("req-1", "GET", "/feed"),
      rails.route("req-1", "FeedController", "index"),
      rails.log("req-1", "Feed cache MISS for user 4021"),
    )

    await select(user, "/feed")
    await search(user, "feed")

    // The heading's two ahead of the timeline's one: everything the request's detail lit,
    // and then what its timeline alone did.
    expect(lit(within(detail()).getByRole("article"))).toEqual(["feed", "Feed", "Feed"])
    expect(lit(timeline())).toEqual(["Feed"])
  })

  test("reaches into a collapsed backtrace gap, forcing it open the way it does everywhere else", async () => {
    const rails = aRun("srv-1")
    const { user } = theReader(
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

    await select(user, "/orders")
    const reveal = () => within(detail()).queryByRole("button", { name: /frames? hidden$/ })
    // Collapsed on open: the term below lives inside the marker, not on screen yet.
    expect(reveal()).toBeInTheDocument()

    await search(user, "puma")

    expect(reveal()).not.toBeInTheDocument()
    // The frame says "puma" twice — once naming the gem, once in its own path.
    expect(lit(within(detail()).getByRole("list", { name: "Backtrace" }))).toEqual(["puma", "puma"])
  })

  test("hides nothing: every row and every line is still there, matching or not", async () => {
    const { user } = theReader(...DENSE_TRAFFIC)
    const before = { rows: activityRows().length, lines: consoleLines().length }

    // A term only a handful of rows and lines say, over the busy seed.
    await search(user, "feed")

    expect(everyMark().length).toBeGreaterThan(0)
    expect(activityRows()).toHaveLength(before.rows)
    expect(consoleLines()).toHaveLength(before.lines)
  })

  test("hides nothing even when nothing matches", async () => {
    const { user } = theReader(...DENSE_TRAFFIC)
    const rows = activityRows().length

    await search(user, "nothing in the log says this")

    expect(everyMark()).toHaveLength(0)
    expect(activityRows()).toHaveLength(rows)
  })

  test("takes the term literally — what would be a regex is only the characters typed", async () => {
    const rails = aRun("srv-1")
    const { user } = theReader(rails.header(), rails.start("req-1", "GET", "/search?q=a.b"), rails.start("req-2", "GET", "/search?q=axb"))

    const [dotted, literal] = [rowShowing("/search?q=a.b"), rowShowing("/search?q=axb")]

    await search(user, "a.b")

    expect(lit(cellUnder(dotted, "Path"))).toEqual(["a.b"])
    expect(lit(cellUnder(literal, "Path"))).toEqual([])
  })

  test("lights every occurrence, not only the first", async () => {
    const rails = aRun("srv-1")
    const { user } = theReader(rails.header(), rails.start("req-1", "GET", "/posts/12/posts"))
    const row = rowShowing("/posts/12/posts")

    await search(user, "posts")

    expect(lit(cellUnder(row, "Path"))).toEqual(["posts", "posts"])
  })

  test("puts every mark out again when the box is emptied", async () => {
    const rails = aRun("srv-1")
    const { user } = theReader(rails.header(), rails.start("req-1", "GET", "/posts/12"))

    await search(user, "posts")
    await search(user, "")

    expect(everyMark()).toHaveLength(0)
    expect(cellUnder(rowShowing("/posts/12"), "Path")).toHaveTextContent(/^\/posts\/12$/)
  })
})
