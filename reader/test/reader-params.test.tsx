import { describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

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
  test("sits under a request's header as Timeline | Params, with Timeline showing", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, AWKWARD_PARAMS.path)

    const tabs = within(detailTabBar()).getAllByRole("tab")
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveTextContent(/^Timeline$/)
    expect(tabs[1]).toHaveTextContent(/^Params$/)
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

    expect(detailTab("Timeline")).toHaveFocus()
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
      'payment_token: "[FILTERED]"',
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
