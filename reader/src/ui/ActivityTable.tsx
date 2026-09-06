import type { RequestRow } from "../shared/activity"

/**
 * The Activity table: one dense, fixed-height row per request, showing what the page load
 * cost. Rows arrive already in append order and are rendered in it — this component never
 * sorts, and nothing in it may start.
 *
 * Everything unknown renders as absence rather than as a guess: a request still in flight
 * has no status and no duration, and a request that never entered a controller has no
 * `Controller#action`, which is how a routing failure reads.
 */

/** Keyed, not slugged from the heading: `Controller#action` makes no usable class name. */
const COLUMNS = [
  ["started", "Started"],
  ["status", "Status"],
  ["method", "Method"],
  ["path", "Path"],
  ["action", "Controller#action"],
  ["sql", "SQL"],
  ["log", "Log"],
  ["db", "DB"],
  ["view", "View"],
  ["total", "Total"],
] as const

export function ActivityTable({ rows }: { rows: readonly RequestRow[] }) {
  return (
    <table className="activity">
      <thead>
        <tr>
          {COLUMNS.map(([key, heading]) => (
            <th key={key} className={`column-${key}`}>
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Row key={row.requestId} row={row} />
        ))}
      </tbody>
    </table>
  )
}

function Row({ row }: { row: RequestRow }) {
  return (
    <tr className="activity-row">
      <td className="cell-started">{clock(row.startedAtWall)}</td>
      <td className="cell-status">{row.status ?? ""}</td>
      <td className="cell-method">{row.method ?? ""}</td>
      <td className="cell-path" title={row.path ?? undefined}>
        {row.path ?? ""}
      </td>
      <td className="cell-action">{controllerAction(row)}</td>
      <td className="cell-count">{count(row.sqlCount)}</td>
      <td className="cell-count">{count(row.logCount)}</td>
      <td className="cell-ms">{ms(row.dbRuntimeMs)}</td>
      <td className="cell-ms">{ms(row.viewRuntimeMs)}</td>
      <td className="cell-ms cell-total">{ms(row.durationMs)}</td>
    </tr>
  )
}

/**
 * `at_wall` is display only: read here, and never sorted on or subtracted anywhere. Local
 * time, because a strictly local tool is read beside the terminal that printed the request.
 */
function clock(at: number | null) {
  if (at === null) return ""

  const when = new Date(at)
  const hours = String(when.getHours()).padStart(2, "0")
  const minutes = String(when.getMinutes()).padStart(2, "0")
  const seconds = String(when.getSeconds()).padStart(2, "0")
  return `${hours}:${minutes}:${seconds}.${String(when.getMilliseconds()).padStart(3, "0")}`
}

/** Rails' own shorthand: the suffix every controller carries says nothing. */
function controllerAction(row: RequestRow) {
  if (row.controller === null) return "—"
  return `${row.controller.replace(/Controller$/, "")}#${row.action ?? ""}`
}

/** A zero is blank, so the eye only ever lands on a count that is there. */
function count(howMany: number) {
  return howMany === 0 ? "" : String(howMany)
}

function ms(duration: number | null) {
  if (duration === null) return ""
  return duration < 10 ? `${duration.toFixed(1)}ms` : `${Math.round(duration)}ms`
}
