import type { AppLogEvent, Envelope, RequestException, RunKind, SqlEvent } from "./wire"

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
 *   request, a child for one whose start the Reader missed, the `run_header` for a Run — so
 *   a new row is always an append at the bottom and never an insert, and rows mutate in
 *   place and never move. Two Runs writing at once therefore interleave at their true
 *   append positions rather than being slabbed above or below each other.
 *
 * The other half of this file is what the wire deliberately never says. *In-flight*,
 * *Interrupted* and *Partial request* appear in no envelope: each is concluded here, from
 * evidence in the file and never from a clock or a threshold — there is no timeout on an
 * in-flight request, ever.
 */

/**
 * One SQL or App log event, kept whole rather than reduced to what a column happens to show
 * today. The detail column renders the payload the Initializer wrote and nothing derived
 * from it, which is what makes "SQL is never reformatted" structural rather than a rule to
 * remember.
 */
export type TimelineEvent = SqlEvent | AppLogEvent

/**
 * Where a request got to. Hanging is *not* one of these: with no timeout there is no
 * threshold to cross, so a request that hangs is in flight exactly like one that is about
 * to answer, and a climbing elapsed is the whole of the signal.
 */
export type RequestState = "in-flight" | "finished" | "interrupted"

/**
 * One request, folded. Everything the Reader may never be told is nullable: a request that
 * failed to route has no `controller`, and one still in flight has no `status`.
 */
