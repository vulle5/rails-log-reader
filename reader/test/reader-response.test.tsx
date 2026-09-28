import { describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import { aRun } from "./sidecar.fixtures"
import { DENSE_TRAFFIC, HANGS, NEVER_ROUTED, SERVER_RUN } from "./traffic.fixtures"
import { Reader } from "../src/ui/Reader"
import {
  detailPanel,
  detailTab,
  detailTabBar,
  folded,
  openTheReader,
  openTheReaderOver,
  select,
  showDetailTab,
  treeItem,
  treeItemsOf,
  valueTree,
  wholeText,
} from "./reader.harness"

/**
 * The Response tab, reached the way a developer reaches it: the Reader over the seed, a row
 * clicked, then Response. The body is read off the tree a screen reader would walk.
 */

/** Each item is named by its own line: `key: value`, or `key: {…} N keys` for a folded node. */
function expectLines(items: readonly HTMLElement[], lines: readonly string[]) {
  expect(items).toHaveLength(lines.length)
  lines.forEach((line, at) => expect(items[at]).toHaveAccessibleName(line))
}

describe("the Response tab", () => {
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
    expect(tabs[3]).toHaveTextContent(/^Response json$/)
    expect(detailTab("Response")).toBeEnabled()
  })

  test("says the status with its reason phrase, the content type and the size over the body", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, "/api/v1/me")
    await showDetailTab(user, "Response")

    expect(within(detailPanel("Response")).getByText(wholeText("200 OK · application/json · 149 bytes"))).toBeInTheDocument()
  })

  test("sizes a body over a kilobyte to a tenth of one", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "POST", "/posts"),
      run.finish("req-1"),
      run.response("req-1", { status: 422, size: 1229 }),
    ])
    await select(user, "/posts")
    await showDetailTab(user, "Response")

    expect(
      within(detailPanel("Response")).getByText(wholeText("422 Unprocessable Content · application/json · 1.2 KB")),
    ).toBeInTheDocument()
  })

  test("draws a JSON body as a tree, the top level open and every nested node folded", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, "/api/v1/me")
    await showDetailTab(user, "Response")

    const tree = valueTree("Response body")
    expectLines(treeItemsOf(tree), [
      "id: 4021",
      'name: "Ada Lovelace"',
      'email: "ada@example.com"',
      "profile: {…} 2 keys",
      "subscription: {…} 2 keys",
    ])
    expect(treeItem(tree, "profile")).toHaveAttribute("aria-expanded", "false")
    expect(treeItem(tree, "subscription")).toHaveAttribute("aria-expanded", "false")
  })

  test("colours each leaf by its real JSON type, so 1 and \"1\" read apart", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts/12"),
      run.finish("req-1"),
      run.response("req-1", { body: '{"id":1,"code":"1","published":true,"deleted_at":null}' }),
    ])
    await select(user, "/posts/12")
    await showDetailTab(user, "Response")

    const tree = valueTree("Response body")
    expect(within(treeItem(tree, "id")).getByText("1")).toHaveAttribute("data-token", "number")
    expect(within(treeItem(tree, "code")).getByText('"1"')).toHaveAttribute("data-token", "string")
    expect(within(treeItem(tree, "published")).getByText("true")).toHaveAttribute("data-token", "keyword")
    expect(within(treeItem(tree, "deleted_at")).getByText("null")).toHaveAttribute("data-token", "null")
  })

  test("keeps the body's own key order, integer-like keys included", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "GET", "/carts/7"),
      run.finish("req-1"),
      run.response("req-1", { body: '{"name":"cart","42":1,"7":2}' }),
    ])
    await select(user, "/carts/7")
    await showDetailTab(user, "Response")

    expectLines(treeItemsOf(valueTree("Response body")), ['name: "cart"', "42: 1", "7: 2"])
  })

  test("shows a body that is not valid JSON as the text the app sent", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts/12"),
      run.finish("req-1"),
      run.response("req-1", { body: '{"id":12,' }),
    ])
    await select(user, "/posts/12")
    await showDetailTab(user, "Response")

    expect(within(detailPanel("Response")).getByText('{"id":12,')).toBeInTheDocument()
    expect(within(detailPanel("Response")).queryByRole("tree")).not.toBeInTheDocument()
  })
})

