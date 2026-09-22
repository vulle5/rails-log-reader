import { describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"

import type { EmptyState } from "../src/shared/initializer-status"
import type { Envelope } from "../src/shared/wire"
import { aRun } from "./sidecar.fixtures"
import { activityRows, column, openTheReader } from "./reader.harness"

const MASTER = "/home/dev/rails-log-reader/reader/rails/rails_log_reader.rb"

/**
 * Seam 2 over #28's own prop: `emptyState` is exactly what `main.tsx` computes from a real
 * `/initializer-status` read and the Sidecar's `loaded` message, handed straight in — the
 * way #29's banner is tested — over a fold seeded from whatever envelopes the test gives.
 */
function theReader(emptyState: EmptyState | null, ...envelopes: Envelope[]) {
  return openTheReader(envelopes, { emptyState })
}

const EMPTY_SCREEN = { name: "Why the Activity table is empty" }

function theEmptyScreen() {
  return within(column("Activity table")).getByRole("status", EMPTY_SCREEN)
}

/** The one command a state names — and there is only ever one. */
function command() {
  const commands = within(theEmptyScreen()).getAllByRole("code")
  expect(commands).toHaveLength(1)
  return commands[0]?.textContent
}

describe("an empty Reader says why (#28)", () => {
  test("names a missing Initializer, and the command that copies it in", () => {
    theReader({ kind: "not_installed", masterPath: MASTER })

    expect(theEmptyScreen()).toHaveTextContent("not installed")
    expect(command()).toBe(`cp ${MASTER} config/initializers/rails_log_reader.rb`)
  })

  test("quotes a master copy whose path the shell would otherwise split", () => {
    theReader({ kind: "not_installed", masterPath: "/Users/dev/My Code/reader/rails/rails_log_reader.rb" })

    expect(command()).toBe(
      "cp '/Users/dev/My Code/reader/rails/rails_log_reader.rb' config/initializers/rails_log_reader.rb",
    )
  })

  test("names an Initializer that is not enabled, and the command that enables it", () => {
    theReader({ kind: "not_enabled" })

    expect(theEmptyScreen()).toHaveTextContent("not enabled")
    expect(command()).toBe("touch log/rails_log_reader.enabled")
  })

  test("names an enabled Initializer with nothing written yet, and the command that boots it", () => {
    theReader({ kind: "idle" })

    expect(theEmptyScreen()).toHaveTextContent("nothing has happened yet")
    expect(command()).toBe("bin/rails restart")
  })

  test("says three different things for the three causes", () => {
    const said = new Set<string | null>()
    for (const state of [{ kind: "not_installed", masterPath: MASTER }, { kind: "not_enabled" }, { kind: "idle" }] as const) {
      const { unmount } = theReader(state)
      said.add(within(theEmptyScreen()).getByRole("heading").textContent)
      unmount()
    }

    expect(said.size).toBe(3)
  })

  test("goes the moment there is a row to show, whatever the files said", () => {
    const rails = aRun("srv-1")
    theReader({ kind: "not_enabled" }, rails.header())

    expect(screen.queryByRole("status", EMPTY_SCREEN)).not.toBeInTheDocument()
    expect(activityRows()).toHaveLength(1)
  })

  test("says nothing while it does not know yet", () => {
    theReader(null)

    expect(screen.queryByRole("status", EMPTY_SCREEN)).not.toBeInTheDocument()
  })

  test("keeps the three columns, and the table's headings, around what it says", () => {
    theReader({ kind: "idle" })

    expect(screen.getAllByRole("region")).toHaveLength(3)
    expect(within(column("Activity table")).getAllByRole("columnheader").length).toBeGreaterThan(0)
  })
})
