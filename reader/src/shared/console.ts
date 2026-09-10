import { requestRowId, runRowId } from "./activity"
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
  /** The same array throughout, appended to in place. */
  readonly lines: readonly ConsoleLine[]
  /** Fold a batch of envelopes, in append order. Safe to hand the same bytes twice. */
  fold: (envelopes: readonly Envelope[]) => void
}

/**
 * Unbounded, and now the only fold that is: #27 bounded `activityTable` and left the Console
 * out of it, so a session long enough to evict its oldest rows still holds every App log line
 * it ever saw. That is the *Memory bound*'s question rather than a second one, and it is
 * open (#44) — as is what a line whose row has been evicted selects when it is clicked.
 */
export function consoleStream(): ConsoleStream {
  const lines: ConsoleLine[] = []
  const folded = new Set<string>()

  function fold(envelopes: readonly Envelope[]) {
    for (const envelope of envelopes) {
      if (envelope.type !== "app_log") continue

      const id = eventIdentity(envelope)
      if (folded.has(id)) continue
      folded.add(id)

      lines.push({ id, owner: ownerOf(envelope), event: envelope })
    }
  }

  return { lines, fold }
}

function ownerOf(event: AppLogEvent) {
  return event.request_id === null ? runRowId(event.run_id) : requestRowId(event.request_id)
}
