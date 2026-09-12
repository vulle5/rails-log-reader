/**
 * The wire contract: one envelope per line of the Sidecar, written by the Initializer and
 * read by the Reader. The two halves are built independently against this file.
 *
 * See `docs/adr/0002-the-event-envelope-and-ordering-key.md`, including its amendments —
 * `run_end` and the pid-keyed `run_id` come from the amendment, not the body.
 */

/**
 * Stamped on every envelope. Bumped when a field changes meaning — including when a field a
 * Reader could once count on becomes one it has to check for. That is a meaning change from
 * the reading half's side even though the field itself still says what it always did: a
 * Reader built before the change reads the absence as `undefined` and renders straight
 * through it, which is the exact failure `isWireVersionUnderstood` exists to refuse.
 *
 * 2: `duration_ms` became optional on a `request_finish` (#45).
 * 3: `status` on a `request_finish` names the controller's own status when one was reached,
 *    rather than the Rack-final one `Rack::ConditionalGet`/`Rack::ETag` can rewrite further
 *    down the middleware stack. Same field, same `number | null` — the moment it names
 *    changed (#53).
 */
export const WIRE_VERSION = 3

export const EVENT_TYPES = [
  "run_header",
  "run_end",
  "request_start",
  "request_route",
  "request_finish",
  "sql",
  "app_log",
] as const

export type EventType = (typeof EVENT_TYPES)[number]

/**
 * What every envelope carries, whatever its type.
 *
 * A request is three events, not one mutable record: `request_start`, `request_route` and
 * `request_finish`. Folding them into one row is the Reader's job, and *in-flight*,
 * *Partial request*, *Interrupted* and *Trailing event* appear nowhere here.
 */
type EventEnvelope<T extends EventType, Payload> = {
  v: number
  /** One boot-to-shutdown Run. Re-derived when `Process.pid` changes, so a forked Puma worker is its own Run. */
  run_id: string
  /** Per-Run integer taken at the moment of observation. Exact within a Run, meaningless across Runs. */
  seq: number
  /** CLOCK_MONOTONIC nanoseconds. Duration and true placement; boot-relative, so unshowable. */
  at_mono: number
  /**
   * Epoch milliseconds. Never sorted, and never subtracted from another `at_wall` — two of
   * them are two processes' opinions, an NTP step apart in either direction. Read for
   * display, and in one place as a distance from the *local* clock: how long ago a line was
   * written, which is what carries an in-flight request's elapsed through a silence.
   */
  at_wall: number
  /** `null` means unattributed: its Run owns it. */
  request_id: string | null
  /**
   * Field name -> original byte length. Backtraces are exempt from the 64 KB per-field cap,
   * but not from the 256 KB whole-line cap — a single line that large can outrun one
   * `write(2)`, so past that cap a backtrace is shrunk too, and recorded here like any other.
   */
  truncated?: Record<string, number>
  type: T
  payload: Payload
}

export type RunKind = "server" | "console" | "rake" | "worker" | "unknown"

export type RunHeaderPayload = {
  kind: RunKind
  rails_version: string
  app_name: string
  rails_root: string
  pid: number
}

/** `run_end` has nothing to say beyond the fact that it happened. */
export type RunEndPayload = Record<string, never>

export type RequestStartPayload = {
  method: string
  path: string
}

/**
 * Emitted only when a controller is entered, so its *absence* is how a routing failure
 * is read. `params` arrives already filtered by the app's own `filter_parameters`.
 */
export type RequestRoutePayload = {
  controller: string
  action: string
  format: string | null
  params: Record<string, unknown>
}

export type RequestException = {
  class: string
  message: string
  /** Full and uncleaned: "the bug was in a gem" stays an answer the Reader can give. */
  backtrace: string[]
}

