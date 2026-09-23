/**
 * One filter chip, on or off — the shape `ConsoleFilters` and `DetailFilters` both draw
 * their thinning controls from, so a second one never grows its own copy of what "off" looks
 * like. The stylesheet reads "off" from `aria-pressed`, the one place it is said. `kind` and
 * not `named` keys the rest of the stylesheet, because a chip's label is free text (`debug`,
 * `rails`, `schema`) while what colours it is a fixed, small set CSS answers for.
 */

export type ChipProps = {
  named: string
  /** What the stylesheet answers for, keyed rather than slugged from the label. */
  kind: string
  showing: boolean
  title: string
  onToggle: () => void
}

export function Chip({ named, kind, showing, title, onToggle }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={showing}
      className={`chip chip-${kind}`}
      title={title}
      onClick={onToggle}
    >
      {named}
    </button>
  )
}
