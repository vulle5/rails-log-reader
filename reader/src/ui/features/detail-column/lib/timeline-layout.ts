import type { TimelineEvent } from "../../../../shared/activity"
import type { AppLogEvent, BindValue, SqlEvent } from "../../../../shared/wire"
import type { BacktraceSegment } from "../../../lib/backtrace"
import { unreachable } from "../../../lib/unreachable"
import { bindText } from "./format"

/**
 * Where each block of a Timeline tab sits, estimated from the block's own data rather than read
 * off the page. The browser lays out a timeline entry only once it first comes near the screen,
 * so the page's own heights change as the reader scrolls; these change only when the content or
 * the width does.
 *
 * The estimate wraps a statement, message, Callsite or frame at the characters per line the
 * width allows, and adds fixed heights for everything around it, the numbers below mirroring the
 * classes `DetailColumn` and `Backtrace` draw these blocks with. It drifts from the page by
 * whatever wraps at a word rather than at the last character that fits.
 */

/**
 * What the fonts measure, in ems: a character's advance in the monospace face and, on average,
 * in the UI face, and the `normal` line height both inherit.
 */
export type FontMetrics = { mono: number; text: number; lineHeight: number }

export const FONT_METRICS: FontMetrics = { mono: 0.6, text: 0.52, lineHeight: 1.2 }

/**
 * The exception block: the line naming the exception, its backtrace's segments, which of its
 * gem-frame markers are open (by the `from` of their gap), and whether the wire cut it.
 */
export type ExceptionContent = {
  exception: { class: string; message: string }
  segments: readonly BacktraceSegment[]
  opened: ReadonlySet<number>
  cut: boolean
}

/**
 * The Timeline tab's content as shown: what the chips leave of the timeline and of the trailing
 * section, whose caption is shown while it holds anything.
 */
export type TimelineContent = {
  timeline: readonly TimelineEvent[]
  exception: ExceptionContent | null
  trailing: readonly TimelineEvent[]
}

export type TimelineBlock =
  | { kind: "entry"; section: "timeline" | "trailing"; event: TimelineEvent }
  | { kind: "exception"; exception: ExceptionContent }
  | { kind: "caption" }

/** A block's estimated height, and its top as an offset and as a fraction of the total. */
export type PlacedBlock = TimelineBlock & { height: number; offset: number; fraction: number }

export type TimelineLayout = { blocks: readonly PlacedBlock[]; total: number }

// Font sizes, from `--text-*`.
const TEXT_2XS = 10
const TEXT_XS = 11
const TEXT_SM = 12
const LEADING_SQL = 1.45
const LEADING_NORMAL = 1.5

/** An entry's `px-3`, either side. */
const ENTRY_INSET = 24
/** An entry's `pt-1`, `pb-1.25` and `border-b`. */
const ENTRY_CHROME = 10

/** The `gap-px` between the timeline, the exception block and the trailing section. */
const BLOCK_GAP = 1
/** The scrollport's `pb-6`, under the last block. */
const END_PADDING = 24

/** Every block of `content`, top to bottom, at `width`: the width of the scrollport's content. */
export function timelineLayout(content: TimelineContent, width: number, metrics = FONT_METRICS): TimelineLayout {
  const blocks: TimelineBlock[] = content.timeline.map((event) => ({ kind: "entry", section: "timeline", event }))
  if (content.exception !== null) blocks.push({ kind: "exception", exception: content.exception })
  if (content.trailing.length > 0) {
    blocks.push({ kind: "caption" })
    for (const event of content.trailing) blocks.push({ kind: "entry", section: "trailing", event })
  }

  let offset = 0
  const placed = blocks.map((block) => {
    const top = offset
    const height = blockHeight(block, width, metrics)
    offset += height
    return { ...block, height, offset: top }
  })
  const total = offset + END_PADDING
  return { blocks: placed.map((block) => ({ ...block, fraction: block.offset / total })), total }
}

/** A block's estimated height at `width`, the gap above it included. */
function blockHeight(block: TimelineBlock, width: number, metrics: FontMetrics) {
  switch (block.kind) {
    case "entry":
      return entryHeight(block.event, width, metrics)
    case "exception":
      return BLOCK_GAP + exceptionHeight(block.exception, width, metrics)
    case "caption":
      return BLOCK_GAP + captionHeight(metrics)
    default:
      return unreachable(block)
  }
}

/** One timeline entry's estimated height at `width`, its padding and rule included. */
export function entryHeight(event: TimelineEvent, width: number, metrics = FONT_METRICS) {
  return ENTRY_CHROME + contentHeight(event, width - ENTRY_INSET, metrics)
}

function contentHeight(event: TimelineEvent, width: number, metrics: FontMetrics) {
  switch (event.type) {
    case "sql":
      return queryHeight(event, width, metrics)
    case "app_log":
      return logLineHeight(event, width, metrics)
    default:
      return unreachable(event)
  }
}

