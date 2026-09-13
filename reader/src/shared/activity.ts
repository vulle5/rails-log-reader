import { LOAD_ON_OPEN_EVENTS } from "./bounds"
import { eventIdentity, type AppLogEvent, type Envelope, type RequestException, type RunKind, type SqlEvent } from "./wire"

/** The fold: Sidecar envelopes in append order become Activity table rows. */

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
   * A *Partial request*: the Reader does not currently hold this request's start, because it
   * attached mid-flight or started after the request did. Set when the row is created by
   * anything other than a `request_start`. Cleared only by a *load-earlier* pull turning up
   * that same `request_start` — the one thing that changes what the mark records, from "the
   * Reader never saw this" to "the Reader does not currently hold this." A `request_start`
   * arriving through the ordinary live fold never clears it: within one append-ordered batch a
   * child arriving before its own start is not a recovery, it is the wire out of order, and
   * the events emitted before the Reader attached are exactly as lost as they were.
   */
  partial: boolean
  /**
   * `true` when this is the *last row standing*: the only row left, holding more events
   * than the Memory bound's ceiling by itself, with nothing else in the table for the bound
   * to take instead. Never means anything was cut — every event this row ever held is still
   * here, in full, in `timeline` — only that eviction stopped at one row rather than empty
   * the table by taking it too. See `RunRow.overBound`, which is the ordinary way here: a
   * single request outgrowing the ceiling on its own is the rarer of the two.
   */
  overBound: boolean
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
  /**
   * What the request itself said it took. `null` while it is still in flight, and `null` for
   * a finish that carried no duration at all — the Initializer emits none when it never saw
   * the request start, so there is nothing to measure from. Either way the row falls back to
   * `provenElapsed`, which is the Reader's own measurement rather than the request's.
   */
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
  /**
   * The owning Run's `rails_root` — a request carries only its Run's id otherwise, and
   * `rails_root` is what a backtrace frame needs to tell the Host app's own code from a
   * gem's. Kept in step with `RunRow.railsRoot` even where the two disagreed the moment this
   * row opened, the same *load-earlier* gap the Run marker reads: a request opened from a
   * Run row that had said something before its header reached the Reader starts `null` and
   * is corrected the moment that header is folded, wherever in time that turns out to be.
   * `null` and staying `null` means exactly one thing — the header never arrived at all —
   * which is `null` rather than a guess for the same reason `RunRow.appName` is.
   */
  railsRoot: string | null
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
   * `Rails.root`, the absolute path a backtrace frame is classified as the Host app's own
   * code against. `null` where `run_header` was never seen — a Run the Reader met mid-stream
   * — which is `appName`'s own reason for being `null` rather than a guess.
   */
  railsRoot: string | null
  /**
   * The *Run marker*: drawn where a `run_header` announcing a web process landed, and
   * meaning literally *this Run started here* — never *everything below belongs to it*.
   * `false` for a `rake` or `rails c` Run, which started beside a server that kept serving,
   * so a marker over the rows below would be a claim about traffic it has nothing to do
   * with; `false` too where no header was seen, since a boundary nobody witnessed is not one
   * the Reader may draw.
   */
  marker: boolean
  /**
   * `true` for a row the Reader opened because a Run whose earlier row the *Memory bound*
   * evicted said something unattributed again — distinguishing it from a Run the Reader
   * only ever attached inside, which leaves `runKind` and `pid` `null` for the same reason
   * but was never shown and taken away. Never `true` alongside `marker`: the row's own
   * `run_header`, if this Run ever had one, was on the row the bound already took, and this
   * one was opened by an unattributed event rather than a header.
   */
  reopened: boolean
  /**
   * `true` for the same reason `RequestRow.overBound` is, and this is the ordinary way there:
   * a `rake` burst larger than the load-on-open figure lands in one Run row before anything
   * else has a chance to open beside it, and the bound refuses to evict the only row left
   * rather than leave the table empty. Nothing in the row is trimmed — every event it holds
   * is still there and still rendered — the row is simply left standing over the ceiling.
   */
  overBound: boolean
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

