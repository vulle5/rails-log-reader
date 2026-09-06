import type { RequestRow, TimelineEvent } from "../shared/activity"
import type { AppLogEvent, BindValue, RequestException, SqlEvent } from "../shared/wire"
import { controllerAction, ms } from "./format"
import { tokenizeSql } from "./sql-highlight"

/**
 * The rightmost column: one selected row's timeline, its SQL and `Rails.logger` lines
 * interleaved in the order they were emitted, so a log line reads as the explanation of the
 * query that follows it. An N+1-shaped request's fifty near-identical children are then
 * obvious to the eye — twenty rows that are visibly the same, one chip apart — without the
 * Reader claiming to have detected anything.
 *
 * Nothing here reformats: a query is rendered as the Initializer emitted it, comment and
 * all, tokenized into spans that put the text back together character for character. What
 * is read is what `development.log` showed and what pastes into a console.
 *
 * The column is present from the first paint whether or not anything is selected — the
 * placeholder is what pins it — so selecting a row changes what this holds and nothing
 * about the layout around it.
 */
export function DetailColumn({ row }: { row: RequestRow | null }) {
  if (row === null) {
    return (
      <p className="placeholder">
        Nothing selected — pick a row in the Activity table, or a line in the Console.
      </p>
    )
  }

  return (
    <article className="detail">
      <header className="detail-heading">
        <span className="detail-method">{row.method ?? ""}</span>
        <span className="detail-path">{row.path ?? ""}</span>
        <span className="detail-action">{controllerAction(row)}</span>
      </header>

      <Timeline events={row.timeline} />
      {row.exception !== null && <Exception exception={row.exception} cutFrom={row.backtraceCutFrom} />}
      {row.trailing.length > 0 && <Trailing events={row.trailing} />}
    </article>
  )
}

function Timeline({ events }: { events: readonly TimelineEvent[] }) {
  return (
    <ol className="timeline">
      {/* `(run_id, seq)` is the event identity everywhere else in the Reader, and a key is
          one more place it saves inventing one. */}
      {events.map((event) =>
        event.type === "sql" ? (
          <Query key={`${event.run_id} ${event.seq}`} event={event} />
        ) : (
          <LogLine key={`${event.run_id} ${event.seq}`} event={event} />
        ),
      )}
    </ol>
  )
}

function Query({ event }: { event: SqlEvent }) {
  const { sql, name, duration_ms, cached, async, binds } = event.payload

  return (
    <li className="entry entry-sql">
      <div className="entry-head">
        {/* What `development.log` prefixes these with, and the reason a query took no time. */}
        {cached && <span className="sql-marker">CACHE</span>}
        {async && <span className="sql-marker">ASYNC</span>}
        {/* `nil` on a raw `connection.execute`, which is then a query with no name rather
            than a query with a blank one. */}
        {name !== null && <span className="sql-name">{name}</span>}
        <span className="sql-duration">{ms(duration_ms)}</span>
      </div>
      <code className="sql">
        {/* The tokens partition one string in order, so a token's position is its identity. */}
        {tokenizeSql(sql).map((token, at) => (
          <span key={at} className={`sql-${token.kind}`}>
            {token.text}
          </span>
        ))}
      </code>
      <Cut field="sql" original={event.truncated?.sql} />
      <Binds values={binds} />
      <Cut field="binds" original={event.truncated?.binds} />
    </li>
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

function bytes(howMany: number) {
  return howMany < 1024 ? `${howMany} bytes` : `${Math.round(howMany / 1024)} KB`
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
            {value === null ? "NULL" : String(value)}
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

function LogLine({ event }: { event: AppLogEvent }) {
  const { severity, message, source, tags } = event.payload

  return (
    // Rails' own lines are kept and labelled apart rather than dropped: `Started GET` is all
    // a request that died before reaching a controller ever says about itself.
    <li className={`entry entry-log log-${severity} log-from-${source}`}>
      <span className="log-severity">{severity}</span>
      {tags.map((tag) => (
        <span key={tag} className="log-tag">
          {tag}
        </span>
      ))}
      <span className="log-message">{message}</span>
      <Cut field="message" original={event.truncated?.message} />
    </li>
  )
}

function Exception({ exception, cutFrom }: { exception: RequestException; cutFrom: number | null }) {
  return (
    <section className="exception" aria-label="Exception">
      <p className="exception-message">
        <span className="exception-class">{exception.class}</span> {exception.message}
      </p>
      {/* Full and uncleaned, gem frames and all, so "the bug was in a gem" stays an answer
          the Reader can give. Nothing here drops a frame for looking like someone else's —
          and on the one occasion the wire itself had to, it says so underneath. */}
      <ol className="backtrace">
        {exception.backtrace.map((frame, at) => (
          <li key={at}>{frame}</li>
        ))}
      </ol>
      <Cut field="backtrace" original={cutFrom ?? undefined} />
    </section>
  )
}

/**
 * The *trailing section*: events whose `seq` places them after the `request_finish`. Visibly
 * separate and captioned, never silently at the end of the timeline — a log line arriving
 * after its request finished is genuinely surprising, and folding it in would read as a
 * Reader bug rather than as the truth about the file.
 */
function Trailing({ events }: { events: readonly TimelineEvent[] }) {
  return (
    <section className="trailing" aria-label="After the request finished">
      <h3>After the request finished</h3>
      <Timeline events={events} />
    </section>
  )
}
