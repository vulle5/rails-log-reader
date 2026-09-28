import { describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import { type RequestRoutePayload, WIRE_VERSION } from "../src/shared/wire"
import { aRun } from "./sidecar.fixtures"
import { AWKWARD_PARAMS, DENSE_TRAFFIC, NEVER_ROUTED, SERVER_RUN } from "./traffic.fixtures"
import {
  column,
  detailPanel,
  detailTab,
  detailTabBar,
  openTheReader,
  select,
  showDetailTab,
  timeline,
  treeItem,
  treeItemsOf,
  valueTree,
} from "./reader.harness"

/**
 * The *Detail tab* bar and the Params tab, reached the way a developer reaches them: the
 * Reader over the seed, a row clicked, then Params. What the tree holds is read off the tree
 * a screen reader would walk, never off the value tree the viewer was handed.
 */

/** Each item is named by its own line: `key: value`, or `key: {…} N keys` for a folded node. */
function expectLines(items: readonly HTMLElement[], lines: readonly (string | RegExp)[]) {
  expect(items).toHaveLength(lines.length)
  lines.forEach((line, at) => expect(items[at]).toHaveAccessibleName(line))
}

describe("the Detail tab bar", () => {
  test("sits under a request's header as Timeline | Params | Headers | Response, with Timeline showing", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, AWKWARD_PARAMS.path)

    const tabs = within(detailTabBar()).getAllByRole("tab")
    expect(tabs).toHaveLength(4)
    expect(tabs[0]).toHaveTextContent(/^Timeline$/)
    expect(tabs[1]).toHaveTextContent(/^Params$/)
    expect(tabs[2]).toHaveTextContent(/^Headers$/)
    expect(tabs[3]).toHaveTextContent(/^Response$/)
    expect(detailTab("Timeline")).toHaveAttribute("aria-selected", "true")
    expect(detailTab("Params")).toHaveAttribute("aria-selected", "false")
    expect(detailPanel("Timeline")).toContainElement(timeline())
  })

  test("shows the params when Params is clicked, and the timeline again on Timeline", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, AWKWARD_PARAMS.path)

    await showDetailTab(user, "Params")

    expect(detailTab("Params")).toHaveAttribute("aria-selected", "true")
    expect(detailPanel("Params")).toContainElement(valueTree("Params"))
    expect(within(column("Detail column")).queryByRole("list", { name: "Timeline" })).not.toBeInTheDocument()

    await showDetailTab(user, "Timeline")

    expect(detailPanel("Timeline")).toContainElement(timeline())
  })

  test("disables Params for a request that never reached a controller", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, NEVER_ROUTED.path)

    expect(detailTab("Params")).toBeDisabled()
    expect(detailTab("Timeline")).toHaveAttribute("aria-selected", "true")
  })

  test("draws no bar at all for a Run row", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, "server")

    expect(within(column("Detail column")).queryByRole("tablist", { name: "Detail tabs" })).not.toBeInTheDocument()
    expect(timeline()).toBeInTheDocument()
  })

  test("keeps the chosen tab across a change of Selection", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts/12"),
      run.route("req-1", "PostsController", "show", { id: "12" }),
      run.start("req-2", "GET", "/posts/13"),
      run.route("req-2", "PostsController", "show", { id: "13" }),
    ])
    await select(user, "/posts/12")
    await showDetailTab(user, "Params")

    await select(user, "/posts/13")

    expect(detailTab("Params")).toHaveAttribute("aria-selected", "true")
    expectLines(treeItemsOf(valueTree("Params")), ['id: "13"'])
  })

  test("falls back to Timeline on a row with no Params, and comes back to Params on the next one that has them", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, AWKWARD_PARAMS.path)
    await showDetailTab(user, "Params")

    await select(user, NEVER_ROUTED.path)
    expect(detailTab("Timeline")).toHaveAttribute("aria-selected", "true")
    expect(detailPanel("Timeline")).toContainElement(timeline())

    await select(user, AWKWARD_PARAMS.path)
    expect(detailTab("Params")).toHaveAttribute("aria-selected", "true")
  })

  test("moves between tabs with the arrow keys, skipping a disabled one", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, AWKWARD_PARAMS.path)

    detailTab("Timeline").focus()
    await user.keyboard("{ArrowRight}")

    expect(detailTab("Params")).toHaveFocus()
    expect(detailTab("Params")).toHaveAttribute("aria-selected", "true")

    await select(user, NEVER_ROUTED.path)
    detailTab("Timeline").focus()
    await user.keyboard("{ArrowRight}")

    expect(detailTab("Headers")).toHaveFocus()
  })
})

