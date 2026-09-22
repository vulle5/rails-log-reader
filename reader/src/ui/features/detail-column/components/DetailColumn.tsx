import { memo, useContext, useMemo, useState } from "react"

import type { ActivityRow, RequestRow, RunRow, TimelineEvent } from "../../../../shared/activity"
import type { AppLogEvent, BindValue, RequestException, SqlEvent } from "../../../../shared/wire"
import { eventsShown, type DetailFilter } from "./DetailFilters"
import { controllerAction, methodClassName, ms, runDescription } from "../../../lib/format"
import { Highlight, Marked, SearchContext, useMatches, type Match } from "../../../hooks/search"
import { CopyButton } from "./CopyButton"
import { bytes } from "../lib/format"
import { segmentBacktrace, type BacktraceSegment } from "../lib/backtrace"
import { fillScheme, sourceLocation } from "../lib/source-location"
import { OpenModifierHeld, useOpenModifierHeld } from "../hooks/open-modifier"
import { EditorContext } from "../../../hooks/editor-scheme"
import { withOpenModifier } from "../../../lib/platform"
import { exceptionText } from "../lib/exception-text"
import { tokenizeSql } from "../lib/sql-highlight"

/**
 * The rightmost column: one selected row's timeline, its SQL and `Rails.logger` lines
 * interleaved in the order they were emitted, so a log line reads as the explanation of the
 * query that follows it. An N+1-shaped request's fifty near-identical children are then
 * obvious to the eye — twenty rows that are visibly the same, one chip apart — without the
 * Reader claiming to have detected anything.
 *
 * Nothing here reformats: a query is rendered as the Initializer emitted it, comment and
 * all, tokenized into spans that put the text back together character for character. What
 * is read is what `development.log` showed and what pastes into a console — SCHEMA and
 * EXPLAIN queries included, unless `DetailFilters`' one chip is hiding them: `development.log`
 * itself never shows them at all.
 *
 * The column is present from the first paint whether or not anything is selected — the
 * placeholder is what pins it — so selecting a row changes what this holds and nothing
 * about the layout around it.
 */
/**
 * How much this column is rendering, which is what its *auto-scroll* counts arrivals by. Here
 * rather than where the hook is called, because it is a fact about what this file draws: a Run
 * row has no trailing section to add, and a column that stopped rendering one would otherwise
 * leave the pill quietly counting things nobody can scroll to. Filtered the same way the
 * timeline itself is, for the same reason `showingLines.length` and not `lines.length` is what
 * the Console's own auto-scroll counts: a query the chip is hiding is not one the reader would
 * find by scrolling down.
 */
export function detailItems(row: ActivityRow | null, filter: DetailFilter) {
  if (row === null) return 0
  const trailing = row.kind === "request" ? row.trailing : []
  return eventsShown(row.timeline, filter).length + eventsShown(trailing, filter).length
}

export function DetailColumn({
  row,
  filter,
  railsRoot,
}: {
  row: ActivityRow | null
  filter: DetailFilter
  /** The live Run's `rails_root`, off `RunIdentity` — see `RequestDetail`'s own doc. */
  railsRoot: string | null
}) {
  const held = useOpenModifierHeld()

  if (row === null) {
    return (
      <p className="placeholder">
        Nothing selected — pick a row in the Activity table, or a line in the Console.
      </p>
    )
  }

  return (
    <OpenModifierHeld value={held}>
      {row.kind === "request" ? (
        <RequestDetail row={row} filter={filter} railsRoot={railsRoot} />
      ) : (
        <RunDetail row={row} filter={filter} railsRoot={railsRoot} />
      )}
    </OpenModifierHeld>
  )
}

function RequestDetail({
  row,
  filter,
  railsRoot,
}: {
  row: RequestRow
  filter: DetailFilter
  /**
   * The live Run's `rails_root`, off `RunIdentity` rather than `row.railsRoot`: the row's own
   * copy is display-only and can revert to `null` when its Run row is evicted and reopens,
   * where `RunIdentity`'s does not — see the *Run identity* glossary entry.
   */
  railsRoot: string | null
}) {
  // Filtered once each, rather than where they are rendered: `trailing` is read twice below —
  // once for whether the section exists at all, once for what it holds — and a second pass
  // over the same array for the same filter would say nothing a first pass had not already.
  const trailing = eventsShown(row.trailing, filter)

  return (
    <article className="detail">
      <header className="detail-heading">
        <span className={`detail-method ${methodClassName(row.method)}`}>
          <Highlight text={row.method ?? ""} />
        </span>
        <span className="detail-path">
          <Highlight text={row.path ?? ""} />
        </span>
        <span className="detail-action">
          <Highlight text={controllerAction(row)} />
        </span>
      </header>

      <Timeline events={eventsShown(row.timeline, filter)} railsRoot={railsRoot} />
      {row.exception !== null && (
        <Exception exception={row.exception} cutFrom={row.backtraceCutFrom} railsRoot={railsRoot} />
      )}
      {/* Checked on the filtered length rather than `row.trailing.length`: a trailing block of
          nothing but SCHEMA queries, hidden, must not leave an empty "After the request
          finished" section behind — the section is about there being something to show
          under it. */}
      {trailing.length > 0 && <Trailing events={trailing} railsRoot={railsRoot} />}
    </article>
  )
}