/**
 * What a row is called. Written here and read by the *Console*, which has to name the row
 * one of its lines selects without holding that row: two spellings of one id would be a
 * click that selected nothing, and the failure would be silent.
 */
export function requestRowId(requestId: string) {
  return `request ${requestId}`
}

export function runRowId(runId: string) {
  return `run ${runId}`
}

/**
 * A row the *Memory bound* just took, as `fold` or `foldEarlier` reports it. `id` is what a
 * Console line's `owner` names while the row is held, and what `ConsoleStream.evict` matches
 * lines against. `requestId` is the second thing a caller needs and cannot derive from `id`
 * alone: for a Request row, `requestId` is what falls *past the attribution horizon* the
 * instant this row is taken — the same horizon `foldOne`'s own `evicted.has(requestId)` check
 * enforces here — so a line for that request printed *after* this eviction is not this row's
 * to reclaim, the same reading a Trailing event past the horizon already gets. `null` for a
 * Run row, which has no horizon of its own: a Run can reopen, and `runRowId` names the
 * reopened row exactly as it named the one taken, so nothing further needs remembering.
 */
export type EvictedRow = {
  id: string
  requestId: string | null
}

export type ActivityTable = {
  /** The same array throughout, mutated in place: rows are appended and never reordered. */
  readonly rows: readonly ActivityRow[]
  /**
   * Fold a batch of envelopes, in append order. Safe to hand the same bytes twice.
   *
   * Returns every row the *Memory bound* evicted while folding this batch — empty far more
   * often than not. This is the fold's own report of what it just let go of, for the one
   * caller (the *Console*) whose retention derives from this bound rather than counting its
   * own: handing the rows over is what lets that caller drop what depended on one the
   * instant this fold does, and keep attributing correctly for whatever a Request row's
   * eviction closes the horizon on next.
   */
  fold: (envelopes: readonly Envelope[]) => readonly EvictedRow[]
  /**
   * Fold a block of envelopes that sits *before* everything the fold holds: what the
   * *load-earlier* control went and got. The rows it opens go in above the rows already
   * there, because that is where their earliest event sits — which is the same rule the
   * live fold keeps, read from the other end.
   *
   * Reports evictions the same way `fold` does, for the same reason — ordinarily empty,
   * because the ceiling rises by exactly what the pull brought in, but not *always* empty:
   * a pull large enough to give the *last row standing* company can make it evictable again,
   * and that eviction is exactly as real as one the live fold triggers.
   */
  foldEarlier: (envelopes: readonly Envelope[]) => readonly EvictedRow[]
}

/**
 * The fold, bounded: the *Memory bound* is a ring holding no more events than the Reader
 * opened on — `LOAD_ON_OPEN_EVENTS`, the one number — and evicting the oldest rows once it
 * holds more. `rows`, `byRequest`, `byRun`, `folded` and `evicted` go together under it,
 * because all five are one retention question rather than five.
 *
 * Counted in *events* and not in rows, which is what makes it match the figure it is sized
 * by: the fold opens holding exactly the history the backward scan on open delivered, and a
 * row full of an all-day worker's output is bounded by the same number a table full of
 * requests is. Eviction is by whole rows all the same — a row that had half its queries
 * taken away would be a table saying 24 beside a timeline showing three.
 *
 * The bound doubles as the **attribution horizon**: a finished request stops being adoptable
 * by a *Trailing event* the instant its row is evicted, after which such an event is simply
 * unattributed. That is one rule rather than two, and it needs no timer — which is what lets
 * "no timeout, ever" survive a feature about time.
 */
