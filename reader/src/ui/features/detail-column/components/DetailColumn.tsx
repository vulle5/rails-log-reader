import { memo, useContext, useId, useMemo, useState, type ComponentProps, type ReactNode } from "react"

import type { ActivityRow, EvaluationRow, RequestRow, RowResponse, RunRow, TimelineEvent } from "../../../../shared/activity"
import type { AppLogEvent, BindValue, RequestException, SqlEvent } from "../../../../shared/wire"
import { eventsShown, type DetailFilter } from "./DetailFilters"
import { LevelText } from "../../../components/LevelText"
import { MethodText } from "../../../components/MethodText"
import { LinkButton } from "../../../components/LinkButton"
import { Tag } from "../../../components/Tag"
import { PrettyRawPill } from "../../../components/PrettyRawPill"
import { cn } from "../../../lib/cn"
import { controllerAction, ms, runDescription } from "../../../lib/format"
import { Highlight, Marked, SearchContext, useMatches, type Search } from "../../../hooks/search"
import { Copyable, CopyButton, LineCopy } from "../../../components/CopyButton"
import { bytes, mediaType, size, statusLine } from "../lib/format"
import { Backtrace, Openable } from "../../../components/Backtrace"
import { OpenModifierHeld, useOpenModifierHeld } from "../../../hooks/open-modifier"
import { exceptionText } from "../lib/exception-text"
import { tokenizeSql } from "../lib/sql-highlight"
import { paramsSource } from "../lib/params-source"
import { jsonSource } from "../lib/json-source"
import { xmlSource } from "../lib/xml-source"
import { isHijacked, kindOf, noBodyHint, type NoBodyPayload } from "../lib/no-body"
import { DetailScroller, DetailTabs, type DetailTab, type DetailTabId, type PanelScroll } from "./DetailTabs"
import { ValueViewer } from "../../value-viewer/components/ValueViewer"
import { countMatches } from "../../value-viewer/lib/value-matches"
import type { ValueSource } from "../../value-viewer/lib/value-tree"
import { evaluationEntry, type HeldEntry } from "../../../../shared/repl"
import type { ReplHandle } from "../../repl/hooks/repl-session"
import { RubyCode } from "../../repl/components/RubyCode"
import { ResultPanel, resultLabel } from "../../repl/components/ResultPanel"
import { resultMatches } from "../../repl/lib/entry-matches"

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
  const trailing = row.kind === "run" ? [] : row.trailing
  return eventsShown(row.timeline, filter).length + eventsShown(trailing, filter).length
}