/**
 * A *Run row*'s timeline: everything that Run emitted with no owning request, read the same
 * way a request's children are. The division of labour with the Console is the glossary's —
 * the Console is where you read *when* something happened, and this is where you read
 * *what*.
 *
 * No trailing section and no exception: a Run has no finish for anything to trail, and an
 * exception on the wire belongs to a request.
 */
function RunDetail({ row, filter, railsRoot }: { row: RunRow; filter: DetailFilter; railsRoot: string | null }) {
  const { kind, facts } = runDescription(row)

  return (
    <article className="detail">
      <header className="detail-heading">
        <span className="detail-method">
          <Highlight text={kind} />
        </span>
        <span className="detail-path">
          <Highlight text={row.appName ?? ""} />
        </span>
        <span className="detail-action">
          <Highlight text={facts.join(" · ")} />
        </span>
      </header>

      <Timeline events={eventsShown(row.timeline, filter)} railsRoot={railsRoot} />
    </article>
  )
}

/** Renders whatever it is handed — filtering is each caller's own job, done exactly once,
 * because this is reused from three call sites and a filter applied here would run again for
 * every one of them. */
function Timeline({ events, railsRoot }: { events: readonly TimelineEvent[]; railsRoot: string | null }) {
  return (
    <ol className="timeline">
      {/* `(run_id, seq)` is the event identity everywhere else in the Reader, and a key is
          one more place it saves inventing one. */}
      {events.map((event) =>
        event.type === "sql" ? (
          <Query key={`${event.run_id} ${event.seq}`} event={event} railsRoot={railsRoot} />
        ) : (
          <LogLine key={`${event.run_id} ${event.seq}`} event={event} railsRoot={railsRoot} />
        ),
      )}
    </ol>
  )
}

const Query = memo(function Query({ event, railsRoot }: { event: SqlEvent; railsRoot: string | null }) {
  const { sql, name, duration_ms, cached, async, binds, callsite } = event.payload

  return (
    <li className="entry entry-sql">
      <div className="entry-head">
        {/* What `development.log` prefixes these with, and the reason a query took no time. */}
        {cached && <span className="sql-marker">CACHE</span>}
        {async && <span className="sql-marker">ASYNC</span>}
        {/* `nil` on a raw `connection.execute`, which is then a query with no name rather
            than a query with a blank one. */}
        {name !== null && (
          <span className="sql-name">
            <Highlight text={name} />
          </span>
        )}
        <span className="sql-duration">{ms(duration_ms)}</span>
      </div>
      <Statement sql={sql} />
      <Cut field="sql" original={event.truncated?.sql} />
      <Binds values={binds} />
      <Cut field="binds" original={event.truncated?.binds} />
      {/* Where `verbose_query_logs`' own `↳` line would sit, and shown whatever that setting
          is: the Initializer captures a query's *Callsite* regardless of it. */}
      <Callsite className="sql-callsite" callsite={callsite} railsRoot={railsRoot} />
    </li>
  )
})

/**
 * One statement, coloured and searched. The search is matched on the statement whole and
 * never token by token, because the tokens are the highlighter's idea and not the reader's:
 * `posts"."id` is three of them in three colours, and one thing typed. Each token then marks
 * its own share of the matches, so a match keeps the colours it crosses.
 */
function Statement({ sql }: { sql: string }) {
  const matches = useMatches(sql)
  const tokens = useMemo(() => tokenizeSql(sql), [sql])
  let from = 0

  return (
    <code className="sql">
      {/* The tokens partition one string in order, so a token's position is its identity —
          and the running length of the ones before it is where it starts in the statement. */}
      {tokens.map((token, at) => {
        const start = from
        from += token.text.length
        return (
          <span key={at} className={`sql-${token.kind}`}>
            <Marked text={token.text} from={start} matches={matches} />
          </span>
        )
      })}
    </code>
  )
}

