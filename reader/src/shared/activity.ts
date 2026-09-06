import type { Envelope } from "./wire"

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
  logCount: number
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
  const byRequest = new Map<string, RequestRow>()
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

  function rowFor(envelope: Envelope, requestId: string) {
    const existing = byRequest.get(requestId)
    if (existing !== undefined) return existing

    const row: RequestRow = {
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
    }
    byRequest.set(requestId, row)
    rows.push(row)
    return row
  }

  function fold(envelopes: readonly Envelope[]) {
    for (const envelope of envelopes) {
      if (alreadyFolded(envelope)) continue

      const requestId = envelope.request_id
      if (requestId === null) continue // its Run owns it, and Run rows are #23

      const row = rowFor(envelope, requestId)

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
          break
        case "sql":
          row.sqlCount += 1
          break
        case "app_log":
          row.logCount += 1
          break
      }
    }
  }

  return { rows, fold }
}