describe("the Response tab's label", () => {
  test("carries json for a kept JSON body", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, "/api/v1/me")

    expect(detailTab("Response")).toHaveAccessibleName("Response json")
  })

  test("carries nothing extra while the request is in flight", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, HANGS.path)

    expect(detailTab("Response")).toHaveAccessibleName("Response")
  })

  test("carries nothing extra for a finished request with no Response event", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([run.start("req-1", "GET", "/posts/12"), run.finish("req-1")])
    await select(user, "/posts/12")

    expect(detailTab("Response")).toHaveAccessibleName("Response")
  })
})

describe("a Response tab with no response", () => {
  test("waits for the response while the request is in flight, and shows it once it arrives", async () => {
    const run = aRun(SERVER_RUN)
    const fold = folded([run.start("req-1", "GET", "/posts/12"), run.route("req-1")])
    const { user, rerender } = openTheReaderOver(fold)
    await select(user, "/posts/12")
    await showDetailTab(user, "Response")

    expect(detailTab("Response")).toHaveAttribute("aria-selected", "true")
    expect(within(detailPanel("Response")).getByText("Waiting for the response…")).toBeInTheDocument()

    fold.fold([run.finish("req-1"), run.response("req-1")])
    rerender(<Reader {...fold.props} />)

    expect(treeItem(valueTree("Response body"), "id")).toHaveAccessibleName("id: 12")
  })

  test("says so on a finished request with no Response event", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([run.start("req-1", "GET", "/posts/12"), run.finish("req-1")])
    await select(user, "/posts/12")
    await showDetailTab(user, "Response")

    expect(within(detailPanel("Response")).getByText("No response for this request.")).toBeInTheDocument()
  })

  test("is disabled on a request whose Run ended before it finished", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([run.start("req-1", "GET", "/posts/12"), run.route("req-1"), run.end()])
    await select(user, "/posts/12")

    expect(detailTab("Response")).toBeDisabled()
  })
})

describe("choosing Response", () => {
  test("is enabled on a routing 404, and shows its response", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, NEVER_ROUTED.path)

    expect(detailTab("Response")).toBeEnabled()

    await showDetailTab(user, "Response")

    expect(within(detailPanel("Response")).getByText(wholeText("404 Not Found · text/html · 17.8 KB"))).toBeInTheDocument()
  })

  test("stays chosen when another finished request is selected, so their bodies compare", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts/12"),
      run.finish("req-1"),
      run.response("req-1", { body: '{"id":12}' }),
      run.start("req-2", "GET", "/posts/13"),
      run.finish("req-2"),
      run.response("req-2", { body: '{"id":13}' }),
    ])
    await select(user, "/posts/12")
    await showDetailTab(user, "Response")

    await select(user, "/posts/13")

    expect(detailTab("Response")).toHaveAttribute("aria-selected", "true")
    expect(treeItem(valueTree("Response body"), "id")).toHaveAccessibleName("id: 13")
  })
})

/**
 * Pretty and Raw: the body laid out as a tree, or as the text the app sent. The toggle is two
 * buttons, the pressed one showing, and Copy hands over whichever is showing.
 */
