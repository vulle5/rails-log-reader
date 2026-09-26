import { Fragment, type ComponentProps, type ReactNode } from "react"

import type { ActivityRow } from "../../../../shared/activity"
import { MethodText } from "../../../components/MethodText"
import { groupingMarks } from "../../../grouping"
import { Highlight } from "../../../hooks/search"
import { cn } from "../../../lib/cn"
import {
  clock,
  controllerAction,
  count,
  elapsed,
  ms,
  runDescription,
  statusCategory,
} from "../../../lib/format"
import { useClimbingElapsed } from "../lib/elapsed"
import { Badge } from "./Badge"

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
 * Rows are a fixed height, so a row that gains a status or a duration changes what it says
 * without changing what it displaces — and the eye can hold a position in a table that is
 * being appended to underneath it.
 *
 * A row is clickable, and clicking one is the whole of *Selection*: what the detail column
 * shows. The table is a `grid` and the showing row carries `aria-selected`, because a table
 * whose rows are selectable is one, and `aria-current`. *Hover grouping*'s two marks are
 * neither: they are `data-grouping`, never a selection.
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

/**
 * A *Table column*: its header, what it measures, and what it renders for each row kind. A Run
 * row's cell is `"description"` where the column is one the run's description spans instead —
 * the columns a request fills with its method, path and outcome, which a Run has none of. Those
 * columns sit next to each other, because the description is one cell spanning all of them.
 */
type TableColumn = {
  key: string
  heading: string
  /** What the column measures, in one plain-language line: the header's tooltip. */
  description: string
  /** Never hidden: its checkbox is always checked. */
  fixed?: true
  request: (row: Request) => ReactNode
  run: ((row: Run) => ReactNode) | "description"
}

export const TABLE_COLUMNS: readonly TableColumn[] = [
  {
    key: "started",
    heading: "Started",
    fixed: true,
    description: "When it started",
    request: (row) => (
      // A *Partial request* has no start to show, which is exactly where it says so: the
      // column that would have said when this began says instead that nobody saw it begin.
      <Cell className="text-faint group-data-[state=interrupted]:shadow-interrupted">
        {row.partial ? (
          <Badge title="Its start was never seen — the Reader attached mid-flight">partial</Badge>
        ) : (
          clock(row.startedAtWall)
        )}
        {/* A different fact from `partial`, and never in tension with it: the *last row
            standing* over the Memory bound's ceiling, whether or not its start was ever seen. */}
        <OverBoundMark row={row} />
      </Cell>
    ),
    run: (row) => (
      <Cell className="text-faint">
        {clock(row.startedAtWall)}
        <OverBoundMark row={row} />
      </Cell>
    ),
  },
  {
    key: "status",
    heading: "Status",
    fixed: true,
    description: "The HTTP status of the response",
    request: (row) => (
      <Cell>
        <Status row={row} />
      </Cell>
    ),
    run: "description",
  },
  {
    key: "method",
    heading: "Method",
    description: "The HTTP method",
    request: (row) => (
      <Cell className="font-bold">
        {/* Important, because the method's own colour would otherwise outrank the fade. */}
        <MethodText method={row.method} className="group-data-[state=interrupted]:text-faint!">
          <Highlight text={row.method ?? ""} />
        </MethodText>
      </Cell>
    ),
    run: "description",
  },
  {
    key: "path",
    heading: "Path",
    description: "The URL that was requested",
    request: (row) => (
      // The path and the action are capped in characters, the unit they are read in.
      <Cell className="max-w-[40ch] group-data-[state=interrupted]:text-faint" title={row.path ?? undefined}>
        <Highlight text={row.path ?? ""} />
      </Cell>
    ),
    run: "description",
  },
  {
    key: "action",
    heading: "Controller#action",
    description: "The controller action that handled it",
    request: (row) => (
      <Cell className="max-w-[28ch] text-muted group-data-[state=interrupted]:text-faint">
        <Highlight text={controllerAction(row)} />
      </Cell>
    ),
    run: "description",
  },
  {
    key: "sql",
    heading: "SQL",
    description: "How many database queries it ran, including cached ones",
    request: (row) => <NumberCell>{count(row.sqlCount)}</NumberCell>,
    run: (row) => <NumberCell>{count(row.sqlCount)}</NumberCell>,
  },
  {
    key: "log",
    heading: "Log",
    description: "How many log lines it wrote",
    request: (row) => <NumberCell>{count(row.logCount)}</NumberCell>,
    run: (row) => <NumberCell>{count(row.logCount)}</NumberCell>,
  },
  // A Run has no db, view or total to show: empty cells, so the columns beside a request's
  // stay the columns they are.
  {
    key: "db",
    heading: "DB",
    description: "Time spent in the database",
    request: (row) => <NumberCell>{ms(row.dbRuntimeMs)}</NumberCell>,
    run: () => <NumberCell />,
  },
  {
    key: "view",
    heading: "View",
    description: "Time spent rendering views",
    request: (row) => <NumberCell>{ms(row.viewRuntimeMs)}</NumberCell>,
    run: () => <NumberCell />,
  },
  {
    key: "total",
    heading: "Total",
    fixed: true,
    description: `The whole request, middleware included, so a bit longer than Rails' "Completed in" time`,
    // What the request said it took, or — where it said nothing — what the Reader can prove
    // it took. A finish that carried no `duration_ms` at all, the Initializer having never
    // seen that request start, reads exactly as an in-flight row does, as the distance
    // between the request's own first and last events, frozen. Never a `0ms` standing in for
    // a number nobody has.
    request: (row) => <NumberCell total>{row.durationMs === null ? <Elapsed row={row} /> : ms(row.durationMs)}</NumberCell>,
    run: () => <NumberCell total />,
  },
]

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
  /** The `key`s of the table columns the developer hid, which neither the header nor any row renders. */
  hidden: ReadonlySet<string>
}

