/**
 * Whether a frame's path sits under the owning Run's `rails_root`. Exact prefix match on
 * `rails_root` plus a path separator, so a sibling directory like `app-worker` doesn't
 * count. `false` whenever `railsRoot` is `null` — never guessed.
 */
export function isHostFrame(frame: string, railsRoot: string | null): boolean {
  if (railsRoot === null) return false
  return frame.startsWith(`${railsRoot}/`)
}
