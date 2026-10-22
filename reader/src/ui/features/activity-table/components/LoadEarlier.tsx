/**
 * The *load-earlier* strip: the one way past the history the Reader opened on, and a thing
 * the developer asks for rather than something that happens while they scroll. Infinite
 * scroll was the rival and lost on exactly that — reaching back is a decision, and a
 * decision that fires when your finger slips on a trackpad is not one.
 *
 * It sits at the top of the Activity table, above the oldest row it holds, which is where
 * the history it goes and gets will appear. It always says where the history stands:
 *
 * - a button, while there is more to read, with a muted note beside it after a click whose
 *   reads only added to rows already shown;
 * - "Nothing earlier to load" once the top of the Sidecar is reached and the table has rows;
 * - nothing while the history has not arrived or the table is empty, because the *Empty state*
 *   is what speaks for an empty table.
 *
 * Inside the scrollport rather than in the heading beside the tabs: reaching further back is
 * a thing you go looking for, and it is exactly where you arrive when you scroll to the top of
 * what you already have.
 */

import type { EarlierState } from "../../../hooks/live"

type LoadEarlierProps = {
  state: EarlierState
  /** Whether the Activity table holds any row at all. */
  hasRows: boolean
  onLoad: () => void
}

export function LoadEarlier({ state, hasRows, onLoad }: LoadEarlierProps) {
  if (!state.available) {
    if (!state.atStart || !hasRows) return null

    return <div className="border-b border-border px-3 py-1.5 text-center text-xs text-muted">Nothing earlier to load</div>
  }

  return (
    <div className="flex items-center justify-center gap-3 border-b border-border px-3 py-1.5">
      <button
        type="button"
        className="cursor-pointer rounded border border-border bg-raised px-3 py-0.75 text-xs text-muted enabled:hover:bg-selected enabled:hover:text-foreground disabled:cursor-default disabled:opacity-60"
        onClick={onLoad}
        disabled={state.loading}
      >
        {state.loading ? "Loading earlier…" : "Load earlier"}
      </button>
      {state.onlyExtended && !state.loading && <span className="text-xs text-muted">Only added to rows already shown</span>}
    </div>
  )
}
