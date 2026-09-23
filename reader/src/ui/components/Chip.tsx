import type { Severity } from "../../shared/wire"

/**
 * One filter chip, on or off — the shape `ConsoleFilters` and `DetailFilters` both draw
 * their thinning controls from, so a second one never grows its own copy of what "off" looks
 * like. "Off" is read from `aria-pressed`, the one place it is said. `kind` and not `named`
 * picks the chip's colour, because a chip's label is free text (`debug`, `rails`, `schema`)
 * while what colours it is a fixed, small set.
 */

export type ChipKind = `level-${Severity}` | "source-rails" | "schema"

export type ChipProps = {
  named: string
  kind: ChipKind
  showing: boolean
  title: string
  onToggle: () => void
}

/** The chip's colour while on. Off, every kind is the same `faint`. */
const KIND_TEXT: Partial<Record<ChipKind, string>> = {
  "level-warn": "text-warn",
  "level-error": "text-error",
  "level-fatal": "text-error",
}

/**
 * Off is an outline with nothing in it, struck through, rather than a chip that has merely
 * gone quiet — the difference between "no warnings" and "warnings hidden" is the one thing
 * this control must never blur. It is the same mark whichever axis is off, because "hidden" is
 * the same fact about a column either way — and the Console's `rails` chip wears it from the
 * first paint, which is how the Console says it is not showing everything it holds.
 */
export function Chip({ named, kind, showing, title, onToggle }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={showing}
      className={`cursor-pointer rounded-chip border border-border bg-selected px-1.25 py-px font-mono text-2xs tracking-wide ${KIND_TEXT[kind] ?? "text-foreground"} aria-[pressed=false]:bg-transparent aria-[pressed=false]:text-faint aria-[pressed=false]:line-through`}
      title={title}
      onClick={onToggle}
    >
      {named}
    </button>
  )
}