/**
 * What the wire's `truncated` map is for. A field the Initializer cut must say so where it
 * is read: the whole promise of this column is that what is on screen is what was emitted
 * and pastes into a console, and a statement silently missing its tail breaks that promise
 * quietly — the one way a log reader is never allowed to be wrong. `undefined` is the
 * overwhelmingly normal case and renders nothing.
 */
function Cut({ field, original }: { field: string; original: number | undefined }) {
  if (original === undefined) return null

  return <p className="cut">{`${field} was cut by the Sidecar — ${bytes(original)} was emitted`}</p>
}

/**
 * Labelled as *this query's parameter values*, and never as values sent to the database:
 * trilogy never parameterizes a query at the wire level, so the second phrasing would be
 * false there specifically. The caption is on screen and not only in the `aria-label`,
 * because the false reading is the one a developer arrives with — a row of chips under a
 * query reads as "what the database got" unless something says otherwise, and a caption
 * nobody sees corrects nobody.
 */
const BINDS_LABEL = "This query's parameter values"

function Binds({ values }: { values: readonly BindValue[] }) {
  // No chips, rather than an empty container with nothing in it: on mysql2 and trilogy an
  // empty bind list is the ordinary case, not a degraded one.
  if (values.length === 0) return null

  return (
    <div className="binds" role="group" aria-label={BINDS_LABEL}>
      <span className="binds-label" title={BINDS_LABEL}>
        parameter values
      </span>
      <ul className="bind-chips">
        {/* Binds are positional — `$1` is the first — so a bind's position is its identity. */}
        {values.map((value, at) => (
          <li key={at} className={`bind bind-${bindKind(value)}`}>
            <Highlight text={value === null ? "NULL" : String(value)} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Named for the stylesheet rather than taken from `typeof`, so the set of classes the CSS
 * has to answer for is written down here and cannot grow by accident.
 */
function bindKind(value: BindValue): "null" | "string" | "number" | "boolean" {
  if (value === null) return "null"
  if (typeof value === "string") return "string"
  if (typeof value === "number") return "number"
  return "boolean"
}

const LogLine = memo(function LogLine({ event, railsRoot }: { event: AppLogEvent; railsRoot: string | null }) {
  const { severity, message, source, tags, callsite } = event.payload

  return (
    // Rails' own lines are kept and labelled apart rather than dropped: `Started GET` is all
    // a request that died before reaching a controller ever says about itself.
    <li className={`entry entry-log log-${severity} log-from-${source}`}>
      <span className="log-severity">{severity}</span>
      {tags.map((tag) => (
        <span key={tag} className="log-tag">
          <Highlight text={tag} />
        </span>
      ))}
      <span className="log-message">
        <Highlight text={message} />
      </span>
      <Cut field="message" original={event.truncated?.message} />
      {/* The message itself is never searched for a path to open, a `↳` line kept in the
          timeline included: only the structured field is known to be a Callsite. None on a
          `rails`-sourced line: `source_of` labels a line `rails` exactly when its Callsite
          is inside a gem, so it only ever says where Rails formatted the message. */}
      {source === "app" && <Callsite className="log-callsite" callsite={callsite} railsRoot={railsRoot} />}
    </li>
  )
})

function Exception({
  exception,
  cutFrom,
  railsRoot,
}: {
  exception: RequestException
  cutFrom: number | null
  railsRoot: string | null
}) {
  return (
    <section className="exception" aria-label="Exception">
      {/* Copy, not select-and-copy: the one block on this page an exception is filed from
          somewhere else, so it alone gets a control for it — a query or a log line is easy
          enough to select by hand. */}
      <CopyButton text={exceptionText(exception, cutFrom)} label="Copy exception" />
      <p className="exception-message">
        <span className="exception-class">
          <Highlight text={exception.class} />
        </span>{" "}
        <Highlight text={exception.message} />
      </p>
      <Backtrace backtrace={exception.backtrace} railsRoot={railsRoot} />
      <Cut field="backtrace" original={cutFrom ?? undefined} />
    </section>
  )
}

/**
 * Collapse state lives in this component's own `useState`, not on the exception or the
 * row: selecting elsewhere unmounts it, so the next selection starts from an empty
 * `revealed` set with no explicit reset.
 */
function Backtrace({ backtrace, railsRoot }: { backtrace: readonly string[]; railsRoot: string | null }) {
  const search = useContext(SearchContext)
  // Only ever grows: nothing removes an entry once revealed.
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set())
  const segments = useMemo(() => segmentBacktrace(backtrace, railsRoot), [backtrace, railsRoot])
  const held = useContext(OpenModifierHeld)

  return (
    <ol className="backtrace">
      {segments.map((segment) =>
        segment.type === "frame" ? (
          <li key={segment.index} className={segment.host ? "backtrace-host" : undefined}>
            <Frame frame={segment.frame} railsRoot={railsRoot} held={held} />
          </li>
        ) : (
          <GapSegment
            key={segment.from}
            segment={segment}
            railsRoot={railsRoot}
            held={held}
            revealed={revealed.has(segment.from) || segment.frames.some((frame) => search.find(frame).length > 0)}
            onReveal={() => setRevealed((prev) => new Set(prev).add(segment.from))}
          />
        ),
      )}
    </ol>
  )
}

function GapSegment({
  segment,
  railsRoot,
  held,
  revealed,
  onReveal,
}: {
  segment: Extract<BacktraceSegment, { type: "gap" }>
  railsRoot: string | null
  held: boolean
  revealed: boolean
  onReveal: () => void
}) {
  if (revealed) {
    return (
      <>
        {segment.frames.map((frame, at) => (
          <li key={segment.from + at}>
            <Frame frame={frame} railsRoot={railsRoot} held={held} />
          </li>
        ))}
      </>
    )
  }

  return (
    <li>
      <button type="button" className="backtrace-reveal" onClick={onReveal}>
        {segment.frames.length === 1 ? "1 frame hidden" : `${segment.frames.length} frames hidden`}
      </button>
    </li>
  )
}

function Frame({ frame, railsRoot, held }: { frame: string; railsRoot: string | null; held: boolean }) {
  return <Openable frame={frame} matches={useMatches(frame)} railsRoot={railsRoot} held={held} />
}

/**
 * An SQL or App log event's *Callsite*, as `verbose_query_logs` prints one: `↳ ` and the raw
 * value, never shortened. Searched as the whole line, so a term can run across the `↳`. Not
 * when empty, which a hand-written Sidecar line can be: a bare `↳` says nothing.
 */
function Callsite({
  className,
  callsite,
  railsRoot,
}: {
  className: string
  callsite: string | undefined
  railsRoot: string | null
}) {
  const matches = useMatches(`↳ ${callsite ?? ""}`)
  const held = useContext(OpenModifierHeld)
  if (callsite === undefined || callsite === "") return null

  return (
    <p className={className}>
      <Marked text="↳ " matches={matches} />
      <Openable frame={callsite} from={2} matches={matches} railsRoot={railsRoot} held={held} />
    </p>
  )
}

/**
 * One raw frame, a backtrace's or a Callsite's, starting at `from` in the text `matches` were
 * found in. Where it holds a *Source location*, its `path:line` — and never the method after
 * it — opens in the editor on an open-modifier click, and a plain click stays a text
 * selection. Underlined only while it is hovered *and* `held`, so pressing the modifier alone
 * restyles nothing. A click with no *Editor scheme* set asks for one and opens nothing, not
 * even once one has been given.
 */
function Openable({
  frame,
  from = 0,
  matches,
  railsRoot,
  held,
}: {
  frame: string
  from?: number
  matches: readonly Match[]
  railsRoot: string | null
  held: boolean
}) {
  const editor = useContext(EditorContext)
  const [hovered, setHovered] = useState(false)
  const location = sourceLocation(frame, railsRoot)

  if (location === null) return <Marked text={frame} from={from} matches={matches} />

  return (
    <>
      <span
        className={hovered && held ? "source-location source-location-armed" : "source-location"}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        // Ctrl-mousedown would otherwise add a selection range in Firefox before the click.
        onMouseDown={(event) => {
          if (withOpenModifier(event)) event.preventDefault()
        }}
        onClick={(event) => {
          if (!withOpenModifier(event)) return
          event.preventDefault()
          if (editor.scheme === null) editor.requestScheme()
          else window.location.assign(fillScheme(editor.scheme, location))
        }}
      >
        <Marked text={frame.slice(0, location.end)} from={from} matches={matches} />
      </span>
      <Marked text={frame.slice(location.end)} from={from + location.end} matches={matches} />
    </>
  )
}

/**
 * The *trailing section*: events whose `seq` places them after the `request_finish`. Visibly
 * separate and captioned, never silently at the end of the timeline — a log line arriving
 * after its request finished is genuinely surprising, and folding it in would read as a
 * Reader bug rather than as the truth about the file.
 */
function Trailing({ events, railsRoot }: { events: readonly TimelineEvent[]; railsRoot: string | null }) {
  return (
    <section className="trailing" aria-label="After the request finished">
      <h3>After the request finished</h3>
      <Timeline events={events} railsRoot={railsRoot} />
    </section>
  )
}
