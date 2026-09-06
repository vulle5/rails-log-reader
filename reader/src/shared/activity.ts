import type { AppLogEvent, Envelope, RequestException, SqlEvent } from "./wire"

/**
 * The fold: Sidecar envelopes in append order become Activity table rows.
 *
 * Three events are one row — a request is never a mutable record on the wire, so folding
 * `request_start`, `request_route` and `request_finish` together is the Reader's job, and
 * SQL and App log events attach to the row their `request_id` names. The two ordering
 * rules this file exists to keep are ADR-0002's, as amended by #8:
 *
 * - **Append order is the global key.** Envelopes arrive in the order they were appended to
 *   the Sidecar and are folded in that order, so nothing here sorts. `seq` restarts at 1 in
 *   every Run and orders only one request's own timeline; `at_wall`, which NTP can step
 *   backwards, is carried for display and never compared.
 * - **A row sits at the append position of the earliest event observed for it.** The row is
 *   created by whichever of its events arrives first — `request_start` for an ordinary
 *   request, a child for one whose start the Reader missed — so a new row is always an
 *   append at the bottom and never an insert, and rows mutate in place and never move.
 */

/**
 * One SQL or App log event, kept whole rather than reduced to what a column happens to show
 * today. The detail column renders the payload the Initializer wrote and nothing derived
 * from it, which is what makes "SQL is never reformatted" structural rather than a rule to
 * remember.
 */
export type TimelineEvent = SqlEvent | AppLogEvent

/**
 * One request, folded. Everything the Reader may never be told is nullable: a request that
 * failed to route has no `controller`, and one still in flight has no `status`.
 */
export type RequestRow = {
  requestId: string
  runId: string
  /** Display only — never sorted on, never subtracted. `null` until a `request_start` arrives. */
  startedAtWall: number | null
  method: string | null
  path: string | null
  /** `null` while a request has not entered a controller: `request_route`'s absence is the signal. */
  controller: string | null
  action: string | null
  status: number | null
  durationMs: number | null
  dbRuntimeMs: number | null
  viewRuntimeMs: number | null
  sqlCount: number
  /**
   * App log events, *Echoes* excluded — the count and the timeline are one number and one
   * list of the same thing, so a table reading `12` beside a column showing eight lines
   * cannot happen. Counting them would also make this column nearly a restatement of the
   * one beside it: Rails echoes every query, so the two would rise together.
   */
  logCount: number
  /**
   * The request's own timeline: its SQL and App log events interleaved, in the order they
   * were emitted, which is what lets a log line be read as the explanation of the query
   * that follows it. Minus the *Echoes* — the query lines Rails logs for
   * `development.log`'s benefit, which are the SQL events beside them said again and worse.
   */
  timeline: readonly TimelineEvent[]
  /**
   * The *Trailing events*: those whose `seq` places them after the `request_finish`. Kept
   * apart from the timeline rather than appended silently to it — a log line arriving after
   * its request finished is genuinely surprising, and hiding it would read as a Reader bug.
   * Empty is the normal case: the request boundary is the Initializer's own middleware, so
   * almost nothing can outlive it.
   */
  trailing: readonly TimelineEvent[]
  /** `null` unless the request raised. Carried whole, backtrace uncleaned. */
  exception: RequestException | null
  /**
   * How many bytes of backtrace were emitted, on the rare occasion the wire cut it — a
   * backtrace is exempt from the per-field cap and only the 256 KB whole-line cap can reach
   * it. `null` is both "nothing was cut" and "nothing raised". Kept because "uncleaned" is a
   * promise the Reader can only keep if it says when the file could not.
   */
  backtraceCutFrom: number | null
}

export type ActivityTable = {
  /** The same array throughout, mutated in place: rows are appended and never reordered. */
  readonly rows: readonly RequestRow[]
  /** Fold a batch of envelopes, in append order. Safe to hand the same bytes twice. */
  fold: (envelopes: readonly Envelope[]) => void
}

/**
 * Unbounded, deliberately and only for now: the *Memory bound* — the ring buffer that
 * evicts the oldest rows and thereby closes the attribution horizon — is #27's, and it
 * bounds `rows`, `byRequest` and `folded` together, since all three are one retention
 * question rather than three.
 */
