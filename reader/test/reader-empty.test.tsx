import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { EmptyState } from "../src/shared/initializer-status"
import { aRun } from "./sidecar.fixtures"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")
const { activityTable } = await import("../src/shared/activity")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { unmount: () => void }[] = []

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount()
  })
  document.body.innerHTML = ""
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const MASTER = "/home/dev/rails-log-reader/reader/rails/rails_log_reader.rb"

/**
 * Seam 2 over #28's own prop: `emptyState` is exactly what `main.tsx` computes from a real
 * `/initializer-status` read and the Sidecar's `loaded` message, handed straight in — the
 * way #29's banner is tested — over a fold seeded from whatever envelopes the test gives.
 */
async function theReader(emptyState: EmptyState | null, ...envelopes: Parameters<ReturnType<typeof activityTable>["fold"]>[0]) {
  const activity = activityTable()
  activity.fold(envelopes)

  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => {
    const root = createRoot(container)
    mounted.push(root)
    root.render(<Reader rows={activity.rows} emptyState={emptyState} />)
  })
  return container
}

function emptyScreen(container: HTMLElement) {
  return container.querySelector('[aria-label="Activity table"] .empty-state')
}

function theEmptyScreen(container: HTMLElement) {
  const found = emptyScreen(container)
  if (found === null) throw new Error("the Activity table is not saying why it is empty")
  return found
}

/** The one command a state names — and there is only ever one. */
function command(container: HTMLElement) {
  const commands = theEmptyScreen(container).querySelectorAll("code.empty-command")
  expect(commands).toHaveLength(1)
  return commands[0]?.textContent
}

describe("an empty Reader says why (#28)", () => {
  test("names a missing Initializer, and the command that copies it in", async () => {
    const container = await theReader({ kind: "not_installed", masterPath: MASTER })

    expect(theEmptyScreen(container).textContent).toContain("not installed")
    expect(command(container)).toBe(`cp ${MASTER} config/initializers/rails_log_reader.rb`)
  })

  test("quotes a master copy whose path the shell would otherwise split", async () => {
    const container = await theReader({ kind: "not_installed", masterPath: "/Users/dev/My Code/reader/rails/rails_log_reader.rb" })

    expect(command(container)).toBe(
      "cp '/Users/dev/My Code/reader/rails/rails_log_reader.rb' config/initializers/rails_log_reader.rb",
    )
  })

  test("names an Initializer that is not enabled, and the command that enables it", async () => {
    const container = await theReader({ kind: "not_enabled" })

    expect(theEmptyScreen(container).textContent).toContain("not enabled")
    expect(command(container)).toBe("touch log/rails_log_reader.enabled")
  })

  test("names an enabled Initializer with nothing written yet, and the command that boots it", async () => {
    const container = await theReader({ kind: "idle" })

    expect(theEmptyScreen(container).textContent).toContain("nothing has happened yet")
    expect(command(container)).toBe("bin/rails restart")
  })

  test("says three different things for the three causes", async () => {
    const said = new Set<string | null>()
    for (const state of [{ kind: "not_installed", masterPath: MASTER }, { kind: "not_enabled" }, { kind: "idle" }] as const) {
      const container = await theReader(state)
      said.add(theEmptyScreen(container).querySelector("h3")?.textContent ?? null)
    }

    expect(said.size).toBe(3)
  })

  test("goes the moment there is a row to show, whatever the files said", async () => {
    const rails = aRun("srv-1")
    const container = await theReader({ kind: "not_enabled" }, rails.header())

    expect(emptyScreen(container)).toBeNull()
    expect(container.querySelectorAll(".activity-row")).toHaveLength(1)
  })

  test("says nothing while it does not know yet", async () => {
    const container = await theReader(null)

    expect(emptyScreen(container)).toBeNull()
  })

  test("keeps the three columns, and the table's headings, around what it says", async () => {
    const container = await theReader({ kind: "idle" })

    expect(container.querySelectorAll("[role='region']")).toHaveLength(3)
    expect(container.querySelectorAll("table.activity thead th").length).toBeGreaterThan(0)
  })
})