describe("the Params tab", () => {
  async function showParams() {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, AWKWARD_PARAMS.path)
    await showDetailTab(user, "Params")
    return { user, tree: valueTree("Params") }
  }

  test("opens the top level, keys in the order they arrived, controller, action and format kept", async () => {
    const { tree } = await showParams()

    expectLines(treeItemsOf(tree), [
      'cart_id: "77213"',
      "order: {…} 5 keys",
      "payment_token: FILTERED",
      'format: "json"',
      'controller: "api/v1/orders"',
      'action: "create"',
    ])
  })

  test("folds every nested hash and array to a summary of what it holds", async () => {
    const { user, tree } = await showParams()
    const order = treeItem(tree, "order")

    expect(order).toHaveAttribute("aria-expanded", "false")
    expect(treeItemsOf(order)).toEqual([])

    await user.click(order)

    expect(order).toHaveAttribute("aria-expanded", "true")
    expectLines(treeItemsOf(order), [
      'currency: "EUR"',
      "shipping: {…} 2 keys",
      "line_items: […] 2 items",
      /^gift_note: "Happy birthday!/,
      "coupon_code: null",
    ])
    expect(treeItem(order, "shipping")).toHaveAttribute("aria-expanded", "false")
    expect(treeItem(order, "line_items")).toHaveAttribute("aria-expanded", "false")
  })

  test("draws an open hash or array between its brackets, the opening one on its own line", async () => {
    const { user, tree } = await showParams()
    const order = treeItem(tree, "order")

    await user.click(order)

    expect(order).toHaveAccessibleName("order: {")
    expect(order).toHaveTextContent(/}$/)

    const items = treeItem(order, "line_items")
    await user.click(items)

    expect(items).toHaveAccessibleName("line_items: [")
    expect(items).toHaveTextContent(/]$/)
  })

  test("leaves an open hash open when its closing bracket is clicked", async () => {
    const { user, tree } = await showParams()
    const order = treeItem(tree, "order")
    await user.click(order)

    await user.click(within(order).getByText("}"))

    expect(order).toHaveAttribute("aria-expanded", "true")
  })

  test("draws an empty hash or array as its brackets, with nothing to open", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts"),
      run.route("req-1", "PostsController", "index", { pairs: [["filters", { pairs: [] }], ["ids", []]] }),
    ])
    await select(user, "/posts")
    await showDetailTab(user, "Params")
    const tree = valueTree("Params")

    expectLines(treeItemsOf(tree), ["filters: {}", "ids: []"])
    expect(treeItem(tree, "filters")).not.toHaveAttribute("aria-expanded")

    await user.click(treeItem(tree, "ids"))

    expect(treeItem(tree, "ids")).not.toHaveAttribute("aria-expanded")
  })

  test("labels an array's items by their index, and folds a hash inside one", async () => {
    const { user, tree } = await showParams()
    const order = treeItem(tree, "order")
    await user.click(order)
    const items = treeItem(order, "line_items")

    await user.click(items)

    expectLines(treeItemsOf(items), ["0: {…} 3 keys", "1: {…} 4 keys"])
    await user.click(treeItem(items, "1"))
    expectLines(treeItemsOf(treeItem(items, "1")), [
      'sku: "MUG-01"',
      "quantity: 1",
      'price_cents: "1200"',
      "gift_wrap: true",
    ])
  })

  test("closes an open node on a second click, and keeps what was opened inside it", async () => {
    const { user, tree } = await showParams()
    const order = treeItem(tree, "order")
    await user.click(order)
    await user.click(treeItem(order, "shipping"))

    await user.click(order)

    expect(order).toHaveAttribute("aria-expanded", "false")
    expect(treeItemsOf(order)).toEqual([])

    await user.click(order)

    expect(treeItem(order, "shipping")).toHaveAttribute("aria-expanded", "true")
  })

  test("toggles only the node clicked, never the one holding it", async () => {
    const { user, tree } = await showParams()
    const order = treeItem(tree, "order")
    await user.click(order)

    await user.click(treeItem(order, "currency"))
    await user.click(treeItem(order, "shipping"))

    expect(order).toHaveAttribute("aria-expanded", "true")
    expect(treeItem(order, "shipping")).toHaveAttribute("aria-expanded", "true")
  })

  test("keeps what was opened across a trip to Timeline and back", async () => {
    const { user, tree } = await showParams()
    await user.click(treeItem(tree, "order"))

    await showDetailTab(user, "Timeline")
    await showDetailTab(user, "Params")

    expect(treeItem(valueTree("Params"), "order")).toHaveAttribute("aria-expanded", "true")
  })

  test("starts folded again for the next Selection", async () => {
    const run = aRun(SERVER_RUN)
    const params = { post: { title: "Hello" } }
    const { user } = openTheReader([
      run.start("req-1", "GET", "/posts/12"),
      run.route("req-1", "PostsController", "update", params),
      run.start("req-2", "GET", "/posts/13"),
      run.route("req-2", "PostsController", "update", params),
    ])
    await select(user, "/posts/12")
    await showDetailTab(user, "Params")
    await user.click(treeItem(valueTree("Params"), "post"))

    await select(user, "/posts/13")

    expect(treeItem(valueTree("Params"), "post")).toHaveAttribute("aria-expanded", "false")
  })

  test("says a request routed with no params has none", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([run.start("req-1", "GET", "/health"), run.route("req-1", "HealthController", "show")])
    await select(user, "/health")
    await showDetailTab(user, "Params")

    expect(detailPanel("Params")).toHaveTextContent(/^\{\}$/)
  })
})

