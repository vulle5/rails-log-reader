import { describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"

import { activityRows, column, consoleLines, openTheReader } from "./reader.harness"

describe("opening the Reader", () => {
  test("lays out the Console, the Activity table and the Detail column, in that order", () => {
    openTheReader()

    const regions = screen.getAllByRole("region")

    expect(regions).toHaveLength(3)
    expect(regions[0]).toHaveAccessibleName("Console")
    expect(regions[1]).toHaveAccessibleName("Activity table")
    expect(regions[2]).toHaveAccessibleName("Detail column")
  })

  test("heads each column with the name the glossary gives it", () => {
    openTheReader()

    for (const name of ["Console", "Activity table", "Detail column"] as const) {
      expect(within(column(name)).getByRole("heading", { level: 2 })).toHaveTextContent(name)
    }
  })

  test("shows the Console empty, because nothing is captured yet", () => {
    openTheReader()

    // The rail itself is present with no lines in it, for the reason the Activity table is
    // present with no rows: the first line of the session must not be what introduces the
    // column's contents and pushes the layout around.
    expect(within(column("Console")).getByRole("list")).toBeInTheDocument()
    expect(consoleLines()).toHaveLength(0)
  })

  test("offers every level chip before there is a single line to thin", () => {
    openTheReader()

    const levels = within(column("Console")).getByRole("group", { name: "Filter by level" })
    expect(within(levels).getAllByRole("button")).toHaveLength(6)
  })

  test("opens with Rails' own lines off, and says so on the chip rather than silently", () => {
    openTheReader()
    const sources = within(column("Console")).getByRole("group", { name: "Filter by source" })
    const [rails] = within(sources).getAllByRole("button")

    // The Console is thinned from the first paint, which is a thing it has to admit to: a
    // rail quietly not showing what it holds is indistinguishable from a rail that is broken.
    // `aria-pressed` is also what the stylesheet strikes an off chip through by.
    expect(rails).toHaveTextContent("rails")
    expect(rails).toHaveAttribute("aria-pressed", "false")
  })

  test("heads the Activity table with its columns before there is a single row to put under them", () => {
    openTheReader()

    expect(within(column("Activity table")).getAllByRole("columnheader").length).toBeGreaterThan(0)
    expect(activityRows()).toHaveLength(0)
  })

  test("holds the Detail column open on a placeholder, so selecting never reflows the layout", () => {
    openTheReader()

    expect(within(column("Detail column")).getByText(/Nothing selected/)).toBeInTheDocument()
  })
})

describe("the Host app's name in the title and the reader-bar (#95)", () => {
  function readerBar() {
    // The column headings are `header`s too, but inside their sections, so only this one is
    // the page's banner — and the only one the Settings trigger sits in.
    const bar = screen
      .getAllByRole("banner")
      .find((banner) => within(banner).queryByRole("button", { name: "Settings" }) !== null)
    if (bar === undefined) throw new Error("the Reader has no reader-bar")
    return bar
  }

  test("shows the generic fallback in both places before any Run has said anything", () => {
    openTheReader()

    expect(within(readerBar()).getByText("Rails log reader")).toBeInTheDocument()
    expect(document.title).toBe("Rails log reader")
  })

  test("shows the Host app's own name in both places once one is known", () => {
    openTheReader([], { appName: "MyApp" })

    expect(within(readerBar()).getByText("MyApp")).toBeInTheDocument()
    expect(document.title).toBe("MyApp — Rails log reader")
  })

  test("the header label sits beside the search box and the theme switch, as plain text with no icon", () => {
    openTheReader([], { appName: "MyApp" })
    const bar = readerBar()

    // Plain text: the label holds no element at all, so no icon either.
    expect(within(bar).getByText("MyApp").childElementCount).toBe(0)
    expect(within(bar).getByRole("searchbox")).toBeInTheDocument()
    // The theme switch sits behind the Settings dialog, which is closed until asked for.
    expect(within(bar).getByRole("group", { name: "Theme", hidden: true })).toBeInTheDocument()
  })
})
