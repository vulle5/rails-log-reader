import { useContext, useMemo, useState } from "react"

import { OpenModifierHeld } from "../hooks/open-modifier"
import { EditorContext } from "../hooks/editor-scheme"
import { Marked, SearchContext, useMatches, type Match, type Search } from "../hooks/search"
import { segmentBacktrace, type BacktraceSegment } from "../lib/backtrace"
import { cn } from "../lib/cn"
import { withOpenModifier } from "../lib/platform"
import { fillScheme, sourceLocation } from "../lib/source-location"

/** Which gem-frame markers are open, by the `from` of their gap, and how to open one. */
export type OpenedMarkers = readonly [ReadonlySet<number>, (from: number) => void]

/**
 * A backtrace, gem frames collapsed into inline markers and the developer's own in place, as the
 * *Detail column* draws an exception's and the *REPL*'s *Transcript* an error's. Nothing when it
 * has no frames.
 *
 * Which markers have been opened, by the `from` of their gap, is this component's own unless
 * its caller holds it in `opened`: the Detail column does, so the *Timeline ruler* can size the
 * exception block by it. Either way it only ever grows: nothing closes a marker once opened.
 */
export function Backtrace({
  backtrace,
  railsRoot,
  className,
  opened,
}: {
  backtrace: readonly string[]
  railsRoot: string | null
  className?: string
  opened?: OpenedMarkers
}) {
  const search = useContext(SearchContext)
  const [own, setOwn] = useState<ReadonlySet<number>>(() => new Set())
  const [revealed, reveal] = opened ?? [own, (from: number) => setOwn((prev) => new Set(prev).add(from))]
  const segments = useMemo(() => segmentBacktrace(backtrace, railsRoot), [backtrace, railsRoot])
  const held = useContext(OpenModifierHeld)
  if (segments.length === 0) return null

  return (
    // Full and uncleaned, so it is long: it scrolls with its container rather than being capped.
    <ol
      className={cn("font-mono text-xs leading-normal whitespace-pre-wrap text-muted wrap-anywhere", className)}
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
            revealed={gapShown(segment, revealed, search)}
            onReveal={() => reveal(segment.from)}
          />
        ),
      )}
    </ol>
  )
}

/**
 * Whether a gem-frame marker shows its frames: once opened, and while the *Search* term matches
 * one of them, so a match is never folded away.
 */
export function gapShown(segment: Extract<BacktraceSegment, { type: "gap" }>, opened: ReadonlySet<number>, search: Search) {
  return opened.has(segment.from) || segment.frames.some((frame) => search.find(frame).length > 0)
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
 * One raw frame, a backtrace's or a Callsite's, starting at `from` in the text `matches` were
 * found in. Where it holds a *Source location*, its `path:line` — and never the method after
 * it — opens in the editor on an open-modifier click, and a plain click stays a text
 * selection. Underlined only while it is hovered *and* `held`, so pressing the modifier alone
 * restyles nothing. A click with no *Editor scheme* set asks for one and opens nothing, not
 * even once one has been given.
 */
export function Openable({
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