describe("Pretty and Raw", () => {
  const RAW = '{"posts":[{"id":1,"title":"Hi"}],  "total": 1}'

  /** `sent` is the size the app sent, `null` for one it did not know. */
  async function showBody(body = RAW, truncated?: Record<string, number>, sent: number | null = body.length) {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts"),
      run.finish("req-1"),
      run.response("req-1", { body, size: sent ?? undefined }, truncated),
      run.start("req-2", "GET", "/posts/13"),
      run.finish("req-2"),
      run.response("req-2", { body: '{"id":13}' }),
    ])
    await select(user, "/posts")
    await showDetailTab(user, "Response")
    return user
  }

  function bodyView() {
    return within(detailPanel("Response")).getByRole("group", { name: "Show the body as" })
  }

  function toggle(name: "Pretty" | "Raw") {
    return within(bodyView()).getByRole("button", { name })
  }

  function copyBody() {
    return within(detailPanel("Response")).getByRole("button", { name: "Copy response body" })
  }

  test("opens pretty, and Raw shows the body exactly as recorded", async () => {
    const user = await showBody()

    expect(toggle("Pretty")).toBePressed()
    expect(toggle("Raw")).not.toBePressed()
    expect(valueTree("Response body")).toBeInTheDocument()

    await user.click(toggle("Raw"))

    expect(toggle("Raw")).toBePressed()
    expect(within(detailPanel("Response")).queryByRole("tree")).not.toBeInTheDocument()
    expect(within(detailPanel("Response")).getByText(wholeText(RAW))).toBeInTheDocument()
  })

  test("opens the next Selection's body pretty, whatever the last one showed", async () => {
    const user = await showBody()
    await user.click(toggle("Raw"))

    await select(user, "/posts/13")

    expect(toggle("Pretty")).toBePressed()
    expect(treeItem(valueTree("Response body"), "id")).toHaveAccessibleName("id: 13")
  })

  test("copies indented JSON while pretty, and the exact text while raw", async () => {
    const user = await showBody()

    await user.click(copyBody())
    expect(await navigator.clipboard.readText()).toBe(
      '{\n  "posts": [\n    {\n      "id": 1,\n      "title": "Hi"\n    }\n  ],\n  "total": 1\n}',
    )

    await user.click(toggle("Raw"))
    await user.click(copyBody())
    expect(await navigator.clipboard.readText()).toBe(RAW)
  })

  test("copies a nested node's path as parsed_body Ruby, and its value as its JSON", async () => {
    const user = await showBody()
    const tree = valueTree("Response body")
    await user.click(treeItem(tree, "posts"))
    await user.click(treeItem(tree, "0"))
    const id = treeItem(tree, "id")

    await user.click(within(id).getByRole("button", { name: "Copy path" }))
    expect(await navigator.clipboard.readText()).toBe('response.parsed_body["posts"][0]["id"]')
    await user.click(within(treeItem(tree, "title")).getByRole("button", { name: "Copy value" }))
    expect(await navigator.clipboard.readText()).toBe('"Hi"')

    const [post] = within(treeItem(tree, "0")).getAllByRole("button", { name: "Copy value" })
    if (post === undefined) throw new Error("no Copy value control")
    await user.click(post)
    expect(await navigator.clipboard.readText()).toBe('{\n  "id": 1,\n  "title": "Hi"\n}')
  })

  test("shows a body that does not parse as raw, with Pretty disabled and a note saying why", async () => {
    await showBody('{"id":12,')

    expect(toggle("Pretty")).toBeDisabled()
    expect(toggle("Raw")).toBePressed()
    expect(
      within(detailPanel("Response")).getByText("This body isn't valid JSON, so it can only be shown as raw text."),
    ).toBeInTheDocument()
    expect(within(detailPanel("Response")).getByText('{"id":12,')).toBeInTheDocument()
  })

  test("shows a cut body as raw only, Pretty still there but disabled, and says how big the whole was", async () => {
    const cut = `{"items":[${'"x",'.repeat(10)}`
    await showBody(cut, { body: 200 * 1024 })

    expect(toggle("Pretty")).toBeDisabled()
    expect(toggle("Raw")).toBePressed()
    expect(
      within(detailPanel("Response")).getByText(
        "This response is 200 KB, and only the first 64 KB is shown. Because it's cut off, it can only be shown as raw text.",
      ),
    ).toBeInTheDocument()
    expect(within(detailPanel("Response")).getByText(wholeText(cut))).toBeInTheDocument()
  })

  test("strips a cut body's original size, not the size of what was kept", async () => {
    await showBody('{"id":', { body: 200 * 1024 }, 6)

    expect(
      within(detailPanel("Response")).getByText(wholeText("200 OK · application/json · 200.0 KB")),
    ).toBeInTheDocument()
  })
})