export function ActivityTable({ rows, selected, pinned, lit, onSelect, hidden }: ActivityTableProps) {
  const columns = TABLE_COLUMNS.filter((column) => !hidden.has(column.key))
  return (
    <table className="w-full border-collapse tabular-nums" role="grid">
      <thead>
        <tr>
          {columns.map((column) => (
            // The path is the column given the slack, and — with Controller#action — the one
            // that may be cut when there is none: everything else is a fixed handful of
            // characters wide.
            <th
              key={column.key}
              className={cn(
                "sticky top-0 z-1 border-b border-border bg-background px-2 py-1 text-left text-2xs font-semibold tracking-wider whitespace-nowrap text-faint uppercase",
                column.key === "path" && "w-full",
              )}
              title={column.description}
            >
              {column.heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) =>
          row.kind === "request" ? (
            <RequestRow
              key={row.id}
              columns={columns}
              row={row}
              selected={row.id === selected}
              pinned={row.id === pinned}
              lit={row.id === lit}
              onSelect={() => onSelect(row.id)}
            />
          ) : (
            <RunRow
              key={row.id}
              columns={columns}
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

type RowProps<T> = {
  columns: readonly TableColumn[]
  row: T
  selected: boolean
  pinned: boolean
  lit: boolean
  onSelect: () => void
}

/**
 * An *Interrupted* row is set apart and set back, and deliberately not in the error colour: a
 * request whose Run was reaped did not fail, it stopped being answerable. Its method, path and
 * action fade, and its first cell carries an edge.
 */
function RequestRow({ columns, row, selected, pinned, lit, onSelect }: RowProps<Request>) {
  return (
    <Row
      className="not-aria-selected:data-[state=interrupted]:bg-sunken"
      // What the Console finds a row by, and what it scrolls to: the fold's own `id`, which
      // is the same string a Console line names its owner with.
      data-row={row.id}
      data-kind="request"
      data-state={row.state}
      {...rowMarks(selected, pinned, lit)}
      onClick={onSelect}
    >
      {columns.map((column) => (
        <Fragment key={column.key}>{column.request(row)}</Fragment>
      ))}
    </Row>
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
 *
 * The marker is a rule across the top of the row, at one position and never a band over the
 * rows under it.
 */
function RunRow({ columns, row, selected, pinned, lit, onSelect }: RowProps<Run>) {
  const descriptionColumns = columns.filter((column) => column.run === "description")
  return (
    <Row
      className="not-aria-selected:bg-sunken data-marker:border-t-2 data-marker:border-t-accent"
      data-row={row.id}
      data-kind="run"
      data-marker={row.marker ? "" : undefined}
      {...rowMarks(selected, pinned, lit)}
      onClick={onSelect}
    >
      {columns.map((column) => {
        if (column.run !== "description") return <Fragment key={column.key}>{column.run(row)}</Fragment>
        // The description takes the place of the first column it covers and spans them all.
        return column === descriptionColumns[0] ? (
          <RunDescriptionCell key={column.key} row={row} colSpan={descriptionColumns.length} />
        ) : null
      })}
    </Row>
  )
}

/** Whether the Run started here or was reopened, and then what kind of process it is and what it said. */
function RunDescriptionCell({ row, colSpan }: { row: Run; colSpan: number }) {
  return (
    <Cell className="text-muted" colSpan={colSpan}>
      {row.marker && (
        <span className="mr-2 font-ui text-2xs font-bold tracking-wider text-accent uppercase">Run started</span>
      )}
      {/* Distinct from the Run marker above, and never drawn beside it: a reopened row has
          no header of its own for a marker to be drawn from. */}
      {row.reopened && (
        <Badge
          className="mr-2"
          title="Its earlier row was evicted under the Memory bound — this Run has said something unattributed again"
        >
          reopened
        </Badge>
      )}
      {/* The separator is drawn rather than written, so it stays out of the row's text. */}
      <span>
        {[runDescription(row).kind, ...runDescription(row).facts].map((said) => (
          <span key={said} className="not-first:before:text-faint not-first:before:content-['_·_']">
            <Highlight text={said} />
          </span>
        ))}
      </span>
    </Cell>
  )
}

/**
 * The *last row standing*: the Memory bound would not evict this row without leaving the
 * table empty, so it stands over the ceiling instead of under it. Shown beside the started
 * time on both row kinds, because that is the one cell every row has and neither kind needs
 * for anything else in this rare a case. Never says "trimmed" — nothing here was cut, the
 * row is simply larger than the bound's usual figure. Always the last thing in its cell, so
 * its margin is only on the side facing what came before it.
 */
function OverBoundMark({ row }: { row: Request | Run }) {
  if (!row.overBound) return null

  return (
    <Badge
      className="ml-1.5"
      title="Holding more events than the Memory bound's usual ceiling — evicting it would empty the table, so nothing here has been trimmed"
    >
      over bound
    </Badge>
  )
}

/**
 * Both row kinds. The selected row and the detail column are one thing seen twice, so the
 * mark is a background, readable at a glance from across the table, and wins over the hover
 * and over a Run row's or an Interrupted row's own.
 */
function Row({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "group h-6 cursor-default border-b border-border aria-selected:bg-selected not-aria-selected:hover:bg-sunken",
        className,
      )}
      {...props}
    />
  )
}

/**
 * Every cell, cut rather than wrapped, so no row grows past the rest.
 *
 * The far end of *Hover grouping*, hovered and pinned, is tinted on the cells rather than the
 * row, so it lies over whatever else the row is saying about itself — in flight, Interrupted,
 * selected — and the pinned group's edge replaces an Interrupted row's.
 */
function Cell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      className={cn(
        "h-6 truncate px-2 font-mono text-sm",
        "group-data-[grouping~=lit]:group-not-data-[grouping~=pinned]:bg-lit group-data-[grouping~=pinned]:bg-pinned group-data-[grouping~=pinned]:first:shadow-pinned-row!",
        className,
      )}
      {...props}
    />
  )
}

/** A count or a duration, which read down a column as numbers do — and the total, set above the durations it sums. */
function NumberCell({ total = false, children }: { total?: boolean; children?: ReactNode }) {
  return <Cell className={cn("text-right text-muted", total && "font-semibold text-foreground")}>{children}</Cell>
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
 * with nothing to say, on the row that most needs to read as an error. It is in the error
 * colour, unlike the state dot, because this one did fail.
 */
function Status({ row }: { row: Request }) {
  if (row.status !== null) {
    const category = statusCategory(row.status)
    const status = <Highlight text={String(row.status)} />
    // 1xx, 2xx and 3xx get no category and so no span: plain text, uncoloured. A 4xx has a
    // colour of its own, never `warn` or `error`, so it is not mistaken for a logged `.warn` or
    // `.error` call; a 5xx is `error`, the failure a finish with no status already reads as.
    return category === null ? (
      status
    ) : (
      <span className="data-[status=4xx]:text-status-4xx data-[status=5xx]:text-error" data-status={category}>
        {status}
      </span>
    )
  }
  if (row.state !== "finished") return <StateDot state={row.state} />

  return (
    <span className="text-error" title="Raised before it had a response">
      none
    </span>
  )
}

/**
 * The whole of what an in-flight row says about itself, beside the elapsed: a dot, pulsing
 * while the request runs and still once its Run has ended under it. Labelled rather than
 * left to colour — the two states differ by whether the dot is moving, which a screen reader
 * cannot see and a still screenshot cannot show.
 *
 * No threshold turns it another colour, and nothing expires: "it hangs" is a conclusion the
 * human draws from a number that climbs. Stopped, it is faint rather than red, because
 * nothing failed. Under reduced motion it stops pulsing and nothing else, since its colour
 * and its label already say which state it is in.
 */
function StateDot({ state }: { state: Exclude<Request["state"], "finished"> }) {
  const label = state === "in-flight" ? "In flight" : "Interrupted"
  return (
    <span
      className="inline-block size-1.75 rounded-full bg-accent align-middle group-data-[state=in-flight]:motion-safe:animate-pulse group-data-[state=interrupted]:bg-faint"
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
 * the request itself reported by being seconds in a faded pill rather than milliseconds. It
 * sits in the column a finished request shows its total in: the same question, asked of a
 * request that has not answered it yet.
 */
function Elapsed({ row }: { row: Request }) {
  const climbing = row.state === "in-flight"
  const climbed = useClimbingElapsed(row.provenElapsed, climbing)

  if (climbed === null) return null
  return (
    <span
      className="inline-block rounded-full bg-elapsed px-1.5 text-accent data-[elapsed=frozen]:bg-sunken data-[elapsed=frozen]:text-faint"
      data-elapsed={climbing ? "climbing" : "frozen"}>
      {elapsed(climbed)}
    </span>
  )
}
