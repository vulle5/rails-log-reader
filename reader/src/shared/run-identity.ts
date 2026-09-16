import type { Envelope, RunKind } from "./wire"

/**
 * Everything the live Run's own `run_header` said, latched. `null` until one has arrived —
 * which `isHostFrame`'s caller and the tab/header title both treat as "nothing to show yet",
 * the same reading `resolveAppName` already gave a `null` wire name.
 *
 * Read off the raw envelope stream rather than a folded `RunRow`/`RequestRow`, so these facts
 * survive the *Memory bound* evicting whichever row first carried them. See this repo's
 * `CONTEXT.md`, *Run identity* entry.
 */
export type RunIdentity = {
  railsRoot: string
  appName: string
  runKind: RunKind
  pid: number
  railsVersion: string
} | null

/**
 * Folds a batch of envelopes into the latched identity: the first `run_header` wins and is
 * held for the rest of the session, never reconsidered against a later Run's own header — a
 * Host app that renamed itself mid-session, or a second, differently-named Run sharing one
 * Sidecar, would otherwise make the tab title and header flicker between two answers to a
 * question the developer only ever asked once.
 */
export function latchRunIdentity(latched: RunIdentity, envelopes: readonly Envelope[]): RunIdentity {
  if (latched !== null) return latched

  const header = envelopes.find((envelope): envelope is Extract<Envelope, { type: "run_header" }> => envelope.type === "run_header")
  if (header === undefined) return null

  return {
    railsRoot: header.payload.rails_root,
    appName: header.payload.app_name,
    runKind: header.payload.kind,
    pid: header.payload.pid,
    railsVersion: header.payload.rails_version,
  }
}
