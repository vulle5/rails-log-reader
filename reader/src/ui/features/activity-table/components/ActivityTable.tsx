import type { ActivityRow } from "../../../../shared/activity"
import { groupingMarks } from "../../../grouping"
import { Highlight } from "../../../hooks/search"
import { clock, controllerAction, count, elapsed, methodCategory, ms, runDescription, statusCategory } from "../../../lib/format"
import { useClimbingElapsed } from "../lib/elapsed"

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
 * whose rows are selectable is one, and `aria-current`, which is what the stylesheet marks it
 * by. *Hover grouping*'s two marks are neither: they are `data-grouping`, never a selection.
 * Selecting from the keyboard is deliberately **not** here. A grid's keyboard contract is a
 * roving tab stop plus arrow-key navigation, and arrow keys moving the selection have to
 * scroll the table to follow, which belongs to the auto-scroll hook and not something to
 * invent in passing. A `tabIndex` on every row would have been the cheap half of that pattern
 * and, at the Memory bound's rows, five thousand tab stops.
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

/** How the Console finds a row to draw to and to scroll to. Written here, because this is what writes it. */
export function rowSelector(id: string) {
  return `[data-row=${CSS.escape(id)}]`
}

type ActivityTableProps = {
  rows: readonly ActivityRow[]
  /** The `id` of the row the detail column is showing, if any. */
  selected: string | null
  /**
   * The far ends of *Hover grouping*: the row of the pinned Console group, and the row of the
   * one under the pointer. Both are distinct from `selected`, and deliberately — hovering
   * draws the connection without moving anything, selection included — and distinct from each
   * other, because a pin a passing hover could put out would not be a pin.
   */
  pinned: string | null
  lit: string | null
  onSelect: (id: string) => void
}

export function ActivityTable({ rows, selected, pinned, lit, onSelect }: ActivityTableProps) {
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
            <RequestRow
              key={row.id}
              row={row}
              selected={row.id === selected}
              pinned={row.id === pinned}
              lit={row.id === lit}
              onSelect={() => onSelect(row.id)}
            />
          ) : (
            <RunRow
              key={row.id}
              row={row}
              selected={row.id === selected}
              pinned={row.id === pinned}
              lit={row.id === lit}
              onSelect={() => onSelect(row.id)}
            />
          ),
        )}
      </tbody>
    </table>
  )
}

type RowProps<T> = { row: T; selected: boolean; pinned: boolean; lit: boolean; onSelect: () => void }

