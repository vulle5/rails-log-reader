import { describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC, HANGS, NEVER_ROUTED, NO_BODY, RESPONSES, SERVER_RUN } from "./traffic.fixtures"
import { Reader } from "../src/ui/Reader"
import {
  detailPanel,
  detailTab,
  detailTabBar,
  folded,
  itemsOf,
  lit,
  openTheReader,
  openTheReaderOver,
  select,
  search,
  showDetailTab,
} from "./reader.harness"

/**
 * The Headers tab, reached the way a developer reaches it: the Reader over the seed, a row
 * clicked, then Headers. What it lists is read off the list a screen reader would walk.
 */

/** Each header is named by its own line, `name: value`. */
function expectHeaders(panel: HTMLElement, lines: readonly string[]) {
  const headers = itemsOf(within(panel).getByRole("list", { name: "Response headers" }))
  expect(headers).toHaveLength(lines.length)
  lines.forEach((line, at) => expect(headers[at]).toHaveAccessibleName(line))
}

describe("the Headers tab", () => {
  test("joins a finished request's bar as Timeline | Params | Headers | Response", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts/12"),
      run.route("req-1", "PostsController", "show", { pairs: [["id", "12"]] }),
      run.finish("req-1"),
      run.response("req-1"),
    ])
    await select(user, "/posts/12")

    const tabs = within(detailTabBar()).getAllByRole("tab")
    expect(tabs).toHaveLength(4)
    expect(tabs[0]).toHaveTextContent(/^Timeline$/)
    expect(tabs[1]).toHaveTextContent(/^Params$/)
    expect(tabs[2]).toHaveTextContent(/^Headers$/)
    expect(tabs[3]).toHaveTextContent(/^Response json$/)
    expect(detailTab("Headers")).toBeEnabled()
  })

  test("says Response headers and the status, then every header sorted by name", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, "/api/v1/me")
    await showDetailTab(user, "Headers")

    const panel = detailPanel("Headers")
    expect(within(panel).getByRole("heading", { name: "Response headers" })).toBeInTheDocument()
    expect(within(panel).getByText("200")).toBeInTheDocument()
    expectHeaders(panel, [
      "cache-control: max-age=0, private, must-revalidate",
      "content-type: application/json; charset=utf-8",
      'etag: W/"4be1e3f0a6c52d8a"',
      "server-timing: sql.active_record;dur=1.6, process_action.action_controller;dur=3.9",
      `x-request-id: ${RESPONSES.json}`,
      "x-runtime: 0.004812",
    ])
  })

  test("keeps a repeated header as many times as the app set it, in the order it set them", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts/12"),
      run.finish("req-1"),
      run.response("req-1", {
        headers: [
          ["vary", "Accept"],
          ["set-cookie", "b=2"],
          ["Cache-Control", "no-store"],
          ["set-cookie", "a=1"],
        ],
      }),
    ])
    await select(user, "/posts/12")
    await showDetailTab(user, "Headers")

    expectHeaders(detailPanel("Headers"), [
      "Cache-Control: no-store",
      "set-cookie: b=2",
      "set-cookie: a=1",
      "vary: Accept",
    ])
  })

  test("is disabled while the request is in flight, and enabled once it has finished", async () => {
    const run = aRun(SERVER_RUN)
    const fold = folded([run.start("req-1", "GET", "/posts/12"), run.route("req-1")])
    const { user, rerender } = openTheReaderOver(fold)
    await select(user, "/posts/12")

    expect(detailTab("Headers")).toBeDisabled()

    fold.fold([run.finish("req-1"), run.response("req-1")])
    rerender(<Reader {...fold.props} />)

    expect(detailTab("Headers")).toBeEnabled()
  })

  test("is disabled on a request whose Run ended before it finished", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([run.start("req-1", "GET", "/posts/12"), run.route("req-1"), run.end()])
    await select(user, "/posts/12")

    expect(detailTab("Headers")).toBeDisabled()
  })

  test("is enabled on a routing 404, whose Params are disabled", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, NEVER_ROUTED.path)

    expect(detailTab("Params")).toBeDisabled()
    expect(detailTab("Headers")).toBeEnabled()

    await showDetailTab(user, "Headers")

    expect(within(detailPanel("Headers")).getByText("404")).toBeInTheDocument()
    expectHeaders(detailPanel("Headers"), [
      "content-length: 18204",
      "content-type: text/html; charset=utf-8",
      `x-request-id: ${NEVER_ROUTED.requestId}`,
      "x-runtime: 0.007211",
    ])
  })

  test("stays chosen when another finished request is selected", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, "/api/v1/me")
    await showDetailTab(user, "Headers")

    await select(user, "/sitemap.xml")

    expect(detailTab("Headers")).toHaveAttribute("aria-selected", "true")
    expectHeaders(detailPanel("Headers"), [
      "cache-control: max-age=0, private, must-revalidate",
      "content-type: application/xml; charset=utf-8",
      'etag: W/"9d27c0b1e4f8a365"',
      "server-timing: sql.active_record;dur=1.6, process_action.action_controller;dur=3.9",
      `x-request-id: ${RESPONSES.xml}`,
      "x-runtime: 0.004812",
    ])
  })

  test("falls back to Timeline on a request in flight, and comes back to Headers on the next finished one", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, "/api/v1/me")
    await showDetailTab(user, "Headers")

    await select(user, HANGS.path)
    expect(detailTab("Timeline")).toHaveAttribute("aria-selected", "true")

    await select(user, "/sitemap.xml")
    expect(detailTab("Headers")).toHaveAttribute("aria-selected", "true")
  })

  test("says so when a finished request has no response recorded", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([run.start("req-1", "GET", "/posts/12"), run.finish("req-1")])
    await select(user, "/posts/12")
    await showDetailTab(user, "Headers")

    expect(within(detailPanel("Headers")).getByText("No response was recorded for this request.")).toBeInTheDocument()
  })

  test("says a hijacked connection has no headers to read", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, NO_BODY.hijacked.path)
    await showDetailTab(user, "Headers")

    const panel = within(detailPanel("Headers"))
    expect(panel.getByText("The connection was handed over, so there are no headers to read.")).toBeInTheDocument()
    expect(panel.queryByText("Response headers")).not.toBeInTheDocument()
  })
})