export function activityTable(): ActivityTable {
  const rows: RequestRow[] = []
  const byRequest = new Map<string, Folding>()
  const folded = new Set<string>()

  /**
   * `(run_id, seq)` is the event identity, so re-reading the same bytes — a reconnecting
   * browser, a backward scan overlapping what is already held — costs a `Set` lookup
   * rather than a doubled row.
   */
  function alreadyFolded(envelope: Envelope) {
    const identity = `${envelope.run_id} ${envelope.seq}`
    if (folded.has(identity)) return true
    folded.add(identity)
    return false
  }

  function foldingFor(envelope: Envelope, requestId: string) {
    const existing = byRequest.get(requestId)
    if (existing !== undefined) return existing

    const folding: Folding = {
      row: {
        requestId,
        runId: envelope.run_id,
        startedAtWall: null,
        method: null,
        path: null,
        controller: null,
        action: null,
        status: null,
        durationMs: null,
        dbRuntimeMs: null,
        viewRuntimeMs: null,
        sqlCount: 0,
        logCount: 0,
        timeline: [],
        trailing: [],
        exception: null,
        backtraceCutFrom: null,
      },
      finishSeq: null,
      echoing: null,
    }
    byRequest.set(requestId, folding)
    rows.push(folding.row)
    return folding
  }

  /**
   * Interleaving is the arrival itself: within one Run the Initializer takes `seq` at
   * observation and writes inline, so append order and `seq` order are the same order and
   * nothing here sorts. What `seq` decides is *which* list the event joins — past the
   * `request_finish` it is a Trailing event, and a section of its own is where it goes.
   */
  function place(folding: Folding, event: TimelineEvent) {
    const trailing = folding.finishSeq !== null && event.seq > folding.finishSeq
    if (trailing) folding.row.trailing.push(event)
    else folding.row.timeline.push(event)
  }

  /**
   * An *Echo*: ActiveRecord's own log subscriber writing out a query the Reader already
   * holds as an SQL event. Rails logs every query twice by design — once through
   * `sql.active_record`, which is where the Reader's structured event comes from, and once
   * as a `debug` line for `development.log` to print — so a timeline that kept both would
   * show every query twice, the second time worse: no binds, no row count, a rounded
   * duration and no highlighting.
   *
   * The test is containment, not the message's shape: this line, written by Rails rather
   * than by the developer, holds the previous query's SQL verbatim inside it. That is a
   * fact about two payloads rather than a guess at a format, which is the same standard
   * `source` is held to — and it is deliberately unable to prove anything about a line that
   * is *not* an echo. So `↳ app/views/posts/index.html.erb:11`, the callsite Rails prints
   * under a query when `verbose_query_logs` is on, stays: it is the one thing in those two
   * lines the SQL event does not carry, and dropping it would cost the N+1 hunt its answer.
   *
   * Two ways this deliberately declines to fire, both of them the safe direction. A query
   * whose SQL the wire had to cut cannot be found inside a line the wire also cut, so a
   * truncated query keeps its echo and the developer sees the duplication rather than a
   * silent guess. And an echo only ever answers for the query directly before it, because
   * Rails writes it there and then — a match further back would be a coincidence.
   */
  function isEcho(folding: Folding, event: AppLogEvent) {
    const query = folding.echoing
    folding.echoing = null

    if (query === null || event.payload.source !== "rails") return false
    // A hand-written Sidecar line can carry an empty statement, and `includes("")` is true
    // of every string there is.
    return query.payload.sql !== "" && event.payload.message.includes(query.payload.sql)
  }

  function fold(envelopes: readonly Envelope[]) {
    for (const envelope of envelopes) {
      if (alreadyFolded(envelope)) continue

      const requestId = envelope.request_id
      if (requestId === null) continue // its Run owns it, and Run rows are #23

      const folding = foldingFor(envelope, requestId)
      const row = folding.row

      switch (envelope.type) {
        case "request_start":
          row.startedAtWall = envelope.at_wall
          row.method = envelope.payload.method
          row.path = envelope.payload.path
          break
        case "request_route":
          row.controller = envelope.payload.controller
          row.action = envelope.payload.action
          break
        case "request_finish":
          row.status = envelope.payload.status
          row.durationMs = envelope.payload.duration_ms
          row.viewRuntimeMs = envelope.payload.view_runtime_ms ?? null
          row.dbRuntimeMs = envelope.payload.db_runtime_ms ?? null
          row.exception = envelope.payload.exception ?? null
          row.backtraceCutFrom = envelope.truncated?.backtrace ?? null
          folding.finishSeq = envelope.seq
          break
        case "sql":
          row.sqlCount += 1
          folding.echoing = envelope
          place(folding, envelope)
          break
        case "app_log":
          // Dropped from the row rather than marked on it: the Console reads the envelope
          // stream and not this fold, so the line itself survives where the log lives.
          if (isEcho(folding, envelope)) break
          row.logCount += 1
          place(folding, envelope)
          break
      }
    }
  }

  return { rows, fold }
}

/**
 * A row, plus the one thing the fold needs to know about it that nothing renders: where its
 * `request_finish` sat in the Run's `seq`, which is what tells a Trailing event from an
 * ordinary one. The arrays are mutable here and `readonly` on the row itself, so appending
 * to a timeline is this file's business and reading it is everyone else's.
 */
type Folding = {
  row: RequestRow & { timeline: TimelineEvent[]; trailing: TimelineEvent[] }
  finishSeq: number | null
  /** The query an *Echo* could still be echoing: the last SQL event, until the next App log event. */
  echoing: SqlEvent | null
}
