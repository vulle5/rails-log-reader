import { describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import type { ResponsePayload } from "../src/shared/wire"
import { aRun } from "./sidecar.fixtures"
import { SERVER_RUN, SITEMAP_XML } from "./traffic.fixtures"
import { detailPanel, detailTab, lit, openTheReader, search, select, showDetailTab, treeItem, valueTree } from "./reader.harness"

/**
 * *Search* on the Headers and Response tabs, driven the way a developer drives it: a term typed
 * into the search box over a selected request, read off the marks it lights and the badge a tab
 * carries while it is not showing.
 */

const HEADERS: [string, string][] = [
  ["content-type", "application/json; charset=utf-8"],
  ["x-request-id", "4be1e3f0"],
  ["x-runtime", "0.004"],
]

const BODY = '{"order":{"shipping":{"city":"Oslo","zip":"0150"},"billing":{"city":"Bergen"}},"total":12}'

/** One finished request to `/orders/12`, selected, its response `BODY` under `HEADERS` but for `response`. */
async function onTimeline(response: Partial<ResponsePayload> = {}, truncated?: Record<string, number>) {
  const run = aRun(SERVER_RUN)
  const { user } = openTheReader([
    run.start("req-1", "GET", "/orders/12"),
    run.finish("req-1"),
    run.response("req-1", { body: BODY, headers: HEADERS, ...response }, truncated),
  ])
  await select(user, "/orders/12")
  return user
}

function toggle(name: "Pretty" | "Raw") {
  return within(detailPanel("Response")).getByRole("button", { name })
}

describe("searching the Headers tab", () => {
  test("lights a header's name and its value, each on its own", async () => {
    const user = await onTimeline()
    await showDetailTab(user, "Headers")

    await search(user, "x-r")
    expect(lit(detailPanel("Headers"))).toEqual(["x-r", "x-r"])

    await search(user, "0.004")
    expect(lit(detailPanel("Headers"))).toEqual(["0.004"])

    await search(user, "runtime: 0")
    expect(lit(detailPanel("Headers"))).toEqual([])
  })

  test("never lights its own words: the heading, the status, a note that there are none", async () => {
    const user = await onTimeline({ headers: [] })
    await showDetailTab(user, "Headers")

    await search(user, "Response")
    expect(lit(detailPanel("Headers"))).toEqual([])

    await search(user, "200")
    expect(lit(detailPanel("Headers"))).toEqual([])

    await search(user, "no headers")
    expect(lit(detailPanel("Headers"))).toEqual([])
  })
})

describe("searching the Response tab", () => {
  test("opens a pretty body's folds down to a match, leaving matchless siblings folded", async () => {
    const user = await onTimeline()
    await showDetailTab(user, "Response")

    await search(user, "Oslo")

    const tree = valueTree("Response body")
    expect(treeItem(tree, "order")).toHaveAttribute("aria-expanded", "true")
    expect(treeItem(treeItem(tree, "order"), "shipping")).toHaveAttribute("aria-expanded", "true")
    expect(treeItem(treeItem(tree, "order"), "billing")).toHaveAttribute("aria-expanded", "false")
    expect(lit(tree)).toEqual(["Oslo"])
  })

  test("lights the same term in the raw text once Raw is showing", async () => {
    const user = await onTimeline()
    await showDetailTab(user, "Response")
    await search(user, "Oslo")

    await user.click(toggle("Raw"))

    expect(lit(detailPanel("Response"))).toEqual(["Oslo"])
  })

  test("never lights its own words: the strip, the view buttons, a note on a cut body", async () => {
    const user = await onTimeline({ body: `{"items":[${'"x",'.repeat(10)}` }, { body: 200 * 1024 })
    await showDetailTab(user, "Response")

    for (const term of ["200 OK", "application/json", "200 KB", "Pretty", "raw text"]) {
      await search(user, term)
      expect(lit(detailPanel("Response"))).toEqual([])
    }
  })
})

describe("the Headers and Response tabs' counts of Search matches", () => {
  test("equal the matches each tab lights on opening", async () => {
    const user = await onTimeline()
    await search(user, "i")

    await showDetailTab(user, "Headers")
    const headers = lit(detailPanel("Headers")).length
    await showDetailTab(user, "Response")
    const response = lit(detailPanel("Response")).length
    await showDetailTab(user, "Timeline")

    expect(headers).toBeGreaterThan(1)
    expect(response).toBeGreaterThan(1)
    expect(detailTab("Headers")).toHaveAccessibleDescription(`${headers} matches`)
    expect(detailTab("Response")).toHaveAccessibleDescription(`${response} matches`)
  })

  test("count an XML body's matches as its tree lights them", async () => {
    const user = await onTimeline({ format: "xml", content_type: "application/xml", body: SITEMAP_XML })
    await search(user, "posts/1")
    expect(detailTab("Response")).toHaveAccessibleDescription("2 matches")

    await showDetailTab(user, "Response")
    expect(lit(valueTree("Response body"))).toEqual(["posts/1", "posts/1"])
  })

  test("count an unparseable body's matches in its raw text, never its note", async () => {
    const user = await onTimeline({ body: '{"id":12,"title":"valid' })

    await search(user, "valid")
    expect(detailTab("Response")).toHaveAccessibleDescription("1 match")

    await showDetailTab(user, "Response")
    expect(lit(detailPanel("Response"))).toEqual(["valid"])
  })

  test("count a cut body's matches in its raw text", async () => {
    const user = await onTimeline({ body: `{"items":[${'"x",'.repeat(10)}` }, { body: 200 * 1024 })

    await search(user, '"x"')

    expect(detailTab("Response")).toHaveAccessibleDescription("10 matches")
  })

  test("count what Raw lights once Raw is chosen", async () => {
    const user = await onTimeline({ body: '{"a":"b"}' })
    await search(user, '"')
    expect(detailTab("Response")).toHaveAccessibleDescription("2 matches")

    await showDetailTab(user, "Response")
    await user.click(toggle("Raw"))
    await showDetailTab(user, "Timeline")
    expect(detailTab("Response")).toHaveAccessibleDescription("4 matches")

    await showDetailTab(user, "Response")
    expect(lit(detailPanel("Response"))).toHaveLength(4)
  })

  test("are absent with no term, and with a term matching nothing there", async () => {
    const user = await onTimeline()

    expect(detailTab("Headers")).not.toHaveAccessibleDescription()
    expect(detailTab("Response")).not.toHaveAccessibleDescription()

    await search(user, "Oslo")
    expect(detailTab("Headers")).not.toHaveAccessibleDescription()
    expect(detailTab("Response")).toHaveAccessibleDescription("1 match")

    await search(user, "")
    expect(detailTab("Response")).not.toHaveAccessibleDescription()
  })
})
