import { useEffect, useState } from "react"

import { activityTable, type ActivityRow } from "../shared/activity"
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
}

/**
 * The live Sidecar, folded in the browser. The server sends envelopes in append order and
 * nothing else, so this is where the Reader's model actually lives.
 *
 * `EventSource` reconnects on its own, and a reconnection re-reads the load-on-open history
 * — which costs nothing, because `(run_id, seq)` is the event identity and the fold has
 * already seen every one of those events.
 */
export function useSidecar(): WireStatus {
  const [status, setStatus] = useState<WireStatus>({ rows: [], liveWireVersion: null, liveRunId: null })

  useEffect(() => {
    const activity = activityTable()
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

    return () => sidecar.close()
  }, [])

  return status
}
