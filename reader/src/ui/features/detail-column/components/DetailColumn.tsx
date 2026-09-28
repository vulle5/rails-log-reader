import { memo, useContext, useId, useMemo, useState, type ComponentProps, type ReactNode } from "react"

import type { ActivityRow, RequestRow, RowResponse, RunRow, TimelineEvent } from "../../../../shared/activity"
import type { AppLogEvent, BindValue, RequestException, SqlEvent } from "../../../../shared/wire"
import { eventsShown, type DetailFilter } from "./DetailFilters"
import { LevelText } from "../../../components/LevelText"
import { MethodText } from "../../../components/MethodText"
import { Tag } from "../../../components/Tag"
import { cn } from "../../../lib/cn"
import { controllerAction, ms, runDescription } from "../../../lib/format"
import { Highlight, Marked, SearchContext, useMatches, type Match, type Search } from "../../../hooks/search"
import { CopyButton, LineCopy } from "../../../components/CopyButton"
import { bytes, size, statusLine } from "../lib/format"
import { segmentBacktrace, type BacktraceSegment } from "../lib/backtrace"
import { fillScheme, sourceLocation } from "../lib/source-location"
import { OpenModifierHeld, useOpenModifierHeld } from "../hooks/open-modifier"
import { EditorContext } from "../../../hooks/editor-scheme"
import { withOpenModifier } from "../../../lib/platform"
import { exceptionText } from "../lib/exception-text"
import { tokenizeSql } from "../lib/sql-highlight"
import { paramsSource } from "../lib/params-source"
import { jsonSource } from "../lib/json-source"
import { xmlSource } from "../lib/xml-source"
import { DetailScroller, DetailTabs, type DetailTabId, type PanelScroll } from "./DetailTabs"
import { ValueViewer } from "../../value-viewer/components/ValueViewer"
import { countMatches } from "../../value-viewer/lib/value-matches"
import type { ValueSource } from "../../value-viewer/lib/value-tree"

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
  tab,
  onTab,
  scroll,
}: {
  row: ActivityRow | null
  filter: DetailFilter
  /** The live Run's `rails_root`, off `RunIdentity` — see `RequestDetail`'s own doc. */
  railsRoot: string | null
  /** The *Detail tab* chosen, which outlives any one Selection. */
  tab: DetailTabId
  onTab: (tab: DetailTabId) => void
  /** The column's *auto-scroll*, which follows the timeline's own scrollport. */
  scroll: PanelScroll
}) {
  const held = useOpenModifierHeld()

  if (row === null) {
    return (
      <p className="p-5 text-center text-faint">
        Nothing selected — pick a row in the Activity table, or a line in the Console.
      </p>
    )
  }

  return (
    <OpenModifierHeld value={held}>
      {row.kind === "request" ? (
        <RequestDetail row={row} filter={filter} railsRoot={railsRoot} tab={tab} onTab={onTab} scroll={scroll} />
      ) : (
        <RunDetail row={row} filter={filter} railsRoot={railsRoot} scroll={scroll} />
      )}
    </OpenModifierHeld>
  )
}

