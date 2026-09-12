import { requestRowId, runRowId, type EvictedRow } from "./activity"
import { eventIdentity, type AppLogEvent, type Envelope } from "./wire"

/**
 * The *Console*: every App log event the Sidecar carried, attributed or not, in *append
 * order*. **App log events only** — never SQL, attributed or not, because queries outnumber
 * log lines and a `Rails.logger` call you wrote would be buried among them.
 *
 * A second fold beside `activityTable`, reading the same envelopes and never that fold's
 * output. That is what makes the *Echo* a Console line: the detail column drops the query
 * Rails logged a second time for `development.log`'s benefit, and this — being the log —
 * keeps it. Nothing here recognises an Echo at all, which is stronger than deciding to keep
 * one.
 *
 * Nothing here filters by level either. Volume is a *level* problem the reader solves with
 * chips it can turn back on, never an attribution one, and a floor applied at the fold would
 * be a line the Reader never held rather than one it is not showing.
 */

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
   * bound* (ADR-0005, #63). A line's lifetime is exactly its owning row's, so this is the
   * whole of the Console's own retention: no counter here decides when a line goes, only
   * this call saying which rows just went. Attributed or not, *Echo* included — nothing here
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
 * Bounded, and by nothing of its own (ADR-0005, #63): a line's retention is exactly its
 * owning row's, so the moment `evict` is told that row is gone, its lines go with it. Before
 * this the Console read the envelope stream independently of `activityTable` and outlived
 * every row's eviction — a session long enough to evict its oldest rows still held every App
 * log line it ever saw, one honest fact (a `Rails.logger` call never disappearing) sitting on
 * top of one dishonest one (a click on an old line landing on a row the fold no longer had).
 * Giving the Console a second, independently-counted bound would have kept "one number, not
 * two" in name only; deriving retention from the Activity fold's own eviction is what keeps
 * it true.
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
