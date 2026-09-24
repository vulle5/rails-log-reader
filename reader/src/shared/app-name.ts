/**
 * The Host app's display name — `MyApp — Rails log reader` in the tab, `MyApp` in the
 * *Reader bar*. `null` until `RunIdentity` has latched one off a `run_header`, or the
 * developer set `RAILS_LOG_READER_APP_NAME`, which is when both places show the generic
 * "Rails log reader" fallback instead.
 *
 * The latching itself — read off the raw envelope stream rather than a folded
 * `RunRow.appName`, so the name survives the *Memory bound* evicting whichever Run row first
 * carried it — is `RunIdentity`'s, in `./run-identity`: `appName` is one of the five fields
 * that arrive on the same `run_header`, and this file is left with only the one concern
 * `RunIdentity` cannot have an opinion about, the env-var override.
 */

/**
 * `RAILS_LOG_READER_APP_NAME` wins over the wire's own name, unconditionally and for the life
 * of the process, whenever it is set — there is nothing on the Host-app side to reconcile it
 * against, unlike the Marker file's presence.
 */
export function resolveAppName(override: string | null, latchedWireName: string | null): string | null {
  return override ?? latchedWireName
}
