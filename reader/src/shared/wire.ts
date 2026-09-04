/**
 * The wire contract: one envelope per line of the Sidecar, written by the Initializer and
 * read by the Reader. The two halves are built independently against this file.
 *
 * See `docs/adr/0002-the-event-envelope-and-ordering-key.md`, including its amendments —
 * `run_end` and the pid-keyed `run_id` come from the amendment, not the body.
 */

/** Stamped on every envelope. Bumped when a field changes meaning. */
export const WIRE_VERSION = 1

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
  /** Epoch milliseconds. Display only — never sorted, never subtracted. */
  at_wall: number
  /** `null` means unattributed: its Run owns it. */
  request_id: string | null
  /** Field name -> original byte length, for the fields truncated at 64 KB. Backtraces are exempt. */
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
  status: number
  duration_ms: number
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

export type Severity = "debug" | "info" | "warn" | "error" | "fatal" | "unknown"

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

export type Envelope =
  | RunHeaderEvent
  | RunEndEvent
  | RequestStartEvent
  | RequestRouteEvent
  | RequestFinishEvent
  | SqlEvent
  | AppLogEvent
