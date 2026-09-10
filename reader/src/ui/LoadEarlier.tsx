/**
 * The *load-earlier* control: the one way past the window the Reader opened on, and a thing
 * the developer asks for rather than something that happens while they scroll. Infinite
 * scroll was the rival and lost on exactly that — reaching back is a decision, and a
 * decision that fires when your finger slips on a trackpad is not one.
 *
 * It sits at the top of the Activity table, above the oldest row it holds, which is where
 * the history it goes and gets will appear. Absent — not disabled — when the scan has
 * reached the top of the Sidecar or has nothing to scan yet: a control that cannot do
 * anything is a question the developer has to answer before they can ignore it.
 */

export type EarlierState = {
  /** Whether the Sidecar holds anything before the window the Reader has. */
  available: boolean
  /** Whether a scan is in flight. A backward read of a 64 MB Sidecar is not instant. */
  loading: boolean
}

type LoadEarlierProps = {
  state: EarlierState
  onLoad: () => void
}

export function LoadEarlier({ state, onLoad }: LoadEarlierProps) {
  if (!state.available) return null

  return (
    <div className="load-earlier">
      <button type="button" className="load-earlier-button" onClick={onLoad} disabled={state.loading}>
        {state.loading ? "Loading earlier…" : "Load earlier"}
      </button>
    </div>
  )
}
