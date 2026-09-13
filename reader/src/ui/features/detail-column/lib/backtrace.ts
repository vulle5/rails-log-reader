/**
 * Whether a backtrace frame is the Host app's own code, rather than a gem, the stdlib, or
 * anything else Ruby happened to walk through on the way to raising. Exact, not a
 * string-shape heuristic: a frame qualifies if and only if its path starts with the owning
 * Run's `rails_root` plus a path separator — so `/home/dev/app/app/models/order.rb` counts
 * and `/home/dev/app-worker/order.rb` does not, a sibling directory that merely shares the
 * prefix.
 *
 * `railsRoot` is `null` for a Run whose `run_header` was never observed — the Reader
 * attached mid-stream — and every frame then answers `false` rather than being guessed at,
 * the same call already made for the Run marker and a `status` the Reader never saw.
 */
export function isHostFrame(frame: string, railsRoot: string | null): boolean {
  if (railsRoot === null) return false
  return frame.startsWith(`${railsRoot}/`)
}
