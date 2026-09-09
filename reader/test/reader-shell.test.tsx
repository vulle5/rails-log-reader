import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

import { afterAll, afterEach, describe, expect, test } from "bun:test"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")

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

async function openTheReader() {
  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => createRoot(container).render(<Reader />))
  return container
}

function column(container: HTMLElement, name: string) {
  const region = container.querySelector(`[aria-label="${name}"]`)
  if (region === null) throw new Error(`the Reader has no ${name}`)
  return region
}

function body(region: Element) {
  const content = region.querySelector(".column-body")
  if (content === null) throw new Error(`${region.getAttribute("aria-label")} has no content area`)
  return content
}

describe("opening the Reader", () => {
  test("lays out the Console, the Activity table and the Detail column, in that order", async () => {
    const container = await openTheReader()

    const labels = [...container.querySelectorAll("[role='region']")].map((region) =>
      region.getAttribute("aria-label"),
    )

    expect(labels).toEqual(["Console", "Activity table", "Detail column"])
  })

  test("heads each column with the name the glossary gives it", async () => {
    const container = await openTheReader()

    for (const name of ["Console", "Activity table", "Detail column"]) {
      expect(column(container, name).querySelector("h2")?.textContent).toBe(name)
    }
  })

  test("shows the Console empty, because nothing is captured yet", async () => {
    const container = await openTheReader()

    // The rail itself is present with no lines in it, for the reason the Activity table is
    // present with no rows: the first line of the session must not be what introduces the
    // column's contents and pushes the layout around.
    expect(body(column(container, "Console")).querySelector(".console-lines")).not.toBeNull()
    expect(container.querySelectorAll(".console-line")).toHaveLength(0)
  })

  test("offers every level chip before there is a single line to thin", async () => {
    const container = await openTheReader()

    expect(column(container, "Console").querySelectorAll("[aria-label='Filter by level'] button")).toHaveLength(6)
  })

  test("heads the Activity table with its columns before there is a single row to put under them", async () => {
    const container = await openTheReader()
    const table = body(column(container, "Activity table")).querySelector("table.activity")

    expect(table?.querySelectorAll("thead th").length).toBeGreaterThan(0)
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(0)
  })

  test("holds the Detail column open on a placeholder, so selecting never reflows the layout", async () => {
    const container = await openTheReader()

    expect(body(column(container, "Detail column")).textContent).toContain("Nothing selected")
  })
})
