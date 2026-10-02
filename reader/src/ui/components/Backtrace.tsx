import { useContext, useMemo, useState } from "react"

import { OpenModifierHeld } from "../hooks/open-modifier"
import { EditorContext } from "../hooks/editor-scheme"
import { Marked, SearchContext, useMatches, type Match } from "../hooks/search"
import { segmentBacktrace, type BacktraceSegment } from "../lib/backtrace"
import { cn } from "../lib/cn"
import { withOpenModifier } from "../lib/platform"
import { fillScheme, sourceLocation } from "../lib/source-location"

/**
 * A backtrace, gem frames collapsed into inline markers and the developer's own in place, as the
 * *Detail column* draws an exception's and the *REPL*'s *Transcript* an error's. Nothing when it
 * has no frames.
 *
 * Collapse state lives in this component's own `useState`, not on the exception or the
 * row: selecting elsewhere unmounts it, so the next selection starts from an empty
 * `revealed` set with no explicit reset.
 */
export function Backtrace({
  backtrace,
  railsRoot,
  className,
}: {
  backtrace: readonly string[]
  railsRoot: string | null
  className?: string
}) {
  const search = useContext(SearchContext)
  // Only ever grows: nothing removes an entry once revealed.
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set())
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