function RequestRow({ row, selected, pinned, lit, onSelect }: RowProps<Request>) {
  return (
    <tr
      className="activity-row"
      // What the Console finds a row by, and what it scrolls to: the fold's own `id`, which
      // is the same string a Console line names its owner with.
      data-row={row.id}
      data-kind="request"
      data-state={row.state}
      {...rowMarks(selected, pinned, lit)}
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
        {/* A different fact from `partial`, and never in tension with it: the *last row
            standing* over the Memory bound's ceiling, whether or not its start was ever seen. */}
        <OverBoundMark row={row} />
      </td>
      <td className="cell-status">
        <Status row={row} />
      </td>
      <td className="cell-method" data-method={methodCategory(row.method)}>
        <Highlight text={row.method ?? ""} />
      </td>
      <td className="cell-path" title={row.path ?? undefined}>
        <Highlight text={row.path ?? ""} />
      </td>
      <td className="cell-action">
        <Highlight text={controllerAction(row)} />
      </td>
      <td className="cell-count">{count(row.sqlCount)}</td>
      <td className="cell-count">{count(row.logCount)}</td>
      <td className="cell-ms">{ms(row.dbRuntimeMs)}</td>
      <td className="cell-ms">{ms(row.viewRuntimeMs)}</td>
      {/* The total: what the request said it took, or — where it said nothing — what the
          Reader can prove it took. A finish that carried no `duration_ms` at all, the
          Initializer having never seen that request start, reads exactly as an in-flight row
          does, as the distance between the request's own first and last events, frozen. Never
          a `0ms` standing in for a number nobody has. */}
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
 *
 * `reopened` is a different mark for a different fact: a Run whose earlier row the *Memory
 * bound* evicted, opening this one fresh because the Run said something unattributed again.
 * It renders nothing like the marker and never sits beside one — a reopened row has no
 * header of its own to draw a boundary from — so it stops reading exactly like a Run the
 * Reader only ever attached inside, which shows neither mark.
 *
 * `overBound` is `OverBoundMark`, shared with `RequestRow` below: the *last row standing*,
 * over the bound's usual ceiling because the table would otherwise be empty rather than
 * bounded. A `rake` burst outgrowing the ceiling before anything else exists to evict is the
 * ordinary way a Run row earns it.
 */
function RunRow({ row, selected, pinned, lit, onSelect }: RowProps<Run>) {
  return (
    <tr
      className="activity-row"
      data-row={row.id}
      data-kind="run"
      data-marker={row.marker ? "" : undefined}
      {...rowMarks(selected, pinned, lit)}
      onClick={onSelect}
    >
      <td className="cell-started">
        {clock(row.startedAtWall)}
        <OverBoundMark row={row} />
      </td>
      <td className="cell-run" colSpan={4}>
        {row.marker && <span className="run-marker-label">Run started</span>}
        {/* Distinct from the Run marker above, and never drawn beside it: a reopened row has
            no header of its own for a marker to be drawn from. */}
        {row.reopened && (
          <span
            className="run-reopened-label"
            title="Its earlier row was evicted under the Memory bound — this Run has said something unattributed again"
          >
            reopened
          </span>
        )}
        {[runDescription(row).kind, ...runDescription(row).facts].map((said) => (
          <span key={said} className="run-said">
            <Highlight text={said} />
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

/**
 * The *last row standing*: the Memory bound would not evict this row without leaving the
 * table empty, so it stands over the ceiling instead of under it. Shown beside the started
 * time on both row kinds, because that is the one cell every row has and neither kind needs
 * for anything else in this rare a case. Never says "trimmed" — nothing here was cut, the
 * row is simply larger than the bound's usual figure.
 */
function OverBoundMark({ row }: { row: Request | Run }) {
  if (!row.overBound) return null

  return (
    <span
      className="over-bound-mark"
      title="Holding more events than the Memory bound's usual ceiling — evicting it would empty the table, so nothing here has been trimmed"
    >
      over bound
    </span>
  )
}

/** What a row wears of *Selection* and of *Hover grouping*, which are never the same mark. */
function rowMarks(selected: boolean, pinned: boolean, lit: boolean) {
  return {
    "aria-selected": selected,
    "aria-current": selected || undefined,
    "data-grouping": groupingMarks(pinned, lit),
  }
}

/**
 * A status when the finish carried one, and otherwise whichever of the three reasons it has
 * none. A finished request with no status is one that raised before it had a response —
 * its exception is in the *Detail column* — and a blank there would read the same as a cell
 * with nothing to say, on the row that most needs to read as an error.
 */
function Status({ row }: { row: Request }) {
  if (row.status !== null) {
    const category = statusCategory(row.status)
    const status = <Highlight text={String(row.status)} />
    // 1xx, 2xx and 3xx get no category and so no span: plain text, uncoloured. 4xx and 5xx get
    // colours of their own via `statusCategory`.
    return category === null ? status : <span data-status={category}>{status}</span>
  }
  if (row.state !== "finished") return <StateDot state={row.state} />

  return (
    <span className="no-status" title="Raised before it had a response">
      none
    </span>
  )
}

/**
 * The whole of what an in-flight row says about itself, beside the elapsed: a dot, pulsing
 * while the request runs and still once its Run has ended under it. Labelled rather than
 * left to colour — the two states differ by whether the dot is moving, which a screen reader
 * cannot see and a still screenshot cannot show.
 */
function StateDot({ state }: { state: Exclude<Request["state"], "finished"> }) {
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
 *
 * Climbing only while the row is in flight: an *Interrupted* row keeps its last reading
 * frozen, and so does a finished row whose finish carried no duration. Both are the same
 * answer — this is how far the file proves it got — and both are set apart from a duration
 * the request itself reported by being seconds in a faded pill rather than milliseconds.
 */
function Elapsed({ row }: { row: Request }) {
  const climbing = row.state === "in-flight"
  const climbed = useClimbingElapsed(row.provenElapsed, climbing)

  if (climbed === null) return null
  return (
    <span className="elapsed" data-elapsed={climbing ? "climbing" : "frozen"}>
      {elapsed(climbed)}
    </span>
  )
}
