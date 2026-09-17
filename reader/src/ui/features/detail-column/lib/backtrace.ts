/**
 * Whether a frame's path sits under the owning Run's `rails_root`. Exact prefix match on
 * `rails_root` plus a path separator, so a sibling directory like `app-worker` doesn't
 * count. `false` whenever `railsRoot` is `null` — never guessed.
 */
export function isHostFrame(frame: string, railsRoot: string | null): boolean {
  if (railsRoot === null) return false
  return frame.startsWith(`${railsRoot}/`)
}

/** One rendered position in a backtrace: either a frame shown in place, or a contiguous
 * run of non-Host-app frames collapsed behind one marker at that position. */
export type BacktraceSegment =
  | { readonly type: "frame"; readonly index: number; readonly frame: string; readonly host: boolean }
  | { readonly type: "gap"; readonly from: number; readonly frames: readonly string[] }

/**
 * Splits a backtrace into what the Detail column renders directly and what it collapses.
 * `backtrace[0]` — Ruby's own guarantee of the raise site — is always its own frame segment,
 * whatever `isHostFrame` says about it: collapsing it away by the same rule that hides
 * `ActiveSupport`'s dispatch chain would defeat the column on its most common case, a
 * `NoMethodError` several frames inside a gem. Every other non-Host-app frame joins the gap
 * segment it is contiguous with, rather than one marker for the whole trace, because call
 * order is the one fact a stack trace exists to carry.
 */
export function segmentBacktrace(backtrace: readonly string[], railsRoot: string | null): readonly BacktraceSegment[] {
  const [raised, ...rest] = backtrace
  if (raised === undefined) return []

  const segments: BacktraceSegment[] = [
    { type: "frame", index: 0, frame: raised, host: isHostFrame(raised, railsRoot) },
  ]

  let gapFrom: number | null = null
  let gapFrames: string[] = []

  const flushGap = () => {
    if (gapFrom === null) return
    segments.push({ type: "gap", from: gapFrom, frames: gapFrames })
    gapFrom = null
    gapFrames = []
  }

  for (const [at, frame] of rest.entries()) {
    const index = at + 1
    if (isHostFrame(frame, railsRoot)) {
      flushGap()
      segments.push({ type: "frame", index, frame, host: true })
    } else {
      if (gapFrom === null) gapFrom = index
      gapFrames.push(frame)
    }
  }
  flushGap()

  return segments
}