/**
 * The height an entry's `contain-intrinsic-size` gives it until it is laid out, in whole pixels:
 * its estimate without its padding and rule, which the browser adds around an intrinsic size.
 */
export function intrinsicHeight(event: TimelineEvent, width: number, metrics = FONT_METRICS) {
  return Math.round(entryHeight(event, width, metrics) - ENTRY_CHROME)
}

function queryHeight(event: SqlEvent, width: number, metrics: FontMetrics) {
  const { sql, binds, callsite } = event.payload
  let height = line(TEXT_XS, metrics)
  // The statement's `mt-0.5`.
  height += 2 + lines(sql, columns(width, TEXT_SM, metrics.mono)) * TEXT_SM * LEADING_SQL
  if (event.truncated?.sql !== undefined) height += CUT_MARGIN + line(TEXT_XS, metrics)
  height += bindsHeight(binds, width, metrics)
  if (event.truncated?.binds !== undefined) height += CUT_MARGIN + line(TEXT_XS, metrics)
  // The Callsite's `mt-1`.
  if (callsite !== undefined && callsite !== "") height += 4 + callsiteHeight(callsite, width, metrics)
  return height
}

/** A log line's `gap-1.5`, across and down. */
const LOG_LINE_GAP = 6

/**
 * A log line is laid out across: its severity and tags, wrapping onto as many lines as they
 * take, then the message in whatever the last of those lines leaves, its cut notice beside it
 * where both fit and under it where they do not, and its Callsite on a line of its own.
 */
function logLineHeight(event: AppLogEvent, width: number, metrics: FontMetrics) {
  const { message, source, tags, callsite } = event.payload
  // `w-[5ch]` in the `text-2xs` monospace, and each tag's `px-1` and border around its text.
  const severity = 5 * TEXT_2XS * metrics.mono
  const tagWidths = tags.map((tag) => tag.length * TEXT_2XS * metrics.mono + 10)
  const before = pack([severity, ...tagWidths], width, LOG_LINE_GAP)
  let left = Math.max(width - before.last - LOG_LINE_GAP, 0)

  let height = (before.rows - 1) * (line(TEXT_SM, metrics) + LOG_LINE_GAP)
  const cut = event.truncated?.message
  if (cut !== undefined) {
    const notice = cutWidth("message", metrics)
    if (notice + LOG_LINE_GAP <= left) left -= notice + LOG_LINE_GAP
    else height += LOG_LINE_GAP + CUT_MARGIN + line(TEXT_XS, metrics)
  }
  height += lines(message, columns(left, TEXT_SM, metrics.text)) * line(TEXT_SM, metrics)
  if (source === "app" && callsite !== undefined && callsite !== "") {
    height += LOG_LINE_GAP + callsiteHeight(callsite, width, metrics)
  }
  return height
}

/**
 * The binds' caption and their chips beside it, where they all fit, and otherwise the chips
 * wrapping on lines of their own under it.
 */
function bindsHeight(binds: readonly BindValue[], width: number, metrics: FontMetrics) {
  if (binds.length === 0) return 0
  // `gap-1` between the caption and the chips and between chips; a chip's `leading-4.25` and
  // border; its `px-1.25` and border around its text.
  const GAP = 4
  const CHIP_HEIGHT = 19
  const chips = binds.map((value) => bindText(value).length * TEXT_XS * metrics.mono + 12)
  // "parameter values", upper-cased and `tracking-wider`.
  const caption = 16 * TEXT_2XS * (metrics.text + 0.05)
  const together = chips.reduce((sum, chip) => sum + GAP + chip, caption)

  // The binds' `mt-1`.
  if (together <= width) return 4 + CHIP_HEIGHT
  const { rows } = pack(chips, width, GAP)
  return 4 + line(TEXT_2XS, metrics) + rows * (GAP + CHIP_HEIGHT)
}

/** `↳ ` and the Callsite, in the monospace `text-xs` it is set in. */
function callsiteHeight(callsite: string, width: number, metrics: FontMetrics) {
  return lines(`↳ ${callsite}`, columns(width, TEXT_XS, metrics.mono)) * line(TEXT_XS, metrics)
}

/** A cut notice's `mt-1`. */
const CUT_MARGIN = 4

/** How wide the notice saying the wire cut `field` is, at the width of a three-digit size. */
function cutWidth(field: string, metrics: FontMetrics) {
  return `${field} was cut by the Sidecar — 999 KB was emitted`.length * TEXT_XS * metrics.text
}

/**
 * The exception's line, then its backtrace: a frame per line or more, a closed marker on one,
 * an open one as the frames it holds.
 */
