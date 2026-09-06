import type { RequestRow } from "../shared/activity"
import { clock, controllerAction, count, ms } from "./format"

/**
 * The Activity table: one dense, fixed-height row per request, showing what the page load
 * cost. Rows arrive already in append order and are rendered in it — this component never
 * sorts, and nothing in it may start.
 *
 * Everything unknown renders as absence rather than as a guess: a request still in flight
 * has no status and no duration, and a request that never entered a controller has no
 * `Controller#action`, which is how a routing failure reads.
 *
 * A row is clickable, and clicking one is the whole of *Selection*: what the detail column
 * shows. The table is a `grid` and the showing row carries `aria-selected`, because a table
 * whose rows are selectable is one — but selecting from the keyboard is deliberately **not**
 * here. A grid's keyboard contract is a roving tab stop plus arrow-key navigation, and
 * arrow keys moving the selection have to scroll the table to follow, which is #26's
 * auto-scroll model and not something to invent in passing. A `tabIndex` on every row would
 * have been the cheap half of that pattern and, at the Memory bound's rows, five thousand
 * tab stops.
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

type ActivityTableProps = {
  rows: readonly RequestRow[]
  /** The `requestId` of the row the detail column is showing, if any. */
  selected: string | null
  onSelect: (requestId: string) => void
}

export function ActivityTable({ rows, selected, onSelect }: ActivityTableProps) {
  return (
    <table className="activity" role="grid">
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
          <Row
            key={row.requestId}
            row={row}
            selected={row.requestId === selected}
            onSelect={() => onSelect(row.requestId)}
          />
        ))}
      </tbody>
    </table>
  )
}

type RowProps = { row: RequestRow; selected: boolean; onSelect: () => void }

function Row({ row, selected, onSelect }: RowProps) {
  return (
    <tr
      className={selected ? "activity-row activity-row-selected" : "activity-row"}
      aria-selected={selected}
      onClick={onSelect}
    >
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