export type RequestFinishPayload = {
  /**
   * The controller's own status — read from `process_action.action_controller`'s payload —
   * when a controller was reached, and only the Rack-final one otherwise. The two can
   * disagree: `Rack::ConditionalGet`/`Rack::ETag` sit below the Initializer's middleware in
   * the default stack and can swap a controller's 200 for an empty 304 on a matching
   * `If-None-Match`, after Rails has already logged `Completed 200 OK` from the same payload
   * this reads (#53). Before #53, this was always the Rack-final status.
   *
   * `null` where the request raised its way out of the whole middleware stack: no controller
   * was reached, and the Initializer's own middleware reads the status off what `@app.call`
   * returned — which, on that path, returned nothing. An explicit absence, decided in #47 —
   * the client gets its server's 500, but the Initializer never sees it, so it names no status
   * it did not observe. Not rare: `Rails::Rack::Logger` sits above `DebugExceptions`, so a
   * raise there escapes on default settings, and a spoofed `Client-IP` header is enough. The
   * finish is emitted either way, and `exception` below says what raised.
   */
  status: number | null
  /**
   * Absent where the Initializer had no start to measure from — the one thing a finish is
   * allowed not to carry. Absence, as `row_count` below is absent, and never a zero that
   * would read as an instant request. See ADR-0002's amendment from #45.
   */
  duration_ms?: number
  view_runtime_ms?: number
  db_runtime_ms?: number
  exception?: RequestException
}

/**
 * A bind is emitted as-is when it is already a JSON primitive, and otherwise as its `to_s`
 * after the inspection filter has run.
 */
export type BindValue = string | number | boolean | null

export type SqlPayload = {
  /** Raw, as emitted, QueryLogs comment included. Never reformatted. */
  sql: string
  /** `nil` on a raw `connection.execute`. */
  name: string | null
  duration_ms: number
  cached: boolean
  async: boolean
  /** Absent on Rails 7.1 and 7.2, which do not carry it. */
  row_count?: number
  /** Empty is the normal case on mysql2 and trilogy, not a degraded one. */
  binds: BindValue[]
}

/**
 * Every level `Rails.logger` can be called at, quietest first — a tuple rather than a union
 * spelled twice, so the Console's chips are these and cannot drift out of step with them.
 */
export const SEVERITIES = ["debug", "info", "warn", "error", "fatal", "unknown"] as const

export type Severity = (typeof SEVERITIES)[number]

export type AppLogPayload = {
  severity: Severity
  /** ANSI stripped. */
  message: string
  /** Classified by `caller_locations`, so Rails' own lines are labelled rather than dropped. */
  source: "app" | "rails"
  tags: string[]
}

export type RunHeaderEvent = EventEnvelope<"run_header", RunHeaderPayload>
export type RunEndEvent = EventEnvelope<"run_end", RunEndPayload>
export type RequestStartEvent = EventEnvelope<"request_start", RequestStartPayload>
export type RequestRouteEvent = EventEnvelope<"request_route", RequestRoutePayload>
export type RequestFinishEvent = EventEnvelope<"request_finish", RequestFinishPayload>
export type SqlEvent = EventEnvelope<"sql", SqlPayload>
export type AppLogEvent = EventEnvelope<"app_log", AppLogPayload>

/**
 * What identifies one Event: the Run it came from and its `seq` within that Run. `seq`
 * restarts at 1 in every Run, so neither half is an identity alone — together they are, and
 * they are what lets the Reader be handed the same bytes twice. A reconnecting browser and a
 * backward scan overlapping what is already held both cost a `Set` lookup rather than a
 * doubled row or a doubled Console line.
 */
export function eventIdentity(envelope: Pick<Envelope, "run_id" | "seq">) {
  return `${envelope.run_id} ${envelope.seq}`
}

export type Envelope =
  | RunHeaderEvent
  | RunEndEvent
  | RequestStartEvent
  | RequestRouteEvent
  | RequestFinishEvent
  | SqlEvent
  | AppLogEvent
