import type { ReactNode } from "react"

/** How many *Search* matches, in words: `1 match`, `3 matches`. */
function matchesText(count: number) {
  return count === 1 ? "1 match" : `${count} matches`
}

/**
 * What *Search* found behind something folded away, a tab or a drawer, lit the way a match is.
 * The description of the control that opens it, by `id`, and never its name.
 */
export function MatchesBadge({ id, count }: { id: string; count: number }) {
  return (
    <span id={id} className="rounded-xs bg-match px-1 text-2xs text-foreground tabular-nums" aria-hidden="true">
      {matchesText(count)}
    </span>
  )
}

/**
 * A fold's line while the developer holds it folded over `count` matches, which only their own
 * fold leaves: lit, and counting the matches inside, but not itself a match.
 */
export function FoldedOverMatches({ count, children }: { count: number; children: ReactNode }) {
  return (
    <span className="rounded-xs bg-match" data-lit>
      {children}
      {` · ${matchesText(count)}`}
    </span>
  )
}