describe("the Value viewer's leaves", () => {
  const LONG_STRING = 80

  async function showOrder() {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, AWKWARD_PARAMS.path)
    await showDetailTab(user, "Params")
    const tree = valueTree("Params")
    const order = treeItem(tree, "order")
    await user.click(order)
    return { user, tree, order }
  }

  test("marks each leaf with the type it has on the wire, so a form's numeric string is a string", async () => {
    const { user, tree, order } = await showOrder()
    const items = treeItem(order, "line_items")
    await user.click(items)
    await user.click(treeItem(items, "0"))
    await user.click(treeItem(items, "1"))

    expect(within(treeItem(tree, "cart_id")).getByText('"77213"')).toHaveAttribute("data-token", "string")
    expect(within(treeItem(items, "0")).getByText('"2"')).toHaveAttribute("data-token", "string")
    expect(within(treeItem(items, "1")).getByText("1")).toHaveAttribute("data-token", "number")
    expect(within(treeItem(items, "1")).getByText("true")).toHaveAttribute("data-token", "keyword")
  })

  test("sets null apart from the string \"null\"", async () => {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "PATCH", "/posts/12"),
      run.route("req-1", "PostsController", "update", { absent: null, spelled: "null" }),
    ])
    await select(user, "/posts/12")
    await showDetailTab(user, "Params")
    const tree = valueTree("Params")

    expect(within(treeItem(tree, "absent")).getByText("null")).toHaveAttribute("data-token", "null")
    expect(within(treeItem(tree, "spelled")).getByText('"null"')).toHaveAttribute("data-token", "string")
  })

  test("draws a filtered value as a FILTERED marker, not as a string", async () => {
    const { tree } = await showOrder()
    const token = treeItem(tree, "payment_token")

    expect(token).toHaveAccessibleName("payment_token: FILTERED")
    expect(within(token).getByText("FILTERED")).toHaveAttribute("data-filtered")
  })

  test("cuts a string over 80 characters to its first 80 and says how many more there are", async () => {
    const { order } = await showOrder()
    const note = AWKWARD_PARAMS.params.order.gift_note
    const more = note.length - LONG_STRING

    const item = treeItem(order, "gift_note")

    expect(item).toHaveAccessibleName(`gift_note: "${note.slice(0, LONG_STRING)} …${more} more chars`)
    expect(within(item).getByText(`"${note.slice(0, LONG_STRING)}`)).toHaveAttribute("data-cut")
  })

  test("counts an escape as the one character it stands for, and never cuts one in half", async () => {
    const run = aRun(SERVER_RUN)
    const body = `${"a".repeat(79)}\n"quoted" and on 🎉`
    const { user } = openTheReader([
      run.start("req-1", "POST", "/notes"),
      run.route("req-1", "NotesController", "create", { body }),
    ])
    await select(user, "/notes")
    await showDetailTab(user, "Params")
    const characters = Array.from(body)
    const shown = JSON.stringify(characters.slice(0, LONG_STRING).join("")).slice(0, -1)

    expect(treeItem(valueTree("Params"), "body")).toHaveAccessibleName(
      `body: ${shown} …${characters.length - LONG_STRING} more chars`,
    )
  })

  test("leaves a string of exactly 80 characters whole", async () => {
    const run = aRun(SERVER_RUN)
    const exact = "x".repeat(LONG_STRING)
    const { user } = openTheReader([
      run.start("req-1", "POST", "/notes"),
      run.route("req-1", "NotesController", "create", { body: exact }),
    ])
    await select(user, "/notes")
    await showDetailTab(user, "Params")

    expect(treeItem(valueTree("Params"), "body")).toHaveAccessibleName(`body: "${exact}"`)
  })

  test("opens a cut string on a click of its count, and keeps it whole", async () => {
    const { user, tree, order } = await showOrder()
    const note = AWKWARD_PARAMS.params.order.gift_note

    await user.click(within(treeItem(order, "gift_note")).getByRole("button", { name: `…${note.length - LONG_STRING} more chars` }))

    expect(order).toHaveAttribute("aria-expanded", "true")
    expect(treeItem(order, "gift_note")).toHaveAccessibleName(`gift_note: ${JSON.stringify(note)}`)

    await user.click(order)
    await user.click(order)

    const reopened = treeItem(treeItem(tree, "order"), "gift_note")
    expect(reopened).toHaveAccessibleName(`gift_note: ${JSON.stringify(note)}`)
    expect(within(reopened).queryByRole("button", { name: /more chars/ })).not.toBeInTheDocument()
  })
})

