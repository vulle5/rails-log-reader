import type { Mismatch } from "../shared/initializer-status"
import type { RepairState } from "./initializer-repair"

/**
 * #29's whole surface: a non-blocking banner naming which half of the Initializer is wrong
 * — the file on disk, or the process already running — and the one click that repairs
 * either. Rendered above the Reader's three columns rather than inside any of them, because
 * a mismatch is a fact about the *connection* to the Host app, not about anything any one
 * column shows.
 */
export function InitializerBanner({
  mismatch,
  repairState,
  onRepair,
  onDismiss,
}: {
  mismatch: Mismatch
  repairState: RepairState
  onRepair: () => void
  onDismiss: () => void
}) {
  // A confirmed repair is shown until dismissed even once the mismatch it was fixing has
  // resolved — which, the moment a fresh `run_id` arrives, it always has. Vanishing silently
  // the instant that happens would read as the banner never having meant anything.
  //
  // Gated on `mismatch.kind === "none"` too: a restart this stale can confirm is one Run,
  // and nothing stops a developer editing the file again, or a second stale process
  // restarting, inside the window before they click Dismiss. A *fresh* mismatch has to win
  // that race — showing "Restarted" over a live mismatch would be the banner lying about
  // the one thing it exists to report.
  if (repairState.phase === "restarted" && mismatch.kind === "none") {
    return (
      <div className="initializer-banner initializer-banner-ok" role="status">
        <p>Restarted — the new Initializer is loaded.</p>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    )
  }

  if (mismatch.kind === "none") return null

  return (
    <div className="initializer-banner initializer-banner-warn" role="alert">
      <p>{MISMATCH_MESSAGE[mismatch.kind]}</p>
      <RepairControl state={repairState} onRepair={onRepair} />
    </div>
  )
}

const MISMATCH_MESSAGE: Record<Exclude<Mismatch["kind"], "none">, string> = {
  file_stale:
    "config/initializers/rails_log_reader.rb does not match this Reader's own copy.",
  process_stale:
    "config/initializers/rails_log_reader.rb is current, but the Rails process running now booted with the old one.",
}

/**
 * #29's refusal case: `v` on an envelope is newer than `WIRE_VERSION`, a shape this Reader
 * has never read a line from. Rendered in place of the three columns rather than beside
 * them — the Reader has no way to know which of its own assumptions the unread part of that
 * shape would break, so it declines to guess through any of them rather than render
 * something that might be silently wrong.
 */
export function UnsupportedWireScreen({
  liveWireVersion,
  understoodVersion,
  repairState,
  onRepair,
}: {
  liveWireVersion: number
  understoodVersion: number
  repairState: RepairState
  onRepair: () => void
}) {
  return (
    <div className="unsupported-wire" role="alert">
      <h1>This Reader cannot read the running Initializer</h1>
      <p>
        The Rails process is writing wire version {liveWireVersion}; this Reader only understands up
        to version {understoodVersion}.
      </p>
      <p>
        Pull a newer Reader, or repair the Host app's copy back to this Reader's own — either fixes
        the mismatch.
      </p>
      <RepairControl state={repairState} onRepair={onRepair} />
    </div>
  )
}

function RepairControl({ state, onRepair }: { state: RepairState; onRepair: () => void }) {
  switch (state.phase) {
    case "idle":
    // A fresh mismatch arriving after a confirmed restart is `restarted` with somewhere new
    // to go: `InitializerBanner` only reaches this branch once `mismatch.kind` is no longer
    // "none", at which point the *previous* repair is done and there is nothing left for
    // this phase to say — so it offers the same `Repair` an `idle` mismatch would.
    case "restarted":
      return (
        <button type="button" onClick={onRepair}>
          Repair
        </button>
      )
    case "repairing":
      return (
        <button type="button" disabled>
          Repairing…
        </button>
      )
    case "failed":
      return (
        <>
          <p className="initializer-banner-error">Could not repair it: {state.error}</p>
          <button type="button" onClick={onRepair}>
            Try again
          </button>
        </>
      )
    case "awaiting-restart":
      return (
        <p>
          Copied. Restart Rails to load it
        </p>
      )
  }
}