export function activityTable(): ActivityTable {
  const rows: ActivityRow[] = []
  const byRequest = new Map<string, Folding>()
  const byRun = new Map<string, Running>()
  const folded = new Set<string>()
  /**
   * Requests the bound has taken the row of. Kept — rather than simply forgotten with the
   * row — because forgetting is what a *Partial request* is made of: without this, the first
   * Trailing event past the horizon would open a brand new row for a request the fold has in
   * fact already shown and evicted, which is the one reading of it that is false.
   */
  const evicted = new Set<string>()
  /**
   * Run ids the bound has taken the row of — kept for the opposite reason `evicted` is.
   * `evicted` stops a request opening a second row at all; this never does, because a Run
   * still running has every right to another one. What it does instead is mark that second
   * row `reopened`, so it stops reading exactly like a Run the Reader only ever attached
   * inside. Bounded the same way, so a Run reopening five thousand evictions later opens an
   * unmarked row rather than a wrong one.
   */
  const evictedRuns = new Set<string>()
  /**
   * The row currently marked `overBound`, if any — there is never more than one, since it
   * only ever holds where `rows.length` is exactly `1`. Tracked rather than recomputed by
   * scanning `rows`, so clearing the mark costs one comparison rather than a pass over
   * everything the bound is holding.
   */
  let overBoundRow: ActivityRow | null = null

  /** Events the fold is holding. */
  let held = 0
  /**
   * The load-on-open figure, plus whatever a *load-earlier* went and got. Raised by exactly
   * what was pulled in, because the bound is on what the Reader accumulates *by itself*:
   * history the developer explicitly asked for that evaporated under the next request to
   * arrive would make the control useless, and there is no traffic that can raise this on
   * its own.
   */
  let ceiling = LOAD_ON_OPEN_EVENTS
  /** How many rows at the front a load-earlier pulled in. Never evicted, for the same reason. */
  let pulled = 0
  /** The load-earlier block being folded, if one is: `null` in the ordinary live fold. */
  let earlier: EarlierBlock | null = null

  /**
   * `(run_id, seq)` is the event identity, so re-reading the same bytes — a reconnecting
   * browser, a backward scan overlapping what is already held — costs a `Set` lookup
   * rather than a doubled row. It is also what keeps a re-read `run_header` from concluding
   * a second restart out of a boundary the fold has already crossed.
   */
  function alreadyFolded(envelope: Envelope) {
    const identity = eventIdentity(envelope)
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
        id: requestRowId(requestId),
        requestId,
        runId: envelope.run_id,
        state: "in-flight",
        // Anything but a start means the Reader has the children and not the parent.
        partial: envelope.type !== "request_start",
        overBound: false,
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
        // Whatever the Run row knows right now — `null` where it has no row yet, exactly as
        // where it has one but no header. The run_header branch below backfills this if the
        // header lands later, which is the only other way it changes.
        railsRoot: byRun.get(envelope.run_id)?.row.railsRoot ?? null,
      },
      startedAtMono: null,
      finishSeq: null,
      echoing: null,
      events: 0,
    }
    byRequest.set(requestId, folding)
    open(folding)
    return folding
  }

  function runningFor(envelope: Envelope) {
    const existing = byRun.get(envelope.run_id)
    if (existing !== undefined) return existing

    const running: Running = {
      row: {
        kind: "run",
        id: runRowId(envelope.run_id),
        runId: envelope.run_id,
        runKind: null,
        pid: null,
        railsVersion: null,
        appName: null,
        railsRoot: null,
        marker: false,
        reopened: evictedRuns.has(envelope.run_id),
        overBound: false,
        startedAtWall: envelope.at_wall,
        sqlCount: 0,
        logCount: 0,
        timeline: [],
      },
      echoing: null,
      events: 0,
    }
    byRun.set(envelope.run_id, running)
    open(running)
    return running
  }

  /**
   * Where a row goes when it is opened: the bottom of the table, or — while a load-earlier
   * block is being folded — into that block, whose rows go in above everything held once the
   * block is done. Either way the rule is the one rule: a row sits at the append position of
   * the earliest event the Reader has observed for it.
   */
  function open(owner: Owner) {
    if (earlier === null) rows.push(owner.row)
    else earlier.opened.push(owner)
  }

  /** One more event the fold is holding, against the bound and against its own row. */
  function count(owner: Owner) {
    owner.events += 1
    held += 1
  }

  /**
   * Onto the timeline the event belongs to — or, while a load-earlier block is being folded,
   * into that block's own list for this owner, which goes in *front* of the timeline when
   * the block is done. Held back rather than pushed, because everything the block carries
   * happened before everything the row already holds, and a timeline is in append order.
   */
  function keep(owner: Owner, event: TimelineEvent) {
    const block = earlier
    if (block === null) {
      owner.row.timeline.push(event)
      return
    }

    const buffered = block.prepending.get(owner) ?? []
    block.prepending.set(owner, buffered)
    buffered.push(event)
  }

  /**
   * Interleaving is the arrival itself: within one Run the Initializer takes `seq` at
   * observation and writes inline, so append order and `seq` order are the same order and
   * nothing here sorts. What `seq` decides is *which* list the event joins — past the
   * `request_finish` it is a Trailing event, and a section of its own is where it goes.
   */
  function place(folding: Folding, event: TimelineEvent) {
    const trailing = folding.finishSeq !== null && event.seq > folding.finishSeq
    // Pushed rather than held back even inside a load-earlier block, and safely: a Trailing
    // event is one appended after its own `request_finish`, so a block that ends before the
    // finish cannot be carrying one, and the only trailing section a block ever writes is
    // that of a request it opened, finished and outlived within itself.
    if (trailing) folding.row.trailing.push(event)
    else keep(folding, event)
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
   * one Run, so the two readings are the same clock — the only subtraction that is ever
   * valid here, and the reason two `at_wall`s are never the things subtracted.
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
    for (const envelope of envelopes) foldOne(envelope)
    return evictToBound()
  }

  /**
   * The same fold, run over a block that precedes everything held: the rows it opens are
   * spliced in above the rows already there, and its events go in front of the timelines
   * they precede. Nothing is evicted for having made room for it — the ceiling rises by
   * exactly what came in, so the ring goes on bounding what arrives on its own and this
   * stays what the developer asked for.
   */
  function foldEarlier(envelopes: readonly Envelope[]) {
    const heldBefore = held
    const block: EarlierBlock = { opened: [], prepending: new Map() }
    earlier = block
    try {
      for (const envelope of envelopes) foldOne(envelope)
    } finally {
      earlier = null
    }

    for (const [owner, buffered] of block.prepending) {
      owner.row.timeline = buffered.concat(owner.row.timeline)
    }
    rows.splice(0, 0, ...block.opened.map((owner) => owner.row))
    pulled += block.opened.length
    ceiling += held - heldBefore
    return evictToBound()
  }

  function foldOne(envelope: Envelope) {
    if (alreadyFolded(envelope)) return

    if (envelope.type === "run_header") {
      const opensTheRow = !byRun.has(envelope.run_id)
      const running = runningFor(envelope)
      const row = running.row
      count(running)
      row.runKind = envelope.payload.kind
      row.pid = envelope.payload.pid
      row.railsVersion = envelope.payload.rails_version
      row.appName = envelope.payload.app_name
      row.railsRoot = envelope.payload.rails_root
      // The same gap the Run marker reads above, for a Request row rather than the Run
      // row's own boundary: a *load-earlier* pull can bring this header in after a request
      // on this Run already opened its row not having seen it. Backfilling here is what
      // keeps `RequestRow.railsRoot` meaning "unknown" and not "unknown as of whenever this
      // row happened to open".
      for (const folding of byRequest.values()) {
        if (folding.row.runId === envelope.run_id) folding.row.railsRoot = envelope.payload.rails_root
      }

      if (bootsAWebProcess(envelope.payload.kind)) {
        // The marker goes where this header landed, so it is only ever drawn on a row this
        // header opened — a Run the Reader met further down started somewhere it cannot see.
        if (opensTheRow) row.marker = true
        interrupt((folding) => folding.row.runId !== envelope.run_id, null)
      }
      return
    }

    if (envelope.type === "run_end") {
      // No row of its own: an ending carries nothing for a Run row to hold, and a Run the
      // Reader met at its `run_end` and nowhere else has nothing to show either.
      interrupt((folding) => folding.row.runId === envelope.run_id, envelope)
      return
    }

    const requestId = envelope.request_id
    // Two ways to have no row of one's own to go to, and one answer to both. A `null`
    // `request_id` is *unattributed* on the wire; a request the bound has already taken the
    // row of is unattributed by the attribution horizon closing behind it — and either way
    // its Run owns it. Opening a fresh row for the second would be the fold claiming to have
    // met a request it has in fact shown and forgotten.
    if (requestId === null || evicted.has(requestId)) {
      // Only SQL and App log events have a home without one: a request event that names no
      // request says nothing about any row, and a hand-written Sidecar is the only place
      // one can come from.
      if (envelope.type === "sql" || envelope.type === "app_log") foldIntoRun(envelope)
      return
    }

    const folding = foldingFor(envelope, requestId)
    const row = folding.row
    // Only while in flight: past that the elapsed is a finished request's duration or the
    // frozen reading an Interrupted row keeps.
    if (row.state === "in-flight") proveElapsed(folding, envelope)

    // An *Echo* is dropped from the row rather than marked on it — the Console reads the
    // envelope stream and not this fold, so the line itself survives where the log lives —
    // and, being dropped, it never takes a place under the bound either.
    if (envelope.type === "app_log" && isEcho(folding, envelope)) return
    count(folding)

    switch (envelope.type) {
      case "request_start":
        row.startedAtWall = envelope.at_wall
        row.method = envelope.payload.method
        row.path = envelope.payload.path
        folding.startedAtMono = envelope.at_mono
        row.provenElapsed ??= { ms: 0, atWall: envelope.at_wall }
        // Only a load-earlier pull recovers a start: this one is being folded into a block
        // that sits before everything already held, which is what makes it a start turning
        // up rather than the wire's own order. Live, a child always arrives before its
        // request's own later start only by being out of order, not by the Reader recovering
        // anything, so the mark stays exactly as true as it was.
        if (earlier !== null) row.partial = false
        break
      case "request_route":
        row.controller = envelope.payload.controller
        row.action = envelope.payload.action
        break
      case "request_finish":
        row.status = envelope.payload.status
        // `?? null`, because a finish is allowed to carry no duration: the Initializer leaves
        // the field off rather than emit a nil-derived number when it never saw the start.
        row.durationMs = envelope.payload.duration_ms ?? null
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
        row.logCount += 1
        place(folding, envelope)
        break
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
    count(running)
    // No trailing section: a Run has no finish for anything to trail.
    keep(running, event)
  }

  /**
   * The *Memory bound*, applied once a batch is folded rather than event by event: a batch
   * is what the Sidecar delivered in one read, and evicting inside one would let a row leave
   * before the events already on their way to it had arrived.
   *
   * Oldest first, and three rows it will not take. What a *load-earlier* pulled in, because
   * the bound is on what the Reader accumulates by itself. A request still *in flight*, for
   * the reason below. And the last row standing — which is the one row that is over the
   * bound by itself, a `rake` burst of unattributed queries landing in a single Run row,
   * where evicting it would leave the table empty rather than bounded and trimming inside it
   * would leave a count of 20,000 beside a timeline holding the last few. That is where this
   * bound stops being one, and it is the honest place to stop — though never silently:
   * `updateOverBound` marks whichever row that leaves standing over the ceiling, so the
   * table says so rather than just quietly exceeding it.
   *
   * Returns every row taken, oldest first — the fold's own report of what it let go of,
   * which is how a caller with no bound of its own (the *Console*) learns to let go of the
   * same thing at the same moment, rather than being handed a second ring to keep in step by
   * hand.
   */
  function evictToBound(): readonly EvictedRow[] {
    const taken = new Set<ActivityRow>()
    const takenRows: EvictedRow[] = []
    let standing = rows.length

    for (let index = pulled; index < rows.length && held > ceiling && standing > 1; index++) {
      const row = rows[index]
      if (row === undefined || !evictable(row)) continue

      held -= forget(row)
      taken.add(row)
      takenRows.push({ id: row.id, requestId: row.kind === "request" ? row.requestId : null })
      standing -= 1
    }
    compact(taken)

    // The same retention question, asked of the two things that outlive the rows they are
    // about: what is worth deduplicating, and what is past the horizon. Both are bounded by
    // the one number, so neither can quietly become the thing that grows — and a Trailing
    // event for a request evicted five thousand evictions ago does open a row of its own
    // again, which is the reading left once the fold no longer remembers the row at all.
    keepLatest(folded, ceiling)
    keepLatest(evicted, ceiling)
    keepLatest(evictedRuns, ceiling)

    updateOverBound()
    return takenRows
  }

  /**
   * The mark for the case `evictToBound` just stopped short of: one row left, still over the
   * ceiling, because taking it too would empty the table. Read off `rows.length` rather than
   * off having skipped a row in the loop above, so it says the same thing whether the table
   * arrived at one row by eviction or simply never held more than one to begin with — an
   * oversized row is exactly as `overBound` either way.
   */
  function updateOverBound() {
    const only = rows.length === 1 ? rows[0] : undefined
    const solitary = only !== undefined && held > ceiling ? only : null
    if (solitary === overBoundRow) return

    if (overBoundRow !== null) overBoundRow.overBound = false
    if (solitary !== null) solitary.overBound = true
    overBoundRow = solitary
  }

  /**
   * A request still in flight is never evicted. There is no timeout, ever — and a bound that
   * quietly took the hanging request away once five thousand events had gone past it would
   * be one, measured in other people's traffic rather than in seconds, and hiding the single
   * thing the Reader exists to show. It stays until its Run ends under it: an *Interrupted*
   * row evicts like any other, because that one has been concluded.
   */
  function evictable(row: ActivityRow) {
    return row.kind === "run" || row.state !== "in-flight"
  }

  /** The evicted rows out, in one pass over the array everything else is holding on to. */
  function compact(taken: Set<ActivityRow>) {
    if (taken.size === 0) return

    let kept = 0
    for (const row of rows) if (!taken.has(row)) rows[kept++] = row
    rows.length = kept
  }

  /** Let go of a row, and say how many events the fold stops holding by doing so. */
  function forget(row: ActivityRow) {
    if (row.kind === "run") {
      const running = byRun.get(row.runId)
      byRun.delete(row.runId)
      // Unlike a request, a Run row is opened by whatever its Run says next, and a Run that
      // is still running has every right to another one — so this is remembered only to mark
      // that next row `reopened`, never to stop it opening.
      evictedRuns.add(row.runId)
      return running?.events ?? 0
    }

    const folding = byRequest.get(row.requestId)
    byRequest.delete(row.requestId)
    evicted.add(row.requestId)
    return folding?.events ?? 0
  }

  return { rows, fold, foldEarlier }
}

/** Drop a set's oldest entries: a `Set` iterates in insertion order, which is the ring's. */
function keepLatest(remembered: Set<string>, limit: number) {
  for (const entry of remembered) {
    if (remembered.size <= limit) return
    remembered.delete(entry)
  }
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
  /** What this row costs the *Memory bound*, and what evicting it gives back. */
  events: number
}

/** The same, for a Run: its row, and the query an unattributed *Echo* would be echoing. */
type Running = Echoing & {
  row: RunRow & { timeline: TimelineEvent[] }
  events: number
}

/** The two things that own events, which is the two things the bound holds and lets go of. */
type Owner = Folding | Running

/**
 * A *load-earlier* block, mid-fold. Both halves exist because the block runs backwards
 * against everything else here: the rows it opens belong above the rows already held rather
 * than below them, and its events belong in front of the timelines they precede — so both
 * are collected as the block folds and put in place when it is done, rather than pushed.
 */
type EarlierBlock = {
  opened: Owner[]
  prepending: Map<Owner, TimelineEvent[]>
}