describe("the Params tab's key order", () => {
  async function showParams(params: RequestRoutePayload["params"], v = WIRE_VERSION) {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "POST", "/orders"),
      { ...run.route("req-1", "OrdersController", "create", params), v },
    ])
    await select(user, "/orders")
    await showDetailTab(user, "Params")
    return { user, tree: valueTree("Params") }
  }

  test("keeps integer-like keys in the order the app had them", async () => {
    const { user, tree } = await showParams({
      pairs: [["quantities", { pairs: [["42", "1"], ["7", "2"]] }]],
    })
    const quantities = treeItem(tree, "quantities")
    await user.click(quantities)

    expectLines(treeItemsOf(quantities), ['42: "1"', '7: "2"'])
  })

  test("keeps a word key ahead of an integer-like one when it came first", async () => {
    const { tree } = await showParams({ pairs: [["name", "Ada"], ["5", "five"]] })

    expectLines(treeItemsOf(tree), ['name: "Ada"', '5: "five"'])
  })

  test("draws an array of two-element arrays as arrays, not as a hash", async () => {
    const { user, tree } = await showParams({ pairs: [["a", [["x", "y"]]]] })
    const a = treeItem(tree, "a")
    await user.click(a)
    const first = treeItem(a, "0")
    await user.click(first)

    expect(a).toHaveAccessibleName(/^a: /)
    expectLines(treeItemsOf(first), ['0: "x"', '1: "y"'])
  })

  test("still draws a v3 envelope's params, a plain object", async () => {
    const { user, tree } = await showParams({ id: "12", post: { title: "Hello" } }, 3)
    const post = treeItem(tree, "post")
    await user.click(post)

    expectLines(treeItemsOf(tree), ['id: "12"', /^post: /])
    expectLines(treeItemsOf(post), ['title: "Hello"'])
  })
})

/**
 * Copying out of the *Value viewer*: what lands on the clipboard is read back off the clipboard,
 * and each control is found by its role and name, the way assistive technology finds it.
 */
