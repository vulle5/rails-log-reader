import { useEffect, useRef, useState } from "react"

import { activityTable, type ActivityRow } from "../shared/activity"
import { consoleStream, type ConsoleLine } from "../shared/console"
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
  /**
   * The *Console*'s own fold of the same envelopes: every App log event, in append order,
   * that its owning row still holds — a line's retention borrows the Activity fold's own
   * eviction rather than counting its own (#63).
   */
  lines: readonly ConsoleLine[]
  liveWireVersion: number | null
  liveRunId: string | null
  /**
   * The server has said the load-on-open history is all here — so rows that are not here are
   * not coming, and an empty table is an empty Sidecar rather than one still being read.
   */
  historyLoaded: boolean
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
 * — which costs nothing, because `(run_id, seq)` is the event identity and both folds have
 * already seen every one of those events.
 *
 * Two folds over one stream, not one fold read twice: the *Console* is every App log event
 * in append order, *Echoes* included, and the Activity table's rows are the same events
 * grouped by what owns them, *Echoes* dropped. Neither's *content* is derivable from the
 * other, which is why the envelopes go to both — but the Console's *retention* is: every row
 * `activity.fold` hands back is one it just evicted under the *Memory bound*, and
 * `stream.evict` is what lets the Console's lines go with it — and its attribution horizon
 * close behind a Request row the same way `activityTable`'s own does — rather than the
 * Console counting a bound of its own (#63).
 *
 * Both folds and the cursor outlive that effect, in `useState` initialisers and a ref, for
 * the same reason: a reconnection is not a new Reader. What the folds hold — including
 * whatever a *load-earlier* went and got — survives it, and so does how far back the
 * developer had asked to see, which the server has no memory of by design.
 */
export function useSidecar(): WireStatus {
  const [activity] = useState(activityTable)
  const [stream] = useState(consoleStream)
  const [status, setStatus] = useState<{
    rows: readonly ActivityRow[]
    lines: readonly ConsoleLine[]
    liveWireVersion: number | null
    liveRunId: string | null
  }>({ rows: [], lines: [], liveWireVersion: null, liveRunId: null })
  const [earlier, setEarlier] = useState<EarlierState>({ available: false, loading: false })
  // Never set back: a reconnection re-reads a history the folds already hold, so what it
  // would be waiting for is already on screen.
  const [historyLoaded, setHistoryLoaded] = useState(false)
  /**
   * The offset the loaded history begins at. `null` until the server says — nothing has been
   * attached to yet, so there is nothing to be earlier *than*.
   */
  const from = useRef<number | null>(null)

  useEffect(() => {
    const sidecar = new EventSource("/events")

    sidecar.onmessage = (message) => {
      const envelopes = JSON.parse(message.data) as Envelope[]
      const evicted = activity.fold(envelopes)
      stream.fold(envelopes)
      // The Console's retention borrowed from the fold's own eviction (#63): whatever rows
      // this batch's fold just took, the Console lets go of what belonged to them.
      stream.evict(evicted)
      const latest = envelopes.at(-1)

      setStatus((previous) => ({
        // A new array around the same rows: the rows deliberately keep their identity as
        // they mutate — that is what "rows mutate in place and never move" means — so the
        // array is the only thing left that can tell React the table has changed.
        rows: [...activity.rows],
        // Console lines never mutate at all — a line is one envelope — so this array is
        // copied for the one reason the rows' is: React is told by identity.
        lines: [...stream.lines],
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

    // Sent once the history's envelopes have been, which is what makes it the moment an
    // empty fold means an empty Sidecar.
    sidecar.addEventListener("loaded", () => setHistoryLoaded(true))

    return () => sidecar.close()
  }, [activity, stream])

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
      // The Activity fold only — the *Console* is append order, and this block belongs before
      // every line it holds rather than after them, so appending it there would put the
      // oldest lines of the session at the bottom of the rail, under the newest. But a pull
      // this large can still evict: it can give the *last row standing* company and make it
      // evictable again, so the Console still has to hear about whatever that takes.
      const evicted = activity.foldEarlier(block.envelopes)
      stream.evict(evicted)
      setStatus((previous) => ({ ...previous, rows: [...activity.rows], lines: [...stream.lines] }))
      setEarlier({ available: block.from > 0, loading: false })
    } catch {
      // The read failed and the cursor has not moved, so the control stays exactly as it
      // was: clicking again asks the same question, which is the only useful thing to do
      // with a file read that did not answer.
      setEarlier({ available: true, loading: false })
    }
  }

  return { ...status, historyLoaded, earlier, loadEarlier }
}
