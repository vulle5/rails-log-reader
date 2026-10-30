import type { AppLogEvent, SqlEvent } from "../../../../shared/wire"
import type { Search } from "../../../hooks/search"
import { bindText } from "./format"
import type { ExceptionContent, TimelineBlock } from "./timeline-layout"

/**
 * How many matches of the current term a query's timeline entry lights, the same ones its
 * components light: its name, its statement matched whole, each bind as it is written (`NULL`
 * for a null), and its Callsite as the `↳ ` line it is shown as. A missing name or an empty
 * Callsite is not shown, so lights nothing. Its `CACHE` and `ASYNC` markers and its duration
 * are the Reader's own words, never matched.
 */
export function queryMatches(search: Search, event: SqlEvent) {
  const { name, sql, binds, callsite } = event.payload
  return (
    (name === null ? 0 : search.find(name).length) +
    search.find(sql).length +
    binds.reduce<number>((count, bind) => count + search.find(bindText(bind)).length, 0) +
    callsiteMatches(search, callsite)
  )
}

/**
 * How many matches a log line's timeline entry lights: each tag, its message, and an App log
 * event's Callsite. A Rails line's Callsite is never shown, and its severity is never matched.
 */
function logLineMatches(search: Search, event: AppLogEvent) {
  const { tags, message, source, callsite } = event.payload
  return (
    tags.reduce<number>((count, tag) => count + search.find(tag).length, 0) +
    search.find(message).length +
    (source === "app" ? callsiteMatches(search, callsite) : 0)
  )
}

/**
 * How many matches the exception block lights: its class, its message, and every frame of its
 * backtrace, a frame folded into a gem-frame marker included, since a match opens its marker.
 */
function exceptionMatches(search: Search, { exception, segments }: ExceptionContent) {
  const frames = segments.flatMap((segment) => (segment.type === "frame" ? [segment.frame] : segment.frames))
  return (
    search.find(exception.class).length +
    search.find(exception.message).length +
    frames.reduce<number>((count, frame) => count + search.find(frame).length, 0)
  )
}

function callsiteMatches(search: Search, callsite: string | undefined) {
  return callsite === undefined || callsite === "" ? 0 : search.find(`↳ ${callsite}`).length
}

/** Whether a block of the Timeline tab lights any match of the current term. A caption is the Reader's own words. */
export function holdsMatch(search: Search, block: TimelineBlock) {
  if (block.kind === "caption") return false
  if (block.kind === "exception") return exceptionMatches(search, block.exception) > 0
  const { event } = block
  return (event.type === "sql" ? queryMatches(search, event) : logLineMatches(search, event)) > 0
}
