/**
 * The *load-earlier* control: the one way past the history the Reader opened on, and a thing
 * the developer asks for rather than something that happens while they scroll. Infinite
 * scroll was the rival and lost on exactly that — reaching back is a decision, and a
 * decision that fires when your finger slips on a trackpad is not one.
 *
 * It sits at the top of the Activity table, above the oldest row it holds, which is where
 * the history it goes and gets will appear. Absent — not disabled — when the scan has
 * reached the top of the Sidecar or has nothing to scan yet: a control that cannot do
 * anything is a question the developer has to answer before they can ignore it.
 *
 * Inside the scrollport rather than in the heading beside the tabs: reaching further back is
 * a thing you go looking for, and it is exactly where you arrive when you scroll to the top of
 * what you already have.
 */

import type { EarlierState } from "../../../hooks/live"

type LoadEarlierProps = {
  state: EarlierState
  onLoad: () => void
}

export function LoadEarlier({ state, onLoad }: LoadEarlierProps) {
  if (!state.available) return null

  return (
    <div className="flex justify-center border-b border-border px-3 py-1.5">
      <button
        type="button"
        className="cursor-pointer rounded border border-border bg-raised px-3 py-0.75 text-xs text-muted enabled:hover:bg-selected enabled:hover:text-foreground disabled:cursor-default disabled:opacity-60"
        onClick={onLoad}
        disabled={state.loading}
      >
        {state.loading ? "Loading earlier…" : "Load earlier"}
      </button>
    </div>
  )
}