describe("searching headers", () => {
  test("lights a match in a header's name and value, and counts them on the tab while it is not showing", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, "/api/v1/me")
    await search(user, "etag")

    expect(detailTab("Headers")).toHaveAccessibleDescription("1 match")

    await showDetailTab(user, "Headers")
    await search(user, "4be1e3f0")

    expect(lit(detailPanel("Headers"))).toEqual(["4be1e3f0"])
  })
})

/**
 * Copying headers: what lands on the clipboard is read back off the clipboard, and each control
 * is found by its role and name, the way assistive technology finds it.
 */
describe("copying headers", () => {
  async function showHeaders() {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts/12"),
      run.finish("req-1"),
      run.response("req-1", {
        headers: [
          ["vary", "Accept"],
          ["content-type", "application/json; charset=utf-8"],
          ["set-cookie", "a=1; path=/"],
          ["set-cookie", "b=2; path=/"],
        ],
      }),
    ])
    await select(user, "/posts/12")
    await showDetailTab(user, "Headers")
    return { user, panel: detailPanel("Headers") }
  }

  test("copies one header's value", async () => {
    const { user, panel } = await showHeaders()
    const third = itemsOf(within(panel).getByRole("list", { name: "Response headers" }))[2]
    if (third === undefined) throw new Error("no third header")

    await user.click(within(third).getByRole("button", { name: "Copy value" }))

    expect(await navigator.clipboard.readText()).toBe("b=2; path=/")
  })

  test("describes each value's copy by its header", async () => {
    const { panel } = await showHeaders()

    const copies = within(panel).getAllByRole("button", { name: "Copy value" })
    expect(copies[0]).toHaveAccessibleDescription("content-type: application/json; charset=utf-8")
  })

  test("copies every header, one per line as Name: value", async () => {
    const { user, panel } = await showHeaders()

    await user.click(within(panel).getByRole("button", { name: "Copy all headers" }))

    expect(await navigator.clipboard.readText()).toBe(
      "content-type: application/json; charset=utf-8\nset-cookie: a=1; path=/\nset-cookie: b=2; path=/\nvary: Accept",
    )
  })
})