function RequestDetail({
  row,
  filter,
  railsRoot,
  tab,
  onTab,
  scroll,
}: {
  row: RequestRow
  filter: DetailFilter
  /**
   * The live Run's `rails_root`, off `RunIdentity` rather than `row.railsRoot`: the row's own
   * copy is display-only and can revert to `null` when its Run row is evicted and reopens,
   * where `RunIdentity`'s does not — see the *Run identity* glossary entry.
   */
  railsRoot: string | null
  tab: DetailTabId
  onTab: (tab: DetailTabId) => void
  scroll: PanelScroll
}) {
  // Filtered once each, rather than where they are rendered: `trailing` is read twice below —
  // once for whether the section exists at all, once for what it holds — and a second pass
  // over the same array for the same filter would say nothing a first pass had not already.
  const trailing = eventsShown(row.trailing, filter)
  const search = useContext(SearchContext)
  const params = useMemo(() => (row.params === null ? null : paramsSource(row.params)), [row.params])
  const paramsMatches = useMemo(() => (params === null ? 0 : countMatches(search, params.tree)), [search, params])
  const headersMatches = useMemo(() => headerMatches(search, row.response), [search, row.response])
  const body = useMemo(() => responseBody(row.response), [row.response])
  // Whether Raw was chosen on the Response tab. Any new Selection, one shown before included,
  // opens pretty.
  const [rawChosen, setRawChosen] = useState(false)
  const [rawFor, setRawFor] = useState(row.id)
  if (rawFor !== row.id) {
    setRawFor(row.id)
    setRawChosen(false)
  }
  const raw = body !== null && (rawChosen || body.source === null)
  const bodyMatches = useMemo(() => responseBodyMatches(search, body, raw), [search, body, raw])

  return (
    <Detail
      kind={
        <MethodText method={row.method}>
          <Highlight text={row.method ?? ""} />
        </MethodText>
      }
      name={row.path ?? ""}
      facts={controllerAction(row)}
    >
      <DetailTabs
        chosen={tab}
        onChoose={onTab}
        tabs={[
          {
            id: "timeline",
            label: "Timeline",
            scroll,
            panel: (
              <>
                <Timeline label="Timeline" events={eventsShown(row.timeline, filter)} railsRoot={railsRoot} />
                {row.exception !== null && (
                  <Exception exception={row.exception} cutFrom={row.backtraceCutFrom} railsRoot={railsRoot} />
                )}
                {/* Checked on the filtered length rather than `row.trailing.length`: a trailing
                    block of nothing but SCHEMA queries, hidden, must not leave an empty "After the
                    request finished" section behind — the section is about there being something
                    to show under it. */}
                {trailing.length > 0 && <Trailing events={trailing} railsRoot={railsRoot} />}
              </>
            ),
          },
          {
            id: "params",
            label: "Params",
            // A request that never reached a controller has none: `null` is that reading.
            disabled: params === null,
            // Another Selection's params open at their top, and folded.
            subject: row.id,
            matches: paramsMatches,
            panel: params !== null && <Params source={params} />,
          },
          {
            id: "headers",
            label: "Headers",
            // Enabled on every finished request, one that never reached a controller included.
            disabled: row.state !== "finished",
            subject: row.id,
            matches: headersMatches,
            panel: <ResponseHeaders response={row.response} />,
          },
          {
            id: "response",
            label: "Response",
            // Waiting while in flight, but an interrupted request's response never comes.
            disabled: row.state === "interrupted",
            hint: body === null ? undefined : { text: body.format, tone: "strong" },
            subject: row.id,
            matches: bodyMatches,
            panel: (
              <Response state={row.state} response={row.response} body={body} raw={raw} onRaw={setRawChosen} />
            ),
          },
        ]}
      />
    </Detail>
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
function RunDetail({
  row,
  filter,
  railsRoot,
  scroll,
}: {
  row: RunRow
  filter: DetailFilter
  railsRoot: string | null
  scroll: PanelScroll
}) {
  const { kind, facts } = runDescription(row)

  return (
    // No tab bar: a Run has nothing but its timeline to show.
    <Detail kind={<Highlight text={kind} />} name={row.appName ?? ""} facts={facts.join(" · ")}>
      <DetailScroller className="flex-auto" scroll={scroll}>
        <Timeline label="Timeline" events={eventsShown(row.timeline, filter)} railsRoot={railsRoot} />
      </DetailScroller>
    </Detail>
  )
}

/** A request's params in the *Value viewer*: everything params-specific is in `paramsSource`. */
function Params({ source }: { source: ValueSource }) {
  return (
    <div className="px-3 py-2">
      <ValueViewer label="Params" source={source} />
    </div>
  )
}

/**
 * A request's response headers, as its *Response event* carries them: every one, sorted by name
 * whatever its case, a repeated header repeated in the order the app set it, under a "Response
 * headers" heading and the status. Copy all copies them in that same order.
 */
function ResponseHeaders({ response }: { response: RowResponse | null }) {
  if (response === null) {
    return <p className="px-3 py-2 text-faint">No response was recorded for this request.</p>
  }

  const { status } = response.payload
  const headers = byName(response.payload.headers)
  return (
    <div className="px-3 py-2">
      <Copyable text={headers.length > 0 ? headersText(headers) : null} label="Copy all headers">
        <div className="flex items-baseline gap-2 pb-3">
          <Caption>Response headers</Caption>
          <span className="font-mono text-xs text-muted tabular-nums">{status}</span>
        </div>
        {headers.length === 0 ? (
          <p className="text-faint">The response set no headers.</p>
        ) : (
          <ul className="font-mono text-sm leading-sql" aria-label="Response headers">
            {headers.map(([name, value], at) => (
              // A header can repeat, so its place is the only identity it has.
              <ResponseHeader key={at} name={name} value={value} />
            ))}
          </ul>
        )}
      </Copyable>
    </div>
  )
}

/**
 * A block with one copy control for the whole of it, placed as the *Value viewer* places its
 * own: centred on the block's first line, which the right padding keeps clear of it. No text,
 * no control.
 */
function Copyable({ text, label, children }: { text: string | null; label: string; children: ReactNode }) {
  return (
    <div className="relative pr-15">
      {text !== null && <CopyButton className="-top-0.5 right-0" text={text} label={label} />}
      {children}
    </div>
  )
}

/** One header, named by its own line, `name: value`, which its copy control is described by. */
function ResponseHeader({ name, value }: { name: string; value: string }) {
  const line = useId()
  return (
    <li className="group/line break-all" aria-labelledby={line}>
      <span id={line}>
        <span className="text-sql-identifier">
          <Highlight text={name} />
          {": "}
        </span>
        <Highlight text={value} />
      </span>
      <LineCopy label="Copy value" idle="copy" text={() => value} line={line} />
    </li>
  )
}

/**
 * Headers sorted by name, ignoring case. The sort is stable, so headers sharing a name keep the
 * order the app set them in, which is the one order HTTP gives a meaning to.
 */
function byName(headers: readonly [string, string][]) {
  return headers.toSorted(([one], [other]) => {
    const [a, b] = [one.toLowerCase(), other.toLowerCase()]
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/** Every header, one per line, as `Name: value`. */
function headersText(headers: readonly (readonly [string, string])[]) {
  return headers.map(([name, value]) => `${name}: ${value}`).join("\n")
}

/** How many matches of the current term lie in a response's headers, the same ones `ResponseHeaders` lights. */
function headerMatches(search: Search, response: RowResponse | null) {
  if (response === null) return 0
  return response.payload.headers.reduce(
    (count, [name, value]) => count + search.find(name).length + search.find(value).length,
    0,
  )
}

/**
 * A kept body: its format, the text the app sent, the tree to draw it as when it has one, and
 * the size it was cut from when the wire cut it.
 */
type ResponseBody = { format: "json" | "xml"; text: string; source: ValueSource | null; cutFrom: number | null }

/**
 * A response's kept body, parsed only here, for the one request selected. A body the wire cut,
 * or one that does not parse as its format, has no tree.
 */
function responseBody(response: RowResponse | null): ResponseBody | null {
  if (response === null || !("body" in response.payload)) return null
  const { format, body: text } = response.payload
  const cutFrom = response.bodyCutFrom
  const source = cutFrom !== null ? null : format === "json" ? jsonSource(text) : xmlSource(text)
  return { format, text, source, cutFrom }
}

/**
 * How many matches of the current term lie in a response's body, the same ones `Response` lights,
 * showing it raw or pretty.
 */
function responseBodyMatches(search: Search, body: ResponseBody | null, raw: boolean) {
  if (body === null) return 0
  return raw || body.source === null ? search.find(body.text).length : countMatches(search, body.source.tree)
}

/**
 * The Response tab: a strip saying the status, the content type and the size the app sent, and
 * beside it Pretty | Raw, then the body. Pretty draws it in the *Value viewer*, and Raw as the
 * text the app sent. Every body opens pretty, a new Selection's included. A body with no tree,
 * cut or not valid JSON or XML, is raw only, Pretty drawn struck through and disabled, with a
 * line saying why. The one Copy hands over what is showing.
 */
function Response({
  state,
  response,
  body,
  raw,
  onRaw,
}: {
  state: RequestRow["state"]
  response: RowResponse | null
  body: ResponseBody | null
  /** Whether the body shows raw: always, for a body with no tree. */
  raw: boolean
  onRaw: (raw: boolean) => void
}) {
  if (response === null) {
    return (
      <p className="px-3 py-2 text-faint">
        {state === "in-flight" ? "Waiting for the response…" : "No response for this request."}
      </p>
    )
  }

  const { status, content_type: contentType, size: sent } = response.payload
  const original = body?.cutFrom ?? sent
  const strip = [
    statusLine(status),
    // The media type alone: its parameters, such as the charset, are on the Headers tab.
    ...(contentType === null ? [] : [contentType.split(";")[0]?.trim() ?? contentType]),
    ...(original === undefined || original === null ? [] : [size(original)]),
  ]
  const stripLine = <p className="font-mono text-xs text-muted tabular-nums">{strip.join(" · ")}</p>

  if (body === null) {
    return <div className="px-3 py-2">{stripLine}</div>
  }

  const hasTree = body.source !== null
  const caption = (
    <>
      <div className="flex items-baseline gap-3 pb-3">
        {stripLine}
        <BodyView hasTree={hasTree} raw={raw} onRaw={onRaw} />
      </div>
      {body.cutFrom !== null ? (
        <p className="pb-3 text-faint">
          {`This response is ${bytes(body.cutFrom)}, and only the first 64 KB is shown. Because it's cut off, it can only be shown as raw text.`}
        </p>
      ) : (
        !hasTree && (
          <p className="pb-3 text-faint">
            {`This body isn't valid ${body.format.toUpperCase()}, so it can only be shown as raw text.`}
          </p>
        )
      )}
    </>
  )
  return (
    <div className="px-3 py-2">
      {body.source !== null && !raw ? (
        <ValueViewer label="Response body" source={body.source} caption={caption} />
      ) : (
        <Copyable text={body.text} label="Copy response body">
          {caption}
          <RawBody text={body.text} />
        </Copyable>
      )}
    </div>
  )
}

/** A body's text exactly as the app sent it: monospace, wrapped, and lit only by *Search*. */
function RawBody({ text }: { text: string }) {
  return (
    <pre className="font-mono text-sm leading-sql whitespace-pre-wrap wrap-anywhere">
      <Highlight text={text} />
    </pre>
  )
}

/** Pretty | Raw, the pressed one showing. Pretty is disabled, and struck through, when the body has no tree. */
function BodyView({ hasTree, raw, onRaw }: { hasTree: boolean; raw: boolean; onRaw: (raw: boolean) => void }) {
  return (
    <div className="flex gap-0.5" role="group" aria-label="Show the body as">
      <BodyViewButton pressed={!raw} disabled={!hasTree} onClick={() => onRaw(false)}>
        Pretty
      </BodyViewButton>
      <BodyViewButton pressed={raw} onClick={() => onRaw(true)}>
        Raw
      </BodyViewButton>
    </div>
  )
}

function BodyViewButton({
  pressed,
  disabled = false,
  onClick,
  children,
}: {
  pressed: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="cursor-pointer rounded border border-transparent px-1.5 font-ui text-2xs text-muted not-aria-pressed:enabled:hover:bg-sunken disabled:cursor-default disabled:text-faint disabled:line-through aria-pressed:border-border aria-pressed:bg-selected aria-pressed:text-foreground"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/**
 * The whole of one row's detail: a heading saying which row is being read, so the column says
 * so without the table beside it, then what it holds. The heading never scrolls: what is under
 * it is its own scrollport.
 */
function Detail({ kind, name, facts, children }: { kind: ReactNode; name: string; facts: string; children: ReactNode }) {
  return (
    <article className="flex min-h-0 flex-auto flex-col">
      <header className="flex flex-none items-baseline gap-2 border-b border-border bg-raised px-3 py-2 font-mono text-sm">
        {/* A request's method, in its colour, or a *Run row*'s kind, in the accent GET would have. */}
        <span className="font-bold text-accent">{kind}</span>
        <span className="truncate">
          <Highlight text={name} />
        </span>
        {/* The controller action, or a Run row's facts: pushed to the far edge and never wrapped. */}
        <span className="ml-auto whitespace-nowrap text-muted">
          <Highlight text={facts} />
        </span>
      </header>
      {children}
    </article>
  )
}

/** Renders whatever it is handed — filtering is each caller's own job, done exactly once,
 * because this is reused from three call sites and a filter applied here would run again for
 * every one of them. */
function Timeline({
  label,
  events,
  railsRoot,
}: {
  /** Absent in the trailing section, whose own heading already names what it lists. */
  label?: string
  events: readonly TimelineEvent[]
  railsRoot: string | null
}) {
  return (
    <ol aria-label={label}>
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

/**
 * Every entry starts at the same left edge and is laid out identically. That is the whole
 * mechanism behind an N+1 being obvious: fifty near-identical children become fifty blocks the
 * eye can see are the same, one chip apart.
 *
 * Off-screen entries skip layout and paint entirely, which is what keeps a scroll-driven reflow
 * over a thousand-entry timeline cheap. `auto` in `contain-intrinsic-size` keeps an entry's last
 * rendered height once the browser has measured it, so each kind's estimate — a query's is taller
 * than a log line's — only matters before that: for the first paint, and for an entry that never
 * becomes visible at all.
 */
function Entry({ className, ...props }: ComponentProps<"li">) {
  return <li className={cn("border-b border-border px-3 pt-1 pb-1.25 [content-visibility:auto]", className)} {...props} />
}

const Query = memo(function Query({ event, railsRoot }: { event: SqlEvent; railsRoot: string | null }) {
  const { sql, name, duration_ms, cached, async, binds, callsite } = event.payload

  return (
    <Entry className="[contain-intrinsic-size:auto_110px]">
      <div className="flex items-baseline gap-1.5 text-xs text-muted">
        {/* What `development.log` prefixes these with, and the reason a query took no time. */}
        {cached && <SqlMarker>CACHE</SqlMarker>}
        {async && <SqlMarker>ASYNC</SqlMarker>}
        {/* `nil` on a raw `connection.execute`, which is then a query with no name rather
            than a query with a blank one. */}
        {name !== null && (
          <span className="font-semibold text-foreground">
            <Highlight text={name} />
          </span>
        )}
        <span className="ml-auto font-mono tabular-nums">{ms(duration_ms)}</span>
      </div>
      <Statement sql={sql} />
      <Cut field="sql" original={event.truncated?.sql} />
      <Binds values={binds} />
      <Cut field="binds" original={event.truncated?.binds} />
      {/* Where `verbose_query_logs`' own `↳` line would sit, and shown whatever that setting
          is: the Initializer captures a query's *Callsite* regardless of it. */}
      <Callsite className="mt-1" callsite={callsite} railsRoot={railsRoot} />
    </Entry>
  )
})

function SqlMarker({ children }: { children: ReactNode }) {
  return <span className="font-mono text-2xs font-bold tracking-wider text-faint">{children}</span>
}

/**
 * One statement, coloured and searched. The search is matched on the statement whole and
 * never token by token, because the tokens are the highlighter's idea and not the reader's:
 * `posts"."id` is three of them in three colours, and one thing typed. Each token then marks
 * its own share of the matches, so a match keeps the colours it crosses.
 *
 * `pre-wrap` wraps a long query without touching a character of it: what is read is what
 * pastes into a console.
 */
function Statement({ sql }: { sql: string }) {
  const matches = useMatches(sql)
  const tokens = useMemo(() => tokenizeSql(sql), [sql])
  let from = 0

  return (
    <code className="mt-0.5 block font-mono text-sm leading-sql whitespace-pre-wrap wrap-anywhere">
      {/* The tokens partition one string in order, so a token's position is its identity —
          and the running length of the ones before it is where it starts in the statement. */}
      {tokens.map((token, at) => {
        const start = from
        from += token.text.length
        return (
          // The colour of each kind of token the SQL tokenizer names, read off its `data-token`.
          <span
            key={at}
            className={cn(
              "data-[token=keyword]:font-semibold data-[token=keyword]:text-sql-keyword",
              "data-[token=identifier]:text-sql-identifier",
              "data-[token=string]:text-sql-string",
              "data-[token=number]:text-sql-number",
              "data-[token=placeholder]:font-semibold data-[token=placeholder]:text-sql-placeholder",
              "data-[token=comment]:text-sql-comment data-[token=comment]:italic",
            )}
            data-token={token.kind}
          >
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

  // Not styled as an error — nothing failed. It is the file saying what it could not carry,
  // and it has to be legible without pretending the query is broken.
  return <p className="mt-1 text-xs text-faint italic">{`${field} was cut by the Sidecar — ${bytes(original)} was emitted`}</p>
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
    <div className="mt-1 flex flex-wrap items-baseline gap-1" role="group" aria-label={BINDS_LABEL}>
      <span className="text-2xs tracking-wider text-faint uppercase" title={BINDS_LABEL}>
        parameter values
      </span>
      <ul className="flex flex-wrap gap-1">
        {/* Binds are positional — `$1` is the first — so a bind's position is its identity. */}
        {values.map((value, at) => {
          const kind = bindKind(value)
          return (
            // Each kind in the colour its SQL token has, so a bind reads as the literal it stands for.
            <li
              key={at}
              className={cn(
                "rounded-chip border border-border bg-sunken px-1.25 font-mono text-xs leading-4.25",
                kind === "string" && "text-sql-string",
                kind === "number" && "text-sql-number",
                kind === "boolean" && "text-sql-keyword",
                kind === "null" && "text-faint italic",
              )}
            >
              <Highlight text={value === null ? "NULL" : String(value)} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

type BindKind = "null" | "string" | "number" | "boolean"

/**
 * Which of the four colours a bind is set in: `null`, a string, a number, or — everything else
 * a bind can be — a boolean.
 */
function bindKind(value: BindValue): BindKind {
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
    // Laid out across rather than down, so a run of queries is not broken up by something that
    // looks like another query. It wraps only so that a callsite can start a line of its own.
    <Entry
      className="group flex flex-wrap items-baseline gap-1.5 bg-sunken text-sm [contain-intrinsic-size:auto_28px]"
      data-level={severity}
      data-source={source}
    >
      {/* Five characters, the longest of the usual severities, so every message starts at one edge. */}
      <LevelText className="w-[5ch] flex-none font-mono text-2xs tracking-wider text-faint uppercase">{severity}</LevelText>
      {tags.map((tag) => (
        <Tag key={tag}>
          <Highlight text={tag} />
        </Tag>
      ))}
      {/* Grows into the row rather than wrapping under the severity. Rails' own lines are set
          back, whatever their level: the developer's own calls are the ones the eye should land
          on first. Important, because the level's colour would otherwise outrank it. */}
      <LevelText className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere group-data-[source=rails]:text-muted!">
        <Highlight text={message} />
      </LevelText>
      <Cut field="message" original={event.truncated?.message} />
      {/* The message itself is never searched for a path to open, a `↳` line kept in the
          timeline included: only the structured field is known to be a Callsite. */}
      {source === "app" && <Callsite className="basis-full" callsite={callsite} railsRoot={railsRoot} />}
    </Entry>
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
    // The right padding keeps the message clear of the copy button, which is anchored here and
    // not to the column.
    <section
      className="relative border-y border-border border-t-error py-2 pr-15 pl-3"
      aria-label="Exception"
    >
      {/* Copy, not select-and-copy: the one block on this page an exception is filed from
          somewhere else, so it alone gets a control for it — a query or a log line is easy
          enough to select by hand. */}
      <CopyButton text={exceptionText(exception, cutFrom)} label="Copy exception" />
      <p className="font-mono text-sm text-error">
        <span className="font-bold">
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
    // Full and uncleaned, so it is long: it scrolls with the column rather than being capped.
    <ol
      className="mt-1.5 font-mono text-xs leading-normal whitespace-pre-wrap text-muted wrap-anywhere"
      aria-label="Backtrace"
    >
      {segments.map((segment) =>
        segment.type === "frame" ? (
          // The Host app's own frames, at full contrast against the muted rest.
          <li
            key={segment.index}
            className="data-[frame=host]:text-strong"
            data-frame={segment.host ? "host" : undefined}
          >
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
      <button
        type="button"
        className="cursor-pointer font-mono text-xs text-faint italic underline decoration-dotted hover:text-muted focus-visible:text-muted"
        onClick={onReveal}
      >
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
    <p className={cn("font-mono text-xs text-muted wrap-anywhere", className)}>
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
        className="data-armed:cursor-pointer data-armed:underline"
        data-armed={hovered && held ? "" : undefined}
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
 * Reader bug rather than as the truth about the file. Set apart by a rule as well as the
 * caption, so it cannot be mistaken for the timeline it sits below.
 */
function Trailing({ events, railsRoot }: { events: readonly TimelineEvent[]; railsRoot: string | null }) {
  return (
    <section className="mt-3 border-t border-dashed border-border" aria-label="After the request finished">
      <Caption className="px-3 py-1.5">After the request finished</Caption>
      <Timeline events={events} railsRoot={railsRoot} />
    </section>
  )
}

/** A small heading over one part of a panel. */
function Caption({ className, children }: { className?: string; children: ReactNode }) {
  return <h3 className={cn("text-2xs font-semibold tracking-wider text-faint uppercase", className)}>{children}</h3>
}
