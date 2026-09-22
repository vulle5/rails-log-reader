import { describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"

import { WIRE_VERSION } from "../src/shared/wire"
import { openTheReader } from "./reader.harness"

/**
 * Seam 2 again, this time over #29's own props rather than a seeded fold: `mismatch`,
 * `liveWireVersion` and `repairState` are exactly what `main.tsx` would compute from a real
 * `/initializer-status` read and a real `EventSource`, handed straight in so the banner and
 * the refusal screen are tested as the pure renders they are.
 */

/** A mismatch is an `alert`; the confirmation that replaces it once repaired, a `status`. */
function banner() {
  const found = screen.queryByRole("alert") ?? screen.queryByRole("status")
  if (found === null) throw new Error("no Initializer banner is showing")
  return found
}

function button(region: HTMLElement) {
  return within(region).getByRole("button")
}

describe("the Initializer mismatch banner (#29)", () => {
  test("shows nothing when there is no mismatch to report", () => {
    openTheReader()

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  test("names the file when it does not match the Reader's own master copy", () => {
    openTheReader([], { mismatch: { kind: "file_stale" } })

    expect(banner()).toHaveTextContent("rails_log_reader.rb")
    expect(button(banner())).toHaveTextContent(/^Repair$/)
  })

  test("names the process — a stale Initializer still loaded — when the file is already current", () => {
    openTheReader([], { mismatch: { kind: "process_stale" } })

    expect(banner()).toHaveTextContent("booted with the old one")
  })

  test("surfaces a mismatch without blocking the three columns — the banner is additive, not a refusal", () => {
    for (const kind of ["file_stale", "process_stale"] as const) {
      const { unmount } = openTheReader([], { mismatch: { kind } })

      expect(banner()).toBeInTheDocument()
      expect(screen.getAllByRole("region")).toHaveLength(3)
      unmount()
    }
  })

  test("clicking Repair calls the handler once", async () => {
    let calls = 0
    const { user } = openTheReader([], { mismatch: { kind: "file_stale" }, onRepair: () => (calls += 1) })

    await user.click(button(banner()))

    expect(calls).toBe(1)
  })

  test("a repair in flight disables the button and says so, rather than allowing a second click", () => {
    openTheReader([], { mismatch: { kind: "file_stale" }, repairState: { phase: "repairing" } })

    const disabled = button(banner())
    expect(disabled).toHaveTextContent(/^Repairing…$/)
    expect(disabled).toBeDisabled()
  })

  test("a failed repair names the error and offers to try again", () => {
    openTheReader([], {
      mismatch: { kind: "file_stale" },
      repairState: { phase: "failed", error: "EACCES: permission denied" },
    })

    expect(banner()).toHaveTextContent("EACCES: permission denied")
    expect(button(banner())).toHaveTextContent(/^Try again$/)
  })

  test("a completed copy prompts for a restart instead of offering the button again", () => {
    openTheReader([], { mismatch: { kind: "process_stale" }, repairState: { phase: "awaiting-restart" } })

    expect(banner()).toHaveTextContent("Restart Rails")
    expect(within(banner()).queryByRole("button")).not.toBeInTheDocument()
  })

  test("a confirmed restart replaces the mismatch with a dismissable confirmation", () => {
    // The mismatch itself has already resolved to "none" by the time a fresh `run_id`
    // confirms the restart — the confirmation is shown from `repairState` alone.
    openTheReader([], { mismatch: { kind: "none" }, repairState: { phase: "restarted" } })

    expect(banner()).toHaveTextContent("Restarted")
    expect(button(banner())).toHaveTextContent(/^Dismiss$/)
  })

  test("a fresh mismatch wins over a lingering confirmation, rather than being hidden behind it", () => {
    // A developer can edit the file again, or a second process can go stale, inside the
    // window before a "Restarted" confirmation is dismissed. Showing "Restarted" over that
    // would be the banner lying about the one thing it exists to report.
    openTheReader([], { mismatch: { kind: "file_stale" }, repairState: { phase: "restarted" } })

    expect(banner()).not.toHaveTextContent("Restarted")
    expect(banner()).toHaveTextContent("rails_log_reader.rb")
    // And still repairable: `restarted` behaves like `idle` once a new mismatch has moved in.
    expect(button(banner())).toHaveTextContent(/^Repair$/)
  })

  test("dismissing the confirmation calls the handler", async () => {
    let dismissed = false
    const { user } = openTheReader([], {
      mismatch: { kind: "none" },
      repairState: { phase: "restarted" },
      onDismissRepair: () => (dismissed = true),
    })

    await user.click(button(banner()))

    expect(dismissed).toBe(true)
  })
})

describe("the wire-version refusal (#29)", () => {
  test("renders the three columns as usual once nothing has been observed yet", () => {
    openTheReader()

    expect(screen.getAllByRole("region")).toHaveLength(3)
  })

  test("renders as usual for a version older than this Reader's own — an ordinary stale process", () => {
    openTheReader([], { liveWireVersion: WIRE_VERSION - 1 })

    expect(screen.getAllByRole("region")).toHaveLength(3)
  })

  test("refuses to render the three columns when the live version is newer than this Reader understands", () => {
    openTheReader([], { liveWireVersion: WIRE_VERSION + 1 })

    expect(screen.queryAllByRole("region")).toHaveLength(0)
    expect(screen.getByRole("alert")).toHaveTextContent(String(WIRE_VERSION + 1))
  })

  test("the refusal screen still offers the repair that would fix it", async () => {
    let calls = 0
    const { user } = openTheReader([], { liveWireVersion: WIRE_VERSION + 1, onRepair: () => (calls += 1) })

    await user.click(button(screen.getByRole("alert")))

    expect(calls).toBe(1)
  })
})
