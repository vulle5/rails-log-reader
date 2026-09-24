import type { ComponentProps } from "react"

import type { Mismatch } from "../../../../shared/initializer-status"
import type { RepairState } from "../lib/initializer-repair"
import { cn } from "../../../lib/cn"

/**
 * A non-blocking banner naming which half of the Initializer is wrong
 * — the file on disk, or the process already running — and the one click that repairs
 * either. Rendered above the Reader's three columns rather than inside any of them, because
 * a mismatch is a fact about the *connection* to the Host app, not about anything any one
 * column shows. Not styled as an error even in its warning colour: nothing is broken, and the
 * Reader stays a read-only tail outside the one click this offers.
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
      <Banner className="bg-accent/14 text-foreground" role="status">
        <p>Restarted — the new Initializer is loaded.</p>
        <BannerButton onClick={onDismiss}>Dismiss</BannerButton>
      </Banner>
    )
  }

  if (mismatch.kind === "none") return null

  return (
    <Banner className="bg-warn/14 text-warn" role="alert">
      <p>{MISMATCH_MESSAGE[mismatch.kind]}</p>
      <RepairControl state={repairState} onRepair={onRepair} place="banner" />
    </Banner>
  )
}

function Banner({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-none items-center gap-3 border-b border-border px-4 py-2 text-sm", className)} {...props} />
}

/** In the browser's own button font, which Preflight would replace with the inherited one. */
function BannerButton(props: Omit<ComponentProps<"button">, "type" | "className">) {
  return (
    <button
      type="button"
      className="flex-none cursor-pointer rounded border border-border bg-raised px-2.5 py-0.75 text-sm text-foreground [font-family:revert] disabled:cursor-default disabled:opacity-60"
      {...props}
    />
  )
}

const MISMATCH_MESSAGE: Record<Exclude<Mismatch["kind"], "none">, string> = {
  file_stale:
    "config/initializers/rails_log_reader.rb does not match this Reader's own copy.",
  process_stale:
    "config/initializers/rails_log_reader.rb is current, but the Rails process running now booted with the old one.",
}

/**
 * The refusal case: `v` on an envelope is newer than `WIRE_VERSION`, a shape this Reader
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
    // A readable measure. The top padding is a fifth of the width, as a percentage padding always is.
    <div className="mx-auto flex h-full max-w-[60ch] flex-col items-start gap-2.5 px-5 pt-[20%]" role="alert">
      <h1 className="text-lg font-bold">This Reader cannot read the running Initializer</h1>
      <p className="text-muted">
        The Rails process is writing wire version {liveWireVersion}; this Reader only understands up
        to version {understoodVersion}.
      </p>
      <p className="text-muted">
        Pull a newer Reader, or repair the Host app's copy back to this Reader's own — either fixes
        the mismatch.
      </p>
      <RepairControl state={repairState} onRepair={onRepair} place="screen" />
    </div>
  )
}

/**
 * What it says is coloured by where it sits: in the banner, a failed repair alone turns to the
 * error colour; on the refusal screen, everything stays as muted as the text around it.
 */
function RepairControl({
  state,
  onRepair,
  place,
}: {
  state: RepairState
  onRepair: () => void
  place: "banner" | "screen"
}) {
  switch (state.phase) {
    case "idle":
    // A fresh mismatch arriving after a confirmed restart is `restarted` with somewhere new
    // to go: `InitializerBanner` only reaches this branch once `mismatch.kind` is no longer
    // "none", at which point the *previous* repair is done and there is nothing left for
    // this phase to say — so it offers the same `Repair` an `idle` mismatch would.
    case "restarted":
      return (
        <BannerButton onClick={onRepair}>Repair</BannerButton>
      )
    case "repairing":
      return (
        <BannerButton disabled>Repairing…</BannerButton>
      )
    case "failed":
      return (
        <>
          <p className={place === "banner" ? "text-error" : "text-muted"}>Could not repair it: {state.error}</p>
          <BannerButton onClick={onRepair}>Try again</BannerButton>
        </>
      )
    case "awaiting-restart":
      return (
        <p className={place === "screen" ? "text-muted" : undefined}>
          Copied. Restart Rails to load it
        </p>
      )
  }
}
