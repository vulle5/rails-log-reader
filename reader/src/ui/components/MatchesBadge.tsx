/**
 * What *Search* found behind something folded away, a tab or a drawer, lit the way a match is.
 * The description of the control that opens it, by `id`, and never its name.
 */
export function MatchesBadge({ id, count }: { id: string; count: number }) {
  return (
    <span id={id} className="rounded-xs bg-match px-1 text-2xs text-foreground tabular-nums" aria-hidden="true">
      {count === 1 ? "1 match" : `${count} matches`}
    </span>
  )
}
