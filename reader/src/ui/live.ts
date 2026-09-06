import { useEffect, useState } from "react"

import { activityTable, type RequestRow } from "../shared/activity"
import type { Envelope } from "../shared/wire"

/**
 * The live Sidecar, folded in the browser. The server sends envelopes in append order and
 * nothing else, so this is where the Reader's model actually lives.
 *
 * `EventSource` reconnects on its own, and a reconnection re-reads the load-on-open history
 * — which costs nothing, because `(run_id, seq)` is the event identity and the fold has
 * already seen every one of those events.
 */
export function useSidecar(): readonly RequestRow[] {
  const [rows, setRows] = useState<readonly RequestRow[]>([])

  useEffect(() => {
    const activity = activityTable()
    const sidecar = new EventSource("/events")

    sidecar.onmessage = (message) => {
      activity.fold(JSON.parse(message.data) as Envelope[])
      // A new array around the same rows: the rows deliberately keep their identity as they
      // mutate — that is what "rows mutate in place and never move" means — so the array is
      // the only thing left that can tell React the table has changed.
      setRows([...activity.rows])
    }

    return () => sidecar.close()
  }, [])

  return rows
}
