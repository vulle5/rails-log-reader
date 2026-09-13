import { WIRE_VERSION } from "./wire"

/**
 * Pure logic for the Initializer status banner: no filesystem, no `EventSource`, no process,
 * so it can be exercised the same way a fixture Sidecar drives the fold in `activity.ts`.
 */

/**
 * What `GET /initializer-status` answers: does the Host app's
 * `config/initializers/rails_log_reader.rb` exist, is it byte-identical to the Reader's own
 * `reader/rails/rails_log_reader.rb`, and is the Marker file there.
 */
export type InitializerFileStatus = {
  /**
   * `false` means the path does not exist at all. That is *not installed*, a separate empty
   * state — so `detectMismatch` treats it the same as "nothing to compare yet" rather than
   * as a mismatch to repair.
   */
  installed: boolean
  /** Byte-identical to the master copy. Meaningless when `installed` is `false`. */
  current: boolean
  /**
   * `log/rails_log_reader.enabled` exists. Says what the next boot will find and nothing
   * about the process running now, which read it once when it booted.
   */
  enabled: boolean
  /** Where the Reader's own master copy is, absolute — what *not installed*'s command copies. */
  masterPath: string
}

/**
 * The two mismatch kinds the Reader tells apart, named for the half of the product that is
 * wrong: the file on disk, or the process that already booted from it. `none` covers both
 * "no mismatch" and "nothing to compare yet" — the Reader stays silent either way, which is
 * what keeps a fresh page load from flashing a banner it cannot yet back up with a read.
 */
export type Mismatch = { kind: "none" } | { kind: "file_stale" } | { kind: "process_stale" }

/**
 * Combines the file diff with `v` off the live wire — the one signal a diff cannot produce,
 * because a diff can only ever see disk. Neither input alone can name a *stale process*: the
 * file diff cannot see what a running process has in memory, and `v` alone cannot see the
 * file before that process has ever booted from it.
 *
 * `file_stale` wins when both are true at once, because repairing it is the same first step
 * either way — copy the master in — and the file being wrong is the more specific thing to
 * say. Once the file reads current, a `v` behind `WIRE_VERSION` is exactly a stale
 * Initializer still loaded after the new one was copied in, which `file_stale` alone could
 * never surface: the file already reads clean.
 */
export function detectMismatch(
  file: InitializerFileStatus | null,
  liveWireVersion: number | null,
): Mismatch {
  if (file === null || !file.installed) return { kind: "none" }
  if (!file.current) return { kind: "file_stale" }
  if (liveWireVersion !== null && liveWireVersion < WIRE_VERSION) return { kind: "process_stale" }
  return { kind: "none" }
}

/**
 * Why the Reader has nothing to show, rather than leaving the developer guessing whether the
 * tool is broken. Three causes, each one command from the next, and told apart by reads
 * alone — the file, the Marker, and whether the load-on-open history held anything:
 *
 * - `not_installed` — no `config/initializers/rails_log_reader.rb`. Carries where the
 *   master copy is, because the command that resolves it copies from there.
 * - `not_enabled` — the Initializer is there and the Marker file is not.
 * - `idle` — both are there and nothing has been written. The Marker file is read once, at
 *   boot, so this is the state of a Rails process that booted before it existed as much as
 *   of one that has not booted at all; any process that boots with it writes a `run_header`
 *   at once, which is a row, which ends this state.
 */
export type EmptyState =
  | { kind: "not_installed"; masterPath: string }
  | { kind: "not_enabled" }
  | { kind: "idle" }

/**
 * `null` until both halves have answered: the files, and the Sidecar's load-on-open history.
 * Naming a cause over a history still on its way would flash one and take it back the moment
 * the rows landed — and a Sidecar left from before the Marker file was removed has rows to
 * land. Whether the Reader is actually empty is the caller's to say, because it holds the rows.
 */
export function detectEmptyState(file: InitializerFileStatus | null, historyLoaded: boolean): EmptyState | null {
  if (file === null || !historyLoaded) return null
  if (!file.installed) return { kind: "not_installed", masterPath: file.masterPath }
  if (!file.enabled) return { kind: "not_enabled" }
  return { kind: "idle" }
}
