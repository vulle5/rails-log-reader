import { useId } from "react"

import type { Severity } from "../../shared/wire"
import { cn } from "../lib/cn"
import { MatchesBadge } from "./Matches"

/**
 * One filter chip, on or off — the shape `ConsoleFilters` and `DetailFilters` both draw
 * their thinning controls from, so a second one never grows its own copy of what "off" looks
 * like. "Off" is read from `aria-pressed`, the one place it is said. `kind` and not `named`
 * picks the chip's colour, because a chip's label is free text (`debug`, `rails`, `schema`)
 * while what colours it is a fixed, small set.
 */

export type ChipKind = `level-${Severity}` | "source-rails" | "cache" | "schema"

export type ChipProps = {
  named: string
  kind: ChipKind
  showing: boolean
  title: string
  /** How many of its kind there are, on or off. Absent on a chip that does not count. */
  count?: number
  /** How many *Search* matches lie inside what it would hide. Said only while it is off. */
  matches?: number
  onToggle: () => void
}

/**
 * Off is an outline with nothing in it, struck through, rather than a chip that has merely
 * gone quiet — the difference between "no warnings" and "warnings hidden" is the one thing
 * this control must never blur. It is the same mark whichever axis is off, because "hidden" is
 * the same fact about a column either way — and the Console's `rails` chip wears it from the
 * first paint, which is how the Console says it is not showing everything it holds.
 *
 * Its count, when it has one, follows its name on or off. Off over *Search* matches, a lit
 * segment at its end counts them in words (`2 matches`), as its description, the way a *Detail
 * tab*'s badge describes its tab. On, there is no segment: the matches are lit where they are shown.
 */
export function Chip({ named, kind, showing, title, count, matches = 0, onToggle }: ChipProps) {
  const badge = useId()
  const found = showing ? 0 : matches

  return (
    <button
      type="button"
      aria-pressed={showing}
      aria-describedby={found > 0 ? badge : undefined}
      className={cn(
        "cursor-pointer rounded-chip border border-border bg-selected px-1.25 py-px font-mono text-2xs tracking-wide text-foreground",
        // The chip's colour while on. Off, every kind is the same `faint`.
        kind === "level-warn" && "text-warn",
        (kind === "level-error" || kind === "level-fatal") && "text-error",
        "aria-[pressed=false]:bg-transparent aria-[pressed=false]:text-faint aria-[pressed=false]:line-through",
        // The match segment runs to the chip's right edge.
        found > 0 && "pr-0",
      )}
      title={title}
      onClick={onToggle}
    >
      {named}
      {count !== undefined && (
        <>
          {" "}
          <span className="text-muted tabular-nums">{count}</span>
        </>
      )}
      {/* Inline-block, so the off chip's strike stops at its edge. */}
      {found > 0 && (
        <MatchesBadge className="ml-1.25 inline-block rounded-none border-l border-border" id={badge} count={found} />
      )}
    </button>
  )
}
