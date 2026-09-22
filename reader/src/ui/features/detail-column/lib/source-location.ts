/**
 * A *Source location*: a file and line the *Editor scheme* can be handed, found inside a raw
 * `"path:line:in `method'"` frame — a backtrace's, or a *Callsite*'s, which shares its shape.
 * `end` is where the frame's own `path:line` stops, which is the part of it that opens.
 */
export type SourceLocation = {
  readonly path: string
  readonly line: number
  readonly end: number
}

/**
 * The path is everything up to the first `:line` followed by `:in ` or by nothing, so a colon
 * inside the path itself stays part of it. `null` for a frame with no `:line`.
 */
export function parseFrame(frame: string): SourceLocation | null {
  const found = /^(.+?):(\d+)(?=:in |$)/.exec(frame)
  if (found === null) return null

  return { path: found[1]!, line: Number(found[2]), end: found[0].length }
}

/**
 * The frame's location, with a relative path resolved against `rails_root`. `null` where
 * there is nothing to open: no `:line`, a pseudo-path (`<internal:…>`, `(eval…)`, `<main>`),
 * or a relative path while `rails_root` is unknown — the path is never guessed.
 */
export function sourceLocation(frame: string, railsRoot: string | null): SourceLocation | null {
  const parsed = parseFrame(frame)
  if (parsed === null || /^[<(]/.test(parsed.path)) return null
  if (parsed.path.startsWith("/")) return parsed
  if (railsRoot === null) return null
  return { ...parsed, path: `${railsRoot}/${parsed.path}` }
}

/** `scheme` with `{path}` and, where it has one, `{line}` filled in from `location`. */
export function fillScheme(scheme: string, location: SourceLocation) {
  const path = location.path.split("/").map(encodeURIComponent).join("/")
  return scheme.replaceAll("{path}", path).replaceAll("{line}", String(location.line))
}
