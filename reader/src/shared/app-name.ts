import type { Envelope } from "./wire"

/**
 * The Host app's display name — `MyApp — Rails log reader` in the tab, `MyApp` in the
 * `reader-bar` header. `null` until the first `run_header` has said one, or the developer set
 * `RAILS_LOG_READER_APP_NAME`, which is when both places show the generic "Rails log reader"
 * fallback instead.
 *
 * Read off the raw envelope stream rather than a folded `RunRow.appName`, so the name survives
 * the *Memory bound* evicting whichever Run row first carried it — the same reason
 * `liveWireVersion` and `liveRunId` are read off the latest envelope rather than off a row.
 */

/**
 * Folds a batch of envelopes into the latched name: the first non-null value wins and is held
 * for the rest of the session, never reconsidered against a later Run's own `run_header` —
 * a Host app that renamed itself mid-session, or a second, differently-named Run sharing one
 * Sidecar, would otherwise make the tab title and header flicker between two answers to a
 * question the developer only ever asked once.
 */
export function latchAppName(latched: string | null, envelopes: readonly Envelope[]): string | null {
  if (latched !== null) return latched

  const header = envelopes.find((envelope): envelope is Extract<Envelope, { type: "run_header" }> => envelope.type === "run_header")
  return header?.payload.app_name ?? latched
}

/**
 * `RAILS_LOG_READER_APP_NAME` wins over the wire's own name, unconditionally and for the life
 * of the process, whenever it is set — there is nothing on the Host-app side to reconcile it
 * against, unlike the Marker file's presence.
 */
export function resolveAppName(override: string | null, latchedWireName: string | null): string | null {
  return override ?? latchedWireName
}
