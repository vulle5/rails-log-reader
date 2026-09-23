import type { ConsoleLine } from "../../../../shared/console"
import { groupingMarks } from "../../../grouping"
import { Highlight } from "../../../hooks/search"

/**
 * The **Console rail**: the leftmost of the Reader's three columns, and a global stream of
 * every App log event in *append order* — attributed and unattributed alike, and **no SQL at
 * all**. Queries outnumber log lines several times over, so a rail that held them would bury
 * the `Rails.logger` call you are looking for, which is the one thing this column is for.
 *
 * Rails' own lines are kept and labelled rather than dropped, because `Started GET` is all a
 * request that died before reaching a controller ever says about itself. The label is on the
 * line and not only in its colour: what `source` says is a fact the Initializer read off
 * `caller_locations`, and it is worth as much to a screen reader as to the eye.
 *
 * One line per entry, cut with an ellipsis rather than wrapped. The rail is scanned rather
 * than read — a uniform rhythm is what makes a busy one something the eye can sweep — and it
 * gives the gutter rule one unambiguous height to point at. Nothing is lost by it: the whole
 * message is a `title` away, and one click away in the detail column, which is where a line
 * is read rather than found.
 *
 * Clicking is *Selection* and hovering is *Hover grouping*; neither is reachable from the
 * keyboard here, for the reason the Activity table gives: a roving tab stop with arrow-key
 * navigation is a contract of its own, and a `tabIndex` on every line would be the cheap
 * half of it and, at the *Memory bound*, thousands of tab stops.
 */

/** How the rule and the jump find a line. Written here, because this is what writes it. */
export function lineSelector(id: string) {
  return `[data-line=${CSS.escape(id)}]`
}

type ConsoleRailProps = {
  /** Already thinned by the level chips: the rail renders what it is handed. */
  lines: readonly ConsoleLine[]
  /** The `owner` of the pinned group: lit until another line is clicked. */
  pinned: string | null
  /** The `owner` of the group under the pointer, lit for as long as it is under it. */
  hovered: string | null
  onHover: (line: ConsoleLine | null) => void
  onPick: (line: ConsoleLine) => void
}

export function ConsoleRail({ lines, pinned, hovered, onHover, onPick }: ConsoleRailProps) {
  return (
    // The right padding is the **gutter**: the strip *Hover grouping*'s rule travels down, kept
    // clear of text so the rule never crosses a word on its way to the row.
    <ol className="pr-4.5 pb-6">
      {lines.map((line) => (
        <Line
          key={line.id}
          line={line}
          pinned={line.owner === pinned}
          lit={line.owner === hovered}
          onHover={onHover}
          onPick={onPick}
        />
      ))}
    </ol>
  )
}

/** A line's level, as the colour of whatever carries it. */
const LEVEL_TEXT = "group-data-[level=warn]:text-warn group-data-[level=error]:text-error group-data-[level=fatal]:text-error"

/** The `rails` mark and the app's tags: labels set into the line, beside its message. */
const LABEL = "flex-none rounded-chip border border-border bg-raised px-1 font-mono text-2xs text-muted"

type LineProps = {
  line: ConsoleLine
  pinned: boolean
  lit: boolean
  onHover: (line: ConsoleLine | null) => void
  onPick: (line: ConsoleLine) => void
}

/**
 * The whole group lights, not just the line under the pointer: the lines one request printed
 * are the thing being grouped, and seeing the other four is most of the answer.
 *
 * Two marks and not one, because a pin that a passing hover could put out would not be a pin.
 * Sweeping the rail after clicking is precisely what happens next, and every line the pointer
 * crosses on the way is another chance to lose what you just fixed in place — so the pinned
 * group keeps its mark while the hovered one gets a lighter one of its own.
 *
 * The level colours the severity and the message, over a Rails line's muted message: a Rails
 * warning is still a warning.
 *
 * Lighting is additive and stops there — **dimming** the non-matching lines, **colour
 * coding** by request and **scrollbar markers** were all built and rejected, and none of them
 * is coming back through here.
 */
function Line({ line, pinned, lit, onHover, onPick }: LineProps) {
  const { severity, message, source, tags } = line.event.payload

  return (
    <li
      className={[
        "group flex cursor-default items-baseline gap-1.5 border-b border-border py-0.5 pl-3 text-sm whitespace-nowrap data-[source=rails]:text-muted",
        // The pinned group wins over both the hover and the lit group passing across it.
        "hover:bg-raised data-[grouping~=lit]:not-data-[grouping~=pinned]:bg-lit data-[grouping~=pinned]:bg-pinned data-[grouping~=pinned]:shadow-pinned",
      ].join(" ")}
      data-line={line.id}
      data-level={severity}
      data-source={source}
      data-grouping={groupingMarks(pinned, lit)}
      // `mouseenter`/`mouseleave` and not `over`/`out`: moving between the spans inside one
      // line would otherwise read as leaving it.
      onMouseEnter={() => onHover(line)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onPick(line)}
    >
      {/* 5ch holds every level but `unknown`, so the lines' messages start in one column. */}
      <span className={`w-[5ch] flex-none font-mono text-2xs tracking-wider text-faint uppercase ${LEVEL_TEXT}`}>
        {severity}
      </span>
      {source === "rails" && (
        <span className={LABEL} title="Rails wrote this line, not the app">
          rails
        </span>
      )}
      {/* The app's own `log_tags`, in the order it tagged with them — so a tag's position is
          its identity, and a request tagged twice with one word is two chips. */}
      {tags.map((tag, at) => (
        <span key={at} className={LABEL}>
          <Highlight text={tag} />
        </span>
      ))}
      <span className={`min-w-0 truncate ${LEVEL_TEXT}`} title={message}>
        <Highlight text={message} />
      </span>
    </li>
  )
}