export function DetailColumn({
  row,
  filter,
  railsRoot,
  tab,
  onTab,
  scroll,
  repl,
  actsOnlyFrom,
  onShowInRepl,
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
  /** The *REPL* session, whose *Transcript* an *Evaluation row*'s Result tab reads. */
  repl: Pick<ReplHandle, "snapshot" | "loaded">
  /** Where acts can be made from, when this page is not there, else `null`. */
  actsOnlyFrom: string | null
  /** Opens the REPL drawer at the Transcript entry `entry`. */
  onShowInRepl: (entry: number) => void
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
      ) : row.kind === "evaluation" ? (
        <EvaluationDetail
          row={row}
          filter={filter}
          railsRoot={railsRoot}
          tab={tab}
          onTab={onTab}
          scroll={scroll}
          held={repl.loaded ? evaluationEntry(repl.snapshot, row.pid, row.evaluationId) : null}
          actsOnlyFrom={actsOnlyFrom}
          onShowInRepl={onShowInRepl}
        />
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
  const hint = responseHint(row.response, body)

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
                {trailing.length > 0 && <Trailing caption="After the request finished" events={trailing} railsRoot={railsRoot} />}
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
            hint,
            subject: row.id,
            matches: bodyMatches,
            panel: (
              <Response
                state={row.state}
                method={row.method}
                response={row.response}
                body={body}
                raw={raw}
                onRaw={setRawChosen}
              />
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

/**
 * An *Evaluation row*: headed by `REPL`, its whole input highlighted as Ruby, and what it raised,
 * all off the Sidecar, so the header says what ran after the *Transcript* is gone. While the
 * Transcript holds its entry, Show in REPL opens the drawer at it.
 *
 * Its Timeline holds the queries and log lines it owns, and those that came after it finished in
 * a trailing section of their own, as a request's do. Its Result shows its Transcript entry.
 */
function EvaluationDetail({
  row,
  filter,
  railsRoot,
  tab,
  onTab,
  scroll,
  held,
  actsOnlyFrom,
  onShowInRepl,
}: {
  row: EvaluationRow
  filter: DetailFilter
  railsRoot: string | null
  tab: DetailTabId
  onTab: (tab: DetailTabId) => void
  scroll: PanelScroll
  /** Where its Transcript entry is, or `null` while this page holds no session to look in. */
  held: HeldEntry | null
  actsOnlyFrom: string | null
  onShowInRepl: (entry: number) => void
}) {
  const trailing = eventsShown(row.trailing, filter)
  const label = resultLabel(row.outcome, held)
  const search = useContext(SearchContext)
  // Whether Raw was chosen on the Result tab. Any new Selection, one shown before included,
  // opens pretty.
  const [raw, setRaw] = useState(false)
  const [rawFor, setRawFor] = useState(row.id)
  if (rawFor !== row.id) {
    setRawFor(row.id)
    setRaw(false)
  }
  const entry = held?.kind === "held" ? held.entry : null
  const matches = useMemo(() => (entry === null ? 0 : resultMatches(search, entry, raw)), [search, entry, raw])

  return (
    <Detail
      kind="REPL"
      name=""
      facts={row.sandbox ? "sandbox" : ""}
      action={
        held?.kind === "held" && (
          <LinkButton className="flex-none" onClick={() => onShowInRepl(held.entry.id)}>
            Show in REPL
          </LinkButton>
        )
      }
      below={
        <>
          {row.input !== null && (
            // Held to a few lines, so a long input never pushes the tabs out of reach.
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere">
              <code>
                <RubyCode source={row.input} />
              </code>
            </pre>
          )}
          <Cut field="input" original={row.inputCutFrom ?? undefined} />
          {row.exception !== null && <ExceptionLine className="mt-1" exception={row.exception} />}
          <Cut field="message" original={row.messageCutFrom ?? undefined} />
        </>
      }
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
                {trailing.length > 0 && <Trailing caption="After the evaluation finished" events={trailing} railsRoot={railsRoot} />}
              </>
            ),
          },
          {
            id: "result",
            label: "Result",
            ...(label !== null && { hint: { text: label, tone: "strong" as const } }),
            // Another Selection's result opens at its top, and folded.
            subject: row.id,
            matches,
            panel: <ResultPanel held={held} actsOnlyFrom={actsOnlyFrom} railsRoot={railsRoot} rawView={[raw, setRaw]} />,
          },
        ]}
      />
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

  if (isHijacked(response.payload)) {
    return <p className="px-3 py-2 text-faint">The connection was handed over, so there are no headers to read.</p>
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
 * What the Response tab's label says before it is opened: a bold `json` or `xml` for a kept
 * body, and a faint word for why there is none.
 */
function responseHint(response: RowResponse | null, body: ResponseBody | null): DetailTab["hint"] {
  if (body !== null) return { text: body.format, tone: "strong" }
  if (response === null || !("no_body" in response.payload)) return undefined
  const text = noBodyHint(response.payload)
  return text === undefined ? undefined : { text, tone: "faint" }
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
 * line saying why. The one Copy hands over what is showing. A response with no body has the
 * strip and the reason there is none.
 */
function Response({
  state,
  method,
  response,
  body,
  raw,
  onRaw,
}: {
  state: RequestRow["state"]
  method: string | null
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

  const { payload } = response
  const { status, content_type: contentType, size: sent } = payload
  const original = body?.cutFrom ?? sent
  const strip = [
    statusLine(status),
    // The media type alone: its parameters, such as the charset, are on the Headers tab.
    ...(contentType === null ? [] : [mediaType(contentType)]),
    ...(original === undefined || original === null ? [] : [size(original)]),
  ]
  const stripLine = <p className="font-mono text-xs text-muted tabular-nums">{strip.join(" · ")}</p>

  if (body === null) {
    if (!("no_body" in payload)) return <div className="px-3 py-2">{stripLine}</div>
    return (
      <div className="px-3 py-2">
        {/* A hijacked response has no strip: its status is whatever the app returned after the
            server let go of the connection. */}
        {!isHijacked(payload) && <div className="pb-3">{stripLine}</div>}
        <NoBodyReason payload={payload} method={method} />
      </div>
    )
  }

  const hasTree = body.source !== null
  const caption = (
    <>
      {/* Raised as the copy control is, so Pretty | Raw sit level with it. */}
      <div className="-mt-0.5 flex items-center gap-3 pb-3">
        {stripLine}
        <PrettyRawPill size="md" label="Show the body as" raw={raw} onRaw={onRaw} prettyDisabled={!hasTree} />
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

/**
 * Why a response has no body, in plain words, so the Response tab is never an unexplained
 * blank: what it is and why that can't be previewed, with the size and encoding where the
 * reason turns on them.
 */
function NoBodyReason({ payload, method }: { payload: NoBodyPayload; method: string | null }) {
  const [what, why] = noBodyLines(payload, method)
  return (
    <>
      <p>{what}</p>
      {why !== null && <p className="text-muted">{why}</p>}
    </>
  )
}

/**
 * A reason's lines: what the response is or what happened to it, then why that leaves nothing
 * to preview, when the first line has not already said.
 */
function noBodyLines(payload: NoBodyPayload, method: string | null): [string, ReactNode | null] {
  const sent = payload.size === undefined ? "" : ` (${size(payload.size)})`
  const noBody = payload.no_body
  switch (noBody.reason) {
    case "type":
      return [`This response is ${kindOf(payload.content_type)}${sent}.`, "Only JSON and XML responses can be previewed here."]
    case "streamed":
      return [
        "This response was streamed.",
        `The app sent ${kindOf(payload.content_type)} in pieces as it went, so there was never a whole body to preview.`,
      ]
    case "encoded":
      return [
        `This response is compressed${sent}.`,
        `The app compressed it (${noBody.content_encoding}) before sending it, so it can't be previewed.`,
      ]
    case "empty":
      return ["No body.", emptyBecause(payload, method)]
    case "hijacked":
      return ["The connection was handed over, for example to a WebSocket, so there are no headers and no body.", null]
  }
}

/** The line under "No body.": what the status says, where the redirect goes, or that HEAD asked for none. */
function emptyBecause(payload: NoBodyPayload, method: string | null): ReactNode {
  if (payload.status === 204) return "204 No Content means the request worked and there's nothing to send back."
  if (payload.status === 304) return "304 Not Modified tells the browser to use the copy it already has, so nothing is sent."
  const location = payload.headers.find(([name]) => name.toLowerCase() === "location")?.[1]
  if (payload.status >= 300 && payload.status < 400 && location !== undefined) {
    return (
      <>
        This is a redirect to <code className="font-mono">{location}</code>.
      </>
    )
  }
  if (method === "HEAD") return "A HEAD request asks for the headers alone, so nothing is sent."
  return "The app sent an empty response."
}

/** A body's text exactly as the app sent it: monospace, wrapped, and lit only by *Search*. */
function RawBody({ text }: { text: string }) {
  return (
    <pre className="font-mono text-sm leading-sql whitespace-pre-wrap wrap-anywhere">
      <Highlight text={text} />
    </pre>
  )
}

/**
 * The whole of one row's detail: a heading saying which row is being read, so the column says
 * so without the table beside it, then what it holds. The heading never scrolls: what is under
 * it is its own scrollport. `action` sits at the heading line's far end, and `below` under it.
 */
function Detail({
  kind,
  name,
  facts,
  action,
  below,
  children,
}: {
  kind: ReactNode
  name: string
  facts: string
  action?: ReactNode
  below?: ReactNode
  children: ReactNode
}) {
  return (
    <article className="flex min-h-0 flex-auto flex-col">
      <header className="flex-none border-b border-border bg-raised px-3 py-2 font-mono text-sm">
        <div className="flex items-baseline gap-2">
          {/* A request's method, in its colour, or a *Run row*'s kind, in the accent GET would have. */}
          <span className="font-bold text-accent">{kind}</span>
          <span className="truncate">
            <Highlight text={name} />
          </span>
          {/* The controller action, or a Run row's facts: pushed to the far edge and never wrapped. */}
          <span className="ml-auto whitespace-nowrap text-muted">
            <Highlight text={facts} />
          </span>
          {action}
        </div>
        {below}
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
      className="relative border-y border-border border-t-error py-2 pr-23 pl-3"
      aria-label="Exception"
    >
      {/* Copy, not select-and-copy: the one block on this page an exception is filed from
          somewhere else, so it alone gets a control for it — a query or a log line is easy
          enough to select by hand. */}
      <CopyButton className="absolute top-1.5 right-2" size="md" text={() => exceptionText(exception, cutFrom)} label="Copy exception" />
      <ExceptionLine className="font-mono text-sm" exception={exception} />
      <Backtrace className="mt-1.5" backtrace={exception.backtrace} railsRoot={railsRoot} />
      <Cut field="backtrace" original={cutFrom ?? undefined} />
    </section>
  )
}

/** An exception's class, bold, then its message, in the error colour. */
function ExceptionLine({ className, exception }: { className?: string; exception: { class: string; message: string } }) {
  return (
    <p className={cn("text-error", className)}>
      <span className="font-bold">
        <Highlight text={exception.class} />
      </span>{" "}
      <span>
        <Highlight text={exception.message} />
      </span>
    </p>
  )
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
 * The *trailing section*: events whose `seq` places them after their owner's finish. Visibly
 * separate and captioned, never silently at the end of the timeline — a log line arriving
 * after its request finished is genuinely surprising, and folding it in would read as a
 * Reader bug rather than as the truth about the file. Set apart by a rule as well as the
 * caption, so it cannot be mistaken for the timeline it sits below.
 */
function Trailing({ caption, events, railsRoot }: { caption: string; events: readonly TimelineEvent[]; railsRoot: string | null }) {
  return (
    <section className="mt-3 border-t border-dashed border-border" aria-label={caption}>
      <Caption className="px-3 py-1.5">{caption}</Caption>
      <Timeline events={events} railsRoot={railsRoot} />
    </section>
  )
}

/** A small heading over one part of a panel. */
function Caption({ className, children }: { className?: string; children: ReactNode }) {
  return <h3 className={cn("text-2xs font-semibold tracking-wider text-faint uppercase", className)}>{children}</h3>
}