describe("copying params", () => {
  async function showParams(params: RequestRoutePayload["params"] = { pairs: [] }) {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([
      run.start("req-1", "POST", "/comments"),
      run.route("req-1", "CommentsController", "create", params),
    ])
    await select(user, "/comments")
    await showDetailTab(user, "Params")
    return { user, tree: valueTree("Params") }
  }

  /** A node's own copy control: the first under its item, ahead of any its open children hold. */
  function copyControl(item: HTMLElement, name: "Copy value" | "Copy path") {
    const [own] = within(item).getAllByRole("button", { name })
    if (own === undefined) throw new Error(`no ${name} control`)
    return own
  }

  test("copies the whole params as JSON that parses back to the params", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, AWKWARD_PARAMS.path)
    await showDetailTab(user, "Params")

    await user.click(within(detailPanel("Params")).getByRole("button", { name: "Copy params" }))

    expect(JSON.parse(await navigator.clipboard.readText())).toEqual(AWKWARD_PARAMS.params)
  })

  test("copies the whole params in the order the tree holds them, integer-like keys included", async () => {
    const { user } = await showParams({ pairs: [["name", "Ada"], ["42", "1"], ["7", "2"]] })

    await user.click(within(detailPanel("Params")).getByRole("button", { name: "Copy params" }))

    expect(await navigator.clipboard.readText()).toBe('{\n  "name": "Ada",\n  "42": "1",\n  "7": "2"\n}')
  })

  test("offers a copy of a hovered node's value, as that node's JSON", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, AWKWARD_PARAMS.path)
    await showDetailTab(user, "Params")
    const order = treeItem(valueTree("Params"), "order")
    await user.click(order)
    const items = treeItem(order, "line_items")
    await user.click(items)

    await user.hover(treeItem(items, "1"))
    await user.click(copyControl(treeItem(items, "1"), "Copy value"))

    expect(JSON.parse(await navigator.clipboard.readText())).toEqual(AWKWARD_PARAMS.params.order.line_items[1])
  })

  test("copies a leaf's value as its JSON, so a string keeps its quotes and a filtered value is the text Rails left", async () => {
    const { user, tree } = await showParams({
      pairs: [["id", "48"], ["count", 3], ["password", "[FILTERED]"], ["gone", null]],
    })

    await user.click(copyControl(treeItem(tree, "id"), "Copy value"))
    expect(await navigator.clipboard.readText()).toBe('"48"')
    await user.click(copyControl(treeItem(tree, "count"), "Copy value"))
    expect(await navigator.clipboard.readText()).toBe("3")
    await user.click(copyControl(treeItem(tree, "password"), "Copy value"))
    expect(await navigator.clipboard.readText()).toBe('"[FILTERED]"')
    await user.click(copyControl(treeItem(tree, "gone"), "Copy value"))
    expect(await navigator.clipboard.readText()).toBe("null")
  })

  test("offers a copy of a hovered node's path, symbol keys for a hash and indices for an array", async () => {
    const { user, tree } = await showParams({
      pairs: [["comment", { pairs: [["tags", ["ruby", "rails"]]] }]],
    })
    const comment = treeItem(tree, "comment")
    await user.click(comment)
    const tags = treeItem(comment, "tags")
    await user.click(tags)

    await user.hover(treeItem(tags, "0"))
    await user.click(copyControl(treeItem(tags, "0"), "Copy path"))

    expect(await navigator.clipboard.readText()).toBe("params[:comment][:tags][0]")
  })

  test("quotes a symbol key that is no bare Ruby symbol", async () => {
    const { user, tree } = await showParams({
      pairs: [["quantities", { pairs: [["42", "1"]] }], ["data-id", "7"], ["ok?", true]],
    })
    const quantities = treeItem(tree, "quantities")
    await user.click(quantities)

    await user.click(copyControl(treeItem(quantities, "42"), "Copy path"))
    expect(await navigator.clipboard.readText()).toBe('params[:quantities][:"42"]')
    await user.click(copyControl(treeItem(tree, "data-id"), "Copy path"))
    expect(await navigator.clipboard.readText()).toBe('params[:"data-id"]')
    await user.click(copyControl(treeItem(tree, "ok?"), "Copy path"))
    expect(await navigator.clipboard.readText()).toBe("params[:ok?]")
  })

  test("reaches a node's copy controls from the keyboard, each described by the node's line", async () => {
    const { user, tree } = await showParams({ pairs: [["id", "48"]] })
    const id = treeItem(tree, "id")

    await user.click(within(detailPanel("Params")).getByRole("button", { name: "Copy params" }))
    await user.tab()
    expect(copyControl(id, "Copy value")).toHaveFocus()
    expect(copyControl(id, "Copy value")).toHaveAccessibleDescription('id: "48"')
    await user.tab()
    expect(copyControl(id, "Copy path")).toHaveFocus()
    expect(copyControl(id, "Copy path")).toHaveAccessibleDescription('id: "48"')
  })

  test("leaves a node folded or open as it was when a copy on its line is clicked or pressed", async () => {
    const { user, tree } = await showParams({ pairs: [["comment", { pairs: [["body", "Hi"]] }]] })
    const comment = treeItem(tree, "comment")

    await user.click(copyControl(comment, "Copy value"))
    expect(comment).toHaveAttribute("aria-expanded", "false")
    await user.tab()
    expect(copyControl(comment, "Copy path")).toHaveFocus()
    await user.keyboard("{Enter}")

    expect(comment).toHaveAttribute("aria-expanded", "false")
    expect(await navigator.clipboard.readText()).toBe("params[:comment]")
  })

  test("says a copy happened", async () => {
    const { user, tree } = await showParams({ pairs: [["id", "48"]] })

    await user.click(copyControl(treeItem(tree, "id"), "Copy path"))

    expect(copyControl(treeItem(tree, "id"), "Copy path")).toHaveTextContent("Copied")
  })
})
