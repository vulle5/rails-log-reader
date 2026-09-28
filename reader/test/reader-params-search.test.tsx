import { describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import type { RequestRoutePayload } from "../src/shared/wire"
import { aRun } from "./sidecar.fixtures"
import { AWKWARD_PARAMS, DENSE_TRAFFIC, SERVER_RUN } from "./traffic.fixtures"
import { detailTab, lit, openTheReader, search, select, showDetailTab, treeItem, valueTree, wholeText } from "./reader.harness"

/**
 * *Search* inside the *Value viewer*, driven the way a developer drives it: a term typed into
 * the search box with Params showing, and what the tree opens and lights read off the tree.
 */

const LONG_STRING = 80

async function showAwkwardParams() {
  const { user } = openTheReader(DENSE_TRAFFIC)
  await select(user, AWKWARD_PARAMS.path)
  await showDetailTab(user, "Params")
  return { user, tree: valueTree("Params") }
}

async function showParams(params: RequestRoutePayload["params"]) {
  const run = aRun(SERVER_RUN)
  const { user } = openTheReader([run.start("req-1", "POST", "/notes"), run.route("req-1", "NotesController", "create", params)])
  await select(user, "/notes")
  await showDetailTab(user, "Params")
  return { user, tree: valueTree("Params") }
}

describe("Search in the Value viewer", () => {
  test("opens every node down to a deep match, and leaves its matchless siblings folded", async () => {
    const { user, tree } = await showAwkwardParams()

    await search(user, "mannerheim")

    const order = treeItem(tree, "order")
    const shipping = treeItem(order, "shipping")
    const address = treeItem(shipping, "address")
    expect(order).toHaveAttribute("aria-expanded", "true")
    expect(shipping).toHaveAttribute("aria-expanded", "true")
    expect(address).toHaveAttribute("aria-expanded", "true")
    expect(lit(treeItem(address, "line1"))).toEqual(["Mannerheim"])
    expect(treeItem(address, "geo")).toHaveAttribute("aria-expanded", "false")
    expect(treeItem(order, "line_items")).toHaveAttribute("aria-expanded", "false")
    expect(lit(tree)).toEqual(["Mannerheim"])
  })

  test("lights a key and a value each on its own", async () => {
    const { user, tree } = await showAwkwardParams()

    await search(user, "cart")
    expect(lit(tree)).toEqual(["cart"])

    await search(user, "77213")
    expect(lit(treeItem(tree, "cart_id"))).toEqual(["77213"])
  })

  test("never lights a term that spans a key and its value", async () => {
    const { user, tree } = await showAwkwardParams()

    await search(user, 'cart_id: "77213"')

    expect(lit(tree)).toEqual([])
  })

  test("matches a string with its quotes, and a filtered value as its marker's word", async () => {
    const { user, tree } = await showAwkwardParams()

    await search(user, '"json"')
    expect(lit(tree)).toEqual(['"json"'])

    await search(user, "FILTERED")
    expect(lit(treeItem(tree, "payment_token"))).toEqual(["FILTERED"])

    await search(user, "[FILTERED]")
    expect(lit(tree)).toEqual([])
  })

  test("never lights an array's indices, or opens a node for one", async () => {
    const { user, tree } = await showParams({ pairs: [["tags", ["a", "b", "c"]]] })

    await search(user, "0")

    expect(treeItem(tree, "tags")).toHaveAttribute("aria-expanded", "false")
    expect(lit(tree)).toEqual([])
  })

  test("never lights a folded node's summary", async () => {
    const { user, tree } = await showParams({ pairs: [["tags", ["a", "b", "c"]]] })

    await search(user, "3 items")

    expect(treeItem(tree, "tags")).toHaveAccessibleName("tags: […] 3 items")
    expect(lit(tree)).toEqual([])
  })

  test("never lights a cut string's count", async () => {
    const { user, tree } = await showParams({ pairs: [["body", "a".repeat(LONG_STRING + 10)]] })

    await search(user, "10 more")

    expect(within(treeItem(tree, "body")).getByRole("button", { name: "…10 more chars" })).toBeInTheDocument()
    expect(lit(tree)).toEqual([])
  })

  test("shows a string whole while the term matches past its cut, and cuts it again after", async () => {
    const { user, tree } = await showAwkwardParams()
    const note = AWKWARD_PARAMS.params.order.gift_note

    await search(user, "mug")

    const giftNote = treeItem(treeItem(tree, "order"), "gift_note")
    expect(giftNote).toHaveAccessibleName(`gift_note: ${JSON.stringify(note)}`)
    expect(lit(giftNote)).toEqual(["mug"])

    await search(user, "happy")

    const cut = treeItem(treeItem(tree, "order"), "gift_note")
    expect(within(cut).getByRole("button", { name: `…${note.length - LONG_STRING} more chars` })).toBeInTheDocument()
    expect(lit(cut)).toEqual(["Happy"])
  })

  test("folds back what it opened when the term is cleared, and keeps what the developer opened", async () => {
    const { user, tree } = await showAwkwardParams()
    await user.click(treeItem(tree, "order"))

    await search(user, "mannerheim")
    await search(user, "")

    const order = treeItem(tree, "order")
    expect(order).toHaveAttribute("aria-expanded", "true")
    expect(treeItem(order, "shipping")).toHaveAttribute("aria-expanded", "false")
  })

  test("folds back what it opened when the term changes to one matching elsewhere", async () => {
    const { user, tree } = await showAwkwardParams()

    await search(user, "mannerheim")
    await search(user, "MUG-01")

    const order = treeItem(tree, "order")
    expect(treeItem(order, "shipping")).toHaveAttribute("aria-expanded", "false")
    expect(treeItem(order, "line_items")).toHaveAttribute("aria-expanded", "true")
    expect(treeItem(treeItem(order, "line_items"), "0")).toHaveAttribute("aria-expanded", "false")
    expect(treeItem(treeItem(order, "line_items"), "1")).toHaveAttribute("aria-expanded", "true")
  })

  test("keeps a node the developer folds folded while the term holds, lit and counting the matches inside", async () => {
    const { user, tree } = await showAwkwardParams()
    await search(user, "00")

    const shipping = treeItem(treeItem(tree, "order"), "shipping")
    await user.click(shipping)

    expect(shipping).toHaveAttribute("aria-expanded", "false")
    expect(shipping).toHaveAccessibleName("shipping: {…} 2 keys · 2 matches")
    expect(within(shipping).getByText(wholeText("{…} 2 keys · 2 matches"))).toHaveAttribute("data-lit")
    expect(lit(shipping)).toEqual([])
  })

  test("opens the developer's fold again once the term changes", async () => {
    const { user, tree } = await showAwkwardParams()
    await search(user, "mannerheim")
    await user.click(treeItem(treeItem(tree, "order"), "shipping"))

    await search(user, "mannerheimintie")

    expect(treeItem(treeItem(tree, "order"), "shipping")).toHaveAttribute("aria-expanded", "true")
  })

  test("keeps a node open after the term clears once the developer folds and opens it again", async () => {
    const { user, tree } = await showAwkwardParams()
    await search(user, "mannerheim")
    const shipping = treeItem(treeItem(tree, "order"), "shipping")
    await user.click(shipping)
    await user.click(shipping)

    await search(user, "")

    expect(treeItem(tree, "order")).toHaveAttribute("aria-expanded", "false")
    await user.click(treeItem(tree, "order"))
    expect(treeItem(treeItem(tree, "order"), "shipping")).toHaveAttribute("aria-expanded", "true")
  })
})

describe("the Params tab's count of Search matches", () => {
  async function onTimeline(params: RequestRoutePayload["params"]) {
    const run = aRun(SERVER_RUN)
    const { user } = openTheReader([run.start("req-1", "POST", "/notes"), run.route("req-1", "NotesController", "create", params)])
    await select(user, "/notes")
    return { user }
  }

  test("counts exactly the matches the Value viewer lights on opening Params", async () => {
    const { user } = openTheReader(DENSE_TRAFFIC)
    await select(user, AWKWARD_PARAMS.path)
    await search(user, "00")

    await showDetailTab(user, "Params")
    const lighted = lit(valueTree("Params")).length
    await showDetailTab(user, "Timeline")

    expect(lighted).toBeGreaterThan(1)
    expect(detailTab("Params")).toHaveAccessibleName("Params")
    expect(detailTab("Params")).toHaveAccessibleDescription(`${lighted} matches`)
  })

  test("counts a key and a value each on its own, and says one match as one", async () => {
    const { user } = await onTimeline({ pairs: [["title", "a title"]] })

    await search(user, "title")
    expect(detailTab("Params")).toHaveAccessibleDescription("2 matches")

    await search(user, "a t")
    expect(detailTab("Params")).toHaveAccessibleDescription("1 match")
  })

  test("never counts what the viewer draws of its own: an index, a summary", async () => {
    const { user } = await onTimeline({ pairs: [["tags", ["a", "b", "c"]]] })

    await search(user, "0")
    expect(detailTab("Params")).not.toHaveAccessibleDescription()

    await search(user, "3 items")
    expect(detailTab("Params")).not.toHaveAccessibleDescription()
  })

  test("is absent with no term, and with a term matching nothing in the params", async () => {
    const { user } = await onTimeline({ pairs: [["title", "a title"]] })

    expect(detailTab("Params")).not.toHaveAccessibleDescription()

    await search(user, "notes")
    expect(detailTab("Params")).not.toHaveAccessibleDescription()

    await search(user, "title")
    await search(user, "")
    expect(detailTab("Params")).not.toHaveAccessibleDescription()
  })

  test("is absent while Params is the tab showing, and back on Timeline", async () => {
    const { user } = await onTimeline({ pairs: [["title", "a title"]] })
    await search(user, "title")

    await showDetailTab(user, "Params")
    expect(detailTab("Params")).not.toHaveAccessibleDescription()

    await showDetailTab(user, "Timeline")
    expect(detailTab("Params")).toHaveAccessibleDescription("2 matches")
  })
})
