import { WIRE_VERSION } from "./wire"

/**
 * Whether the Reader can safely read an envelope carrying this `v`.
 *
 * `WIRE_VERSION` is bumped only when a field's meaning changes, so every envelope at or
 * below the Reader's own version is a shape this file already knows how to fold — including
 * an older one, which is simply what a *stale* Initializer still loaded after a restart
 * looks like on the wire (#29). A `v` above it names a shape from an Initializer newer than
 * this Reader has ever read a line from: guessing through it is how a future field silently
 * renders wrong, so #29 draws the line here instead — this is the one and only condition
 * the Reader refuses to render over.
 */
export function isWireVersionUnderstood(v: number): boolean {
  return v <= WIRE_VERSION
}
