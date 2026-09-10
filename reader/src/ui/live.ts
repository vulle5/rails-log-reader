import { useEffect, useRef, useState } from "react"

import { activityTable, type ActivityRow } from "../shared/activity"
import type { Earlier } from "../shared/earlier"
import type { Envelope } from "../shared/wire"

/**
 * What the live wire is saying about itself, apart from the rows folded out of it: the `v`
 * and `run_id` off whichever envelope arrived most recently, from whichever process wrote
 * it. Both start `null` — nothing has been observed yet — and both are read off *every*
 * envelope, not only `run_header`, because a `run_header` can sit outside the load-on-open
 * window the Reader attached inside; any envelope from the current Run says the same `v`
 * and the same `run_id` regardless (#29).
 */
export type WireStatus = {
  rows: readonly ActivityRow[]
  liveWireVersion: number | null
  liveRunId: string | null
  /** Whether there is anything before the loaded history, and whether a pull is in flight. */
  earlier: EarlierState
  loadEarlier: () => void
}

/**
 * Whether the Sidecar holds anything before the history the Reader has, and whether a scan
 * for it is in flight. Lives here rather than with the control it draws, because it is the
 * shape of what this hook knows: the control renders it and nothing more.
 */
export type EarlierState = {
  available: boolean
  loading: boolean
}

/**
 * The live Sidecar, folded in the browser. The server sends envelopes in append order and
 * nothing else, so this is where the Reader's model actually lives.
 *
 * `EventSource` reconnects on its own, and a reconnection re-reads the load-on-open history
 * — which costs nothing, because `(run_id, seq)` is the event identity and the fold has
 * already seen every one of those events.
 *
 * The fold and the cursor outlive that effect, in a `useState` initialiser and a ref, for
 * the same reason: a reconnection is not a new Reader. Rows the fold holds — including
 * whatever a *load-earlier* went and got — survive it, and so does how far back the
 * developer had asked to see, which the server has no memory of by design.
 */
export function useSidecar(): WireStatus {
  const [activity] = useState(activityTable)
  const [status, setStatus] = useState<{
    rows: readonly ActivityRow[]
    liveWireVersion: number | null
    liveRunId: string | null
  }>({ rows: [], liveWireVersion: null, liveRunId: null })
  const [earlier, setEarlier] = useState<EarlierState>({ available: false, loading: false })
  /**
   * The offset the loaded history begins at. `null` until the server says — nothing has been
   * attached to yet, so there is nothing to be earlier *than*.
   */
  const from = useRef<number | null>(null)

  useEffect(() => {
    const sidecar = new EventSource("/events")

    sidecar.onmessage = (message) => {
      const envelopes = JSON.parse(message.data) as Envelope[]
      activity.fold(envelopes)
      const latest = envelopes.at(-1)

      setStatus((previous) => ({
        // A new array around the same rows: the rows deliberately keep their identity as
        // they mutate — that is what "rows mutate in place and never move" means — so the
        // array is the only thing left that can tell React the table has changed.
        rows: [...activity.rows],
        liveWireVersion: latest?.v ?? previous.liveWireVersion,
        liveRunId: latest?.run_id ?? previous.liveRunId,
      }))
    }

    // Sent on attaching, and again whenever a truncation moves the history: the cursor is
    // taken from what the server is reading *now*, never carried across a file that was
    // replaced under it.
    sidecar.addEventListener("history", (message) => {
      const history = JSON.parse((message as MessageEvent).data) as { from: number }
      from.current = history.from
      setEarlier((current) => ({ ...current, available: history.from > 0 }))
    })

    return () => sidecar.close()
  }, [activity])

  /**
   * One click, one continuation of the backward scan. The cursor goes out and comes back,
   * and the block that comes with it is folded as what it is — everything in it happened
   * before everything the fold holds, so its rows open above them.
   */
  async function loadEarlier() {
    const cursor = from.current
    if (cursor === null || cursor <= 0) return

    setEarlier({ available: true, loading: true })
    try {
      const response = await fetch(`/earlier?from=${cursor}`)
      const block = (await response.json()) as Earlier

      from.current = block.from
      activity.foldEarlier(block.envelopes)
      setStatus((previous) => ({ ...previous, rows: [...activity.rows] }))
      setEarlier({ available: block.from > 0, loading: false })
    } catch {
      // The read failed and the cursor has not moved, so the control stays exactly as it
      // was: clicking again asks the same question, which is the only useful thing to do
      // with a file read that did not answer.
      setEarlier({ available: true, loading: false })
    }
  }

  return { ...status, earlier, loadEarlier }
}
