import type { ActivityRow } from "../shared/activity"
import { useClimbingElapsed } from "./elapsed"
import { clock, controllerAction, count, elapsed, ms, runDescription } from "./format"

/**
 * The Activity table: one dense, fixed-height row per thing that owns events — a *Request
 * row* or a *Run row*. Rows arrive already in append order and are rendered in it — this
 * component never sorts, and nothing in it may start.
 *
 * Everything unknown renders as absence rather than as a guess: a request still in flight
 * has no status and no duration, and a request that never entered a controller has no
 * `Controller#action`, which is how a routing failure reads.
 *
 * The three states the fold derived are read here as three quiet marks, never as an alarm.
 * An in-flight row has a pulsing dot and a climbing elapsed and no threshold behind either:
 * a request that hangs is the same state as one about to answer, held for as long as it
 * takes, because there is no timeout, ever. An Interrupted row stops both — its Run ended,
 * so no finish is coming — and is set apart without being coloured as an error, because
 * nothing failed. A Partial request says so where its start time would have been, for its
 * whole life.
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

/**
 * The two halves of `ActivityRow`, narrowed once here so the components below can keep the
 * glossary's own names — a *Request row* and a *Run row* are what the table has rows of.
 */
type Request = Extract<ActivityRow, { kind: "request" }>
type Run = Extract<ActivityRow, { kind: "run" }>

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
  rows: readonly ActivityRow[]
  /** The `id` of the row the detail column is showing, if any. */
  selected: string | null
  onSelect: (id: string) => void
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
        {rows.map((row) =>
          row.kind === "request" ? (
            <RequestRow key={row.id} row={row} selected={row.id === selected} onSelect={() => onSelect(row.id)} />
          ) : (
            <RunRow key={row.id} row={row} selected={row.id === selected} onSelect={() => onSelect(row.id)} />
          ),
        )}
      </tbody>
    </table>
  )
}

type RowProps<T> = { row: T; selected: boolean; onSelect: () => void }

function RequestRow({ row, selected, onSelect }: RowProps<Request>) {
  return (
    <tr
      className={rowClassName(["activity-row", `activity-row-${row.state}`], selected)}
      aria-selected={selected}
      onClick={onSelect}
    >
      {/* A *Partial request* has no start to show, which is exactly where it says so: the
          column that would have said when this began says instead that nobody saw it begin. */}
      <td className="cell-started">
        {row.partial ? (
          <span className="partial-mark" title="Its start was never seen — the Reader attached mid-flight">
            partial
          </span>
        ) : (
          clock(row.startedAtWall)
        )}
      </td>
      <td className="cell-status">{row.status ?? <StateDot state={row.state} />}</td>
      <td className="cell-method">{row.method ?? ""}</td>
      <td className="cell-path" title={row.path ?? undefined}>
        {row.path ?? ""}
      </td>
      <td className="cell-action">{controllerAction(row)}</td>
      <td className="cell-count">{count(row.sqlCount)}</td>
      <td className="cell-count">{count(row.logCount)}</td>
      <td className="cell-ms">{ms(row.dbRuntimeMs)}</td>
      <td className="cell-ms">{ms(row.viewRuntimeMs)}</td>
      <td className="cell-ms cell-total">
        {row.durationMs === null ? <Elapsed row={row} /> : ms(row.durationMs)}
      </td>
    </tr>
  )
}

/**
 * A *Run row*: what one Run emitted with no owning request. It spans the columns a request
 * fills with its method, path and outcome, because a Run has none of those — and it keeps
 * the two counts, which are the same two things counted.
 *
 * The *Run marker* is this row wearing a boundary. It means literally *this Run started
 * here* and never *everything below belongs to it*: a rake burst and a live server write
 * into one file, so the rows under a marker are as likely to be another Run's as this one's.
 * That is also why no row anywhere carries a Run tag — the marker is the only thing the
 * table says about which process wrote what, and it says it in one place.
 */
function RunRow({ row, selected, onSelect }: RowProps<Run>) {
  return (
    <tr
      className={rowClassName(["activity-row", "activity-row-run", row.marker ? "activity-row-marker" : ""], selected)}
      aria-selected={selected}
      onClick={onSelect}
    >
      <td className="cell-started">{clock(row.startedAtWall)}</td>
      <td className="cell-run" colSpan={4}>
        {row.marker && <span className="run-marker-label">Run started</span>}
        {[runDescription(row).kind, ...runDescription(row).facts].map((said) => (
          <span key={said} className="run-said">
            {said}
          </span>
        ))}
      </td>
      <td className="cell-count">{count(row.sqlCount)}</td>
      <td className="cell-count">{count(row.logCount)}</td>
      {/* A Run has no db, view or total to show: three empty cells, so the columns beside a
          request's stay the columns they are. */}
      <td className="cell-ms" />
      <td className="cell-ms" />
      <td className="cell-ms cell-total" />
    </tr>
  )
}

function rowClassName(classes: readonly string[], selected: boolean) {
  return [...classes, selected ? "activity-row-selected" : ""].filter((each) => each !== "").join(" ")
}

/**
 * The whole of what an in-flight row says about itself, beside the elapsed: a dot, pulsing
 * while the request runs and still once its Run has ended under it. Labelled rather than
 * left to colour — the two states differ by whether the dot is moving, which a screen reader
 * cannot see and a still screenshot cannot show.
 */
function StateDot({ state }: { state: Request["state"] }) {
  if (state === "finished") return null

  const label = state === "in-flight" ? "In flight" : "Interrupted"
  return (
    <span
      className={`state-dot state-dot-${state}`}
      role="img"
      aria-label={label}
      title={state === "in-flight" ? "Started, and not finished" : "Its Run ended before it finished"}
    />
  )
}

/**
 * The climbing pill. It shows where a *Partial request* would show nothing, because a
 * request whose start was never seen has nothing to be elapsed from — an honest blank rather
 * than a number measured from when the Reader happened to arrive.
 */
function Elapsed({ row }: { row: Request }) {
  const climbing = row.state === "in-flight"
  const climbed = useClimbingElapsed(row.provenElapsed, climbing)

  if (climbed === null) return null
  return <span className={climbing ? "elapsed" : "elapsed elapsed-frozen"}>{elapsed(climbed)}</span>
}
