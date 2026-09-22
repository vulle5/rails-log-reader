import { afterEach, describe, expect, test } from "bun:test"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")
const { WIRE_VERSION } = await import("../src/shared/wire")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ""
})

/**
 * Seam 2 again, this time over #29's own props rather than a seeded fold: `mismatch`,
 * `liveWireVersion` and `repairState` are exactly what `main.tsx` would compute from a real
 * `/initializer-status` read and a real `EventSource`, handed straight in so the banner and
 * the refusal screen are tested as the pure renders they are.
 */
async function mount(element: React.ReactElement) {
  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => createRoot(container).render(element))
  return container
}

function banner(container: HTMLElement) {
  const region = container.querySelector(".initializer-banner")
  if (region === null) throw new Error("no Initializer banner is showing")
  return region
}

function button(region: Element) {
  const found = region.querySelector("button")
  if (found === null) throw new Error(`no button inside ${region.className}`)
  return found
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

describe("the Initializer mismatch banner (#29)", () => {
  test("shows nothing when there is no mismatch to report", async () => {
    const container = await mount(<Reader rows={[]} />)

    expect(container.querySelector(".initializer-banner")).toBeNull()
  })

  test("names the file when it does not match the Reader's own master copy", async () => {
    const container = await mount(<Reader rows={[]} mismatch={{ kind: "file_stale" }} />)

    expect(banner(container).textContent).toContain("rails_log_reader.rb")
    expect(button(banner(container)).textContent).toBe("Repair")
  })

  test("names the process — a stale Initializer still loaded — when the file is already current", async () => {
    const container = await mount(<Reader rows={[]} mismatch={{ kind: "process_stale" }} />)

    expect(banner(container).textContent).toContain("booted with the old one")
  })

  test("surfaces a mismatch without blocking the three columns — the banner is additive, not a refusal", async () => {
    for (const kind of ["file_stale", "process_stale"] as const) {
      const container = await mount(<Reader rows={[]} mismatch={{ kind }} />)

      expect(banner(container)).not.toBeNull()
      expect(container.querySelectorAll("[role='region']")).toHaveLength(3)
    }
  })

  test("clicking Repair calls the handler once", async () => {
    let calls = 0
    const container = await mount(
      <Reader rows={[]} mismatch={{ kind: "file_stale" }} onRepair={() => (calls += 1)} />,
    )

    await click(button(banner(container)))

    expect(calls).toBe(1)
  })

  test("a repair in flight disables the button and says so, rather than allowing a second click", async () => {
    const container = await mount(
      <Reader rows={[]} mismatch={{ kind: "file_stale" }} repairState={{ phase: "repairing" }} />,
    )

    const disabled = button(banner(container))
    expect(disabled.textContent).toBe("Repairing…")
    expect(disabled.hasAttribute("disabled")).toBe(true)
  })

  test("a failed repair names the error and offers to try again", async () => {
    const container = await mount(
      <Reader
        rows={[]}
        mismatch={{ kind: "file_stale" }}
        repairState={{ phase: "failed", error: "EACCES: permission denied" }}
      />,
    )

    expect(banner(container).textContent).toContain("EACCES: permission denied")
    expect(button(banner(container)).textContent).toBe("Try again")
  })

  test("a completed copy prompts for a restart instead of offering the button again", async () => {
    const container = await mount(
      <Reader rows={[]} mismatch={{ kind: "process_stale" }} repairState={{ phase: "awaiting-restart" }} />,
    )

    expect(banner(container).textContent).toContain("Restart Rails")
    expect(banner(container).querySelector("button")).toBeNull()
  })

  test("a confirmed restart replaces the mismatch with a dismissable confirmation", async () => {
    // The mismatch itself has already resolved to "none" by the time a fresh `run_id`
    // confirms the restart — the confirmation is shown from `repairState` alone.
    const container = await mount(<Reader rows={[]} mismatch={{ kind: "none" }} repairState={{ phase: "restarted" }} />)

    expect(banner(container).textContent).toContain("Restarted")
    expect(button(banner(container)).textContent).toBe("Dismiss")
  })

  test("a fresh mismatch wins over a lingering confirmation, rather than being hidden behind it", async () => {
    // A developer can edit the file again, or a second process can go stale, inside the
    // window before a "Restarted" confirmation is dismissed. Showing "Restarted" over that
    // would be the banner lying about the one thing it exists to report.
    const container = await mount(
      <Reader rows={[]} mismatch={{ kind: "file_stale" }} repairState={{ phase: "restarted" }} />,
    )

    expect(banner(container).textContent).not.toContain("Restarted")
    expect(banner(container).textContent).toContain("rails_log_reader.rb")
    // And still repairable: `restarted` behaves like `idle` once a new mismatch has moved in.
    expect(button(banner(container)).textContent).toBe("Repair")
  })

  test("dismissing the confirmation calls the handler", async () => {
    let dismissed = false
    const container = await mount(
      <Reader
        rows={[]}
        mismatch={{ kind: "none" }}
        repairState={{ phase: "restarted" }}
        onDismissRepair={() => (dismissed = true)}
      />,
    )

    await click(button(banner(container)))

    expect(dismissed).toBe(true)
  })
})

describe("the wire-version refusal (#29)", () => {
  test("renders the three columns as usual once nothing has been observed yet", async () => {
    const container = await mount(<Reader rows={[]} />)

    expect(container.querySelectorAll("[role='region']")).toHaveLength(3)
  })

  test("renders as usual for a version older than this Reader's own — an ordinary stale process", async () => {
    const container = await mount(<Reader rows={[]} liveWireVersion={WIRE_VERSION - 1} />)

    expect(container.querySelectorAll("[role='region']")).toHaveLength(3)
  })

  test("refuses to render the three columns when the live version is newer than this Reader understands", async () => {
    const container = await mount(<Reader rows={[]} liveWireVersion={WIRE_VERSION + 1} />)

    expect(container.querySelectorAll("[role='region']")).toHaveLength(0)
    expect(container.querySelector(".unsupported-wire")?.textContent).toContain(String(WIRE_VERSION + 1))
  })

  test("the refusal screen still offers the repair that would fix it", async () => {
    let calls = 0
    const container = await mount(
      <Reader rows={[]} liveWireVersion={WIRE_VERSION + 1} onRepair={() => (calls += 1)} />,
    )

    await click(button(container.querySelector(".unsupported-wire") as Element))

    expect(calls).toBe(1)
  })
})