export type RequestRow = {
  kind: "request"
  /** Unique across both kinds of row, because *Selection* names a row without knowing which. */
  id: string
  requestId: string
  runId: string
  state: RequestState
  /**
   * A *Partial request*: the Reader has this request's children but never saw its start,
   * because it attached mid-flight. Set when the row is created by anything other than a
   * `request_start`, and **never cleared** — later events promote the row without making the
   * events emitted before the Reader attached any less lost, and their number unknowable.
   */
  partial: boolean
  /**
   * How long this request had been running as of the last event the Reader saw for it, and
   * the wall clock reading that last event carried. `null` until a `request_start` gives it
   * something to measure from, so a *Partial request* has none until one turns up, and is
   * honest about it meanwhile.
   *
   * The two travel together because neither is the answer alone. `ms` is *proven* — measured
   * within one Run's own `at_mono`, the only clock two events may be subtracted across — and
   * it stops climbing the moment the request goes quiet, which is exactly what a hang is.
   * `atWall` is where that reading joins the clock on the wall, so the Reader can carry it
   * forward: a request that had already been hanging for ten minutes when the Reader opened
   * says ten minutes, rather than the second and a half of it that happened to be in the file.
   * Carrying it forward is the Reader's business and not the fold's, which has no clock.
   */
  provenElapsed: ProvenElapsed | null
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

/**
 * What the Reader can prove about how long a request has been running, and where that proof
 * meets the wall clock. See `RequestRow.provenElapsed`, and `useClimbingElapsed` for the
 * carrying-forward this is the fixed end of.
 */
export type ProvenElapsed = {
  /** Milliseconds, measured within one Run's `at_mono`. Exact, and a floor. */
  ms: number
  /** The `at_wall` of the event `ms` was measured to. */
  atWall: number
}

/**
 * One Run's *Run row*: everything that Run emitted with no owning request — boot lines,
 * background jobs, a `rake` burst, a `rails c` session — in one row, anchored where the Run
 * first said anything. One per Run and no gap threshold splits it, because a threshold is
 * the timer this project refuses everywhere else.
 *
 * Created by the Run's `run_header`, or by the first unattributed event of a Run whose
 * header the Reader never saw. A Run that emitted nothing unattributed — a forked Puma
 * worker, which inherits a boot that already happened and writes no header of its own —
 * gets no row, because there is nothing for one to hold.
 */
export type RunRow = {
  kind: "run"
  id: string
  runId: string
  /** `null` where the Reader attached inside the Run and never saw its header. */
  runKind: RunKind | null
  pid: number | null
  railsVersion: string | null
  appName: string | null
  /**
   * The *Run marker*: drawn where a `run_header` announcing a web process landed, and
   * meaning literally *this Run started here* — never *everything below belongs to it*.
   * `false` for a `rake` or `rails c` Run, which started beside a server that kept serving,
   * so a marker over the rows below would be a claim about traffic it has nothing to do
   * with; `false` too where no header was seen, since a boundary nobody witnessed is not one
   * the Reader may draw.
   */
  marker: boolean
  /** Display only, like a request's: read off whichever event opened the row. */
  startedAtWall: number | null
  sqlCount: number
  /** *Echoes* excluded, exactly as on a request row — a `rake` burst is echoed too. */
  logCount: number
  timeline: readonly TimelineEvent[]
}

/**
 * One row of the Activity table: the two things that own events. Tabs filter by this and
 * nothing else — Requests, Runs, All — never by method, status or controller.
 */
export type ActivityRow = RequestRow | RunRow

export type ActivityTable = {
  /** The same array throughout, mutated in place: rows are appended and never reordered. */
  readonly rows: readonly ActivityRow[]
  /** Fold a batch of envelopes, in append order. Safe to hand the same bytes twice. */
  fold: (envelopes: readonly Envelope[]) => void
}

/**
 * Unbounded, deliberately and only for now: the *Memory bound* — the ring buffer that
 * evicts the oldest rows and thereby closes the attribution horizon — is #27's, and it
 * bounds `rows`, `byRequest`, `byRun` and `folded` together, since all four are one
 * retention question rather than four.
 */
export function activityTable(): ActivityTable {
  const rows: ActivityRow[] = []
  const byRequest = new Map<string, Folding>()
  const byRun = new Map<string, Running>()
  const folded = new Set<string>()

  /**
   * `(run_id, seq)` is the event identity, so re-reading the same bytes — a reconnecting
   * browser, a backward scan overlapping what is already held — costs a `Set` lookup
   * rather than a doubled row. It is also what keeps a re-read `run_header` from concluding
   * a second restart out of a boundary the fold has already crossed.
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
        kind: "request",
        id: `request ${requestId}`,
        requestId,
        runId: envelope.run_id,
        state: "in-flight",
        // Anything but a start means the Reader has the children and not the parent.
        partial: envelope.type !== "request_start",
        provenElapsed: null,
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
      startedAtMono: null,
      finishSeq: null,
      echoing: null,
    }
    byRequest.set(requestId, folding)
    rows.push(folding.row)
    return folding
  }

  function runningFor(envelope: Envelope) {
    const existing = byRun.get(envelope.run_id)
    if (existing !== undefined) return existing

    const running: Running = {
      row: {
        kind: "run",
        id: `run ${envelope.run_id}`,
        runId: envelope.run_id,
        runKind: null,
        pid: null,
        railsVersion: null,
        appName: null,
        marker: false,
        startedAtWall: envelope.at_wall,
        sqlCount: 0,
        logCount: 0,
        timeline: [],
      },
      echoing: null,
    }
    byRun.set(envelope.run_id, running)
    rows.push(running.row)
    return running
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
   *
   * Held per owner rather than globally — one *Echoing* on each request's fold and one on
   * each Run's — because two requests interleaving in one process put other events between
   * a query and the line Rails wrote for it, and a `rake` burst is echoed exactly as a
   * request's queries are.
   */
  function isEcho(owner: Echoing, event: AppLogEvent) {
    const query = owner.echoing
    owner.echoing = null

    if (query === null || event.payload.source !== "rails") return false
    // A hand-written Sidecar line can carry an empty statement, and `includes("")` is true
    // of every string there is.
    return query.payload.sql !== "" && event.payload.message.includes(query.payload.sql)
  }

  /**
   * What the Reader can prove about how long an in-flight request has been running: the
   * distance in its own Run's `at_mono` between its start and the last thing it said. Within
   * one Run, so the two readings are the same clock — the one subtraction ADR-0002 allows,
   * and the reason two `at_wall`s are never the things subtracted here.
   *
   * The reading is never allowed to fall: a `load_async` query hands in the `at_mono` it was
   * *issued* at, which is earlier than the moment it is replayed on the request thread, and
   * an elapsed that went backwards would read as a Reader bug rather than as the truth about
   * a thread. The wall clock reading beside it always moves on, because it answers a
   * different question — *when was this last true* — and the latest observation is the answer
   * to that whichever `at_mono` it carried.
   */
  function proveElapsed(folding: Folding, event: Envelope) {
    if (folding.startedAtMono === null) return

    const measured = (event.at_mono - folding.startedAtMono) / 1_000_000
    folding.row.provenElapsed = {
      ms: Math.max(measured, folding.row.provenElapsed?.ms ?? 0),
      atWall: event.at_wall,
    }
  }

  /**
   * *Interrupted*: the Run ended while these requests were still in flight, so no finish is
   * ever coming. Concluded from evidence and never from a timer — a `run_end`, which carries
   * the ending's own `at_mono` and so freezes the elapsed exactly, or the next web process's
   * `run_header`, which carries a different process's clock and can only freeze it where the
   * request itself left it.
   */
  function interrupt(whoseRunEnded: (folding: Folding) => boolean, ending: Envelope | null) {
    for (const folding of byRequest.values()) {
      if (folding.row.state !== "in-flight" || !whoseRunEnded(folding)) continue

      if (ending !== null) proveElapsed(folding, ending)
      folding.row.state = "interrupted"
    }
  }

  /**
   * A `run_header` is the Reader's evidence that a process booted — and, for a web process,
   * that the one it replaced is gone: `rails s` and puma-dev each run a single process in
   * development, so a second server booting is a restart. The same fact draws the *Run
   * marker*, because a restart is exactly the boundary a marker is for.
   *
   * Only `server`, and deliberately: a `rake` task or a `rails c` session boots beside a
   * server that keeps serving, a Sidekiq `worker` the same, and `unknown` is the kind the
   * Initializer declined to classify — concluding a restart from a refusal to conclude is
   * the wrong direction. A forked Puma worker cannot fire this either, since it inherits a
   * boot that already happened and writes no header of its own.
   */
  function bootsAWebProcess(kind: RunKind) {
    return kind === "server"
  }

  function fold(envelopes: readonly Envelope[]) {
    for (const envelope of envelopes) {
      if (alreadyFolded(envelope)) continue

      if (envelope.type === "run_header") {
        const opensTheRow = !byRun.has(envelope.run_id)
        const row = runningFor(envelope).row
        row.runKind = envelope.payload.kind
        row.pid = envelope.payload.pid
        row.railsVersion = envelope.payload.rails_version
        row.appName = envelope.payload.app_name

        if (bootsAWebProcess(envelope.payload.kind)) {
          // The marker goes where this header landed, so it is only ever drawn on a row this
          // header opened — a Run the Reader met further down started somewhere it cannot see.
          if (opensTheRow) row.marker = true
          interrupt((folding) => folding.row.runId !== envelope.run_id, null)
        }
        continue
      }

      if (envelope.type === "run_end") {
        // No row of its own: an ending carries nothing for a Run row to hold, and a Run the
        // Reader met at its `run_end` and nowhere else has nothing to show either.
        interrupt((folding) => folding.row.runId === envelope.run_id, envelope)
        continue
      }

      const requestId = envelope.request_id
      if (requestId === null) {
        // Only SQL and App log events have a home without one: a request event that names no
        // request says nothing about any row, and a hand-written Sidecar is the only place
        // one can come from.
        if (envelope.type === "sql" || envelope.type === "app_log") foldIntoRun(envelope)
        continue
      }

      const folding = foldingFor(envelope, requestId)
      const row = folding.row
      // Only while in flight: past that the elapsed is a finished request's duration or the
      // frozen reading an Interrupted row keeps.
      if (row.state === "in-flight") proveElapsed(folding, envelope)

      switch (envelope.type) {
        case "request_start":
          row.startedAtWall = envelope.at_wall
          row.method = envelope.payload.method
          row.path = envelope.payload.path
          folding.startedAtMono = envelope.at_mono
          row.provenElapsed ??= { ms: 0, atWall: envelope.at_wall }
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
          // Finished even if the row had been called Interrupted: that was inferred from a
          // Run looking ended, and a finish is the file saying outright that it was not.
          row.state = "finished"
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

  /** An event with no owning request. Its Run owns it, and that is what a *Run row* is. */
  function foldIntoRun(event: TimelineEvent) {
    const running = runningFor(event)
    const row = running.row

    if (event.type === "sql") {
      row.sqlCount += 1
      running.echoing = event
    } else {
      if (isEcho(running, event)) return
      row.logCount += 1
    }
    // No trailing section: a Run has no finish for anything to trail.
    row.timeline.push(event)
  }

  return { rows, fold }
}

/** What both kinds of owner keep so an *Echo* can be recognised against the query above it. */
type Echoing = {
  /** The query an *Echo* could still be echoing: the last SQL event, until the next App log event. */
  echoing: SqlEvent | null
}

/**
 * A row, plus the two things the fold needs to know about it that nothing renders: where its
 * `request_finish` sat in the Run's `seq`, which is what tells a Trailing event from an
 * ordinary one, and the `at_mono` its start was taken at, which is what an elapsed is
 * measured from. The arrays are mutable here and `readonly` on the row itself, so appending
 * to a timeline is this file's business and reading it is everyone else's.
 */
type Folding = Echoing & {
  row: RequestRow & { timeline: TimelineEvent[]; trailing: TimelineEvent[] }
  /** `null` for a *Partial request*: there is no start to measure from. */
  startedAtMono: number | null
  finishSeq: number | null
}

/** The same, for a Run: its row, and the query an unattributed *Echo* would be echoing. */
type Running = Echoing & {
  row: RunRow & { timeline: TimelineEvent[] }
}
