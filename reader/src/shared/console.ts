import { requestRowId, runRowId, type EvictedRow } from "./activity"
import { eventIdentity, type AppLogEvent, type Envelope } from "./wire"

/** The Console: every App log event the Sidecar carried, attributed or not, in append order. */

export type ConsoleLine = {
  /** `(run_id, seq)`: the event identity everywhere in the Reader, and this line's key. */
  id: string
  /**
   * The `id` of the *Activity table* row this line belongs to — its request's, or, when it
   * is unattributed, its *Run*'s. Both are rows the Activity fold is bound to hold: an
   * attributed event opens a *Request row* if it is the first the Reader saw of that
   * request, and an unattributed one is exactly what opens a *Run row*.
   */
  owner: string
  event: AppLogEvent
}

export type ConsoleStream = {
  /** The same array throughout, mutated in place: lines are appended and evicted, never reordered. */
  readonly lines: readonly ConsoleLine[]
  /** Fold a batch of envelopes, in append order. Safe to hand the same bytes twice. */
  fold: (envelopes: readonly Envelope[]) => void
  /**
   * Let go of every line whose `owner` is one of `evicted`'s rows — what `activityTable`'s
   * `fold` and `foldEarlier` hand back, the instant they evict those rows under the *Memory
   * bound*. A line's lifetime is exactly its owning row's, so this is the whole of the
   * Console's own retention: no counter here decides when a line goes, only this call
   * saying which rows just went. Attributed or not, *Echo* included — nothing here
   * recognises an Echo at all, so there is nothing here that could spare one.
   *
   * Also closes the *attribution horizon* the same way `activityTable`'s own `foldOne` does:
   * a line printed for a Request row's `requestId` after this call is not that row's to
   * reclaim, so it is attributed to its Run instead, exactly as a Trailing event past the
   * horizon already is there.
   */
  evict: (evicted: readonly EvictedRow[]) => void
}

/**
 * Bounded, and by nothing of its own: a line's retention is exactly its owning row's, so the
 * moment `evict` is told that row is gone, its lines go with it.
 */
export function consoleStream(): ConsoleStream {
  const lines: ConsoleLine[] = []
  const folded = new Set<string>()
  /**
   * Request ids past the *attribution horizon*: their row has been evicted, and — unlike a
   * Run — a Request row never reopens, so nothing will ever again claim a line naming one of
   * these as its own. `ownerOf` reads this for the same reason `activityTable`'s own
   * `foldOne` checks its `evicted` Set: a line printed for one of these now belongs to
   * whichever Run wrote it, exactly like a line with no `request_id` at all.
   *
   * Grown only by `evict`, and never trimmed the way `activityTable`'s own `evicted` Set is:
   * one string per Request row this session has ever evicted, which is a request id already
   * paid for elsewhere and orders of magnitude smaller than a Console line, so there is
   * nothing here worth a second ring to bound.
   */
  const pastHorizon = new Set<string>()

  function ownerOf(event: AppLogEvent) {
    if (event.request_id === null || pastHorizon.has(event.request_id)) return runRowId(event.run_id)
    return requestRowId(event.request_id)
  }

  function fold(envelopes: readonly Envelope[]) {
    for (const envelope of envelopes) {
      if (envelope.type !== "app_log") continue

      const id = eventIdentity(envelope)
      if (folded.has(id)) continue
      folded.add(id)

      lines.push({ id, owner: ownerOf(envelope), event: envelope })
    }
  }

  /**
   * One pass, in place — the same shape `activityTable`'s own `compact` takes for the same
   * reason. `folded` forgets the evicted lines' identities too, rather than remembering them
   * forever with nothing left to point at: the fold's own dedup sets are trimmed the same way
   * once a row is gone, and a line whose exact bytes somehow arrived again after that would be
   * read as new rather than silently dropped — the same reading a Trailing event gets once its
   * request's row is out of memory entirely.
   */
  function evict(evicted: readonly EvictedRow[]) {
    if (evicted.length === 0) return
    const gone = new Set(evicted.map((row) => row.id))
    for (const row of evicted) if (row.requestId !== null) pastHorizon.add(row.requestId)

    let kept = 0
    for (const line of lines) {
      if (gone.has(line.owner)) folded.delete(line.id)
      else lines[kept++] = line
    }
    lines.length = kept
  }

  return { lines, fold, evict }
}