function exceptionHeight({ exception, segments, opened, cut }: ExceptionContent, width: number, metrics: FontMetrics) {
  // The inset either side: `pl-3`, and `pr-23` for the copy button.
  const inner = width - 12 - 92
  const frameColumns = columns(inner, TEXT_XS, metrics.mono)
  const frameLine = TEXT_XS * LEADING_NORMAL
  const frameHeight = (frame: string) => lines(frame, frameColumns) * frameLine
  // Its line is not `pre-wrap`, so a message's own line breaks fold into spaces.
  const said = `${exception.class} ${exception.message}`.replace(/\s+/g, " ")

  // `border-y` and `py-2`.
  let height = 2 + 16
  height += lines(said, columns(inner, TEXT_SM, metrics.mono)) * line(TEXT_SM, metrics)
  if (segments.length > 0) {
    // The backtrace's `mt-1.5`.
    height += 6
    for (const segment of segments) {
      if (segment.type === "frame") height += frameHeight(segment.frame)
      else if (opened.has(segment.from)) height += segment.frames.reduce((sum, frame) => sum + frameHeight(frame), 0)
      else height += frameLine
    }
  }
  if (cut) height += CUT_MARGIN + line(TEXT_XS, metrics)
  return height
}

/** The trailing section's `mt-3` and rule, and its caption with its `py-1.5`. */
function captionHeight(metrics: FontMetrics) {
  return 12 + 1 + 12 + line(TEXT_2XS, metrics)
}

/** One line of text at `size`, at the `normal` line height. */
function line(size: number, metrics: FontMetrics) {
  return size * metrics.lineHeight
}

/** How many characters of `advance` ems fit across `width` at `size`: never fewer than one. */
function columns(width: number, size: number, advance: number) {
  return Math.max(1, Math.floor(width / (size * advance)))
}

/** How many lines `text` takes wrapped at `columns`, each of its own lines taking one at least. */
function lines(text: string, columns: number) {
  return text.split("\n").reduce((sum, written) => sum + Math.max(1, Math.ceil(written.length / columns)), 0)
}

/**
 * How many lines items of `widths` take, `gap` apart, each going on the line it fits on or
 * starting the next, and how much of the last line they use. An item wider than a line has one
 * to itself.
 */
function pack(widths: readonly number[], width: number, gap: number) {
  let rows = 1
  let last = 0
  for (const item of widths) {
    if (last > 0 && last + gap + item > width) {
      rows += 1
      last = item
    } else {
      last += (last > 0 ? gap : 0) + item
    }
  }
  return { rows, last: Math.min(last, width) }
}

/**
 * A block's element on the page: its index in the layout, and its real top and height in the
 * scrollport's content.
 */
export type BlockOnPage = { index: number; top: number; height: number }

/**
 * The stretch of the scrollport's content on screen, `top` to `bottom` pixels down the
 * `contentHeight` of it, and the block each edge is in: the last whose element starts at or above
 * it, or null above the first.
 */
export type OnScreen = {
  top: number
  bottom: number
  contentHeight: number
  atTop: BlockOnPage | null
  atBottom: BlockOnPage | null
}

/** The thumb's top and size, as fractions of the layout's total. */
export type Thumb = { top: number; size: number }

/**
 * Where the thumb is, on `layout`'s measure, with the screen where `screen` says. Each edge's
 * share into its block's real height is placed at that share of the block's estimated height, so
 * a block's tick is inside the thumb exactly when the block's element starts on screen, however
 * far any block's real height is from its estimate.
 *
 * Past a block's element, before the next one starts, is the gap the layout counts in the next
 * block's height: the edge is at the next block's offset. Past the last element is the port's
 * room under it, placed in the layout's room in proportion. An edge at either end of the content
 * is that end of the layout.
 */
export function thumbOnScreen(layout: TimelineLayout, screen: OnScreen): Thumb {
  if (layout.total <= 0) return { top: 0, size: 1 }
  const { contentHeight } = screen
  const top = screen.top <= 0 ? 0 : placeEdge(layout, screen.top, screen.atTop, contentHeight)
  const bottom = screen.bottom >= contentHeight ? layout.total : placeEdge(layout, screen.bottom, screen.atBottom, contentHeight)
  return { top: top / layout.total, size: Math.max(bottom - top, 0) / layout.total }
}

/** Where `at` pixels down the page, inside `block`, is on `layout`'s measure. */
function placeEdge(layout: TimelineLayout, at: number, block: BlockOnPage | null, contentHeight: number) {
  const placed = block === null ? undefined : layout.blocks[block.index]
  if (block === null || placed === undefined) return 0
  const realBottom = block.top + block.height
  if (at < realBottom) return placed.offset + share(at - block.top, block.height) * placed.height
  const placedBottom = placed.offset + placed.height
  if (block.index < layout.blocks.length - 1) return placedBottom
  return placedBottom + share(at - realBottom, contentHeight - realBottom) * (layout.total - placedBottom)
}

/** How far `into` is through `of`, from 0 to 1. Nothing to be through is all the way through it. */
function share(into: number, of: number) {
  return of <= 0 ? 1 : Math.min(Math.max(into / of, 0), 1)
}
