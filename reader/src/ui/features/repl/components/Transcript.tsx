import { useLayoutEffect, useRef } from "react"

import type { TranscriptEntry } from "../../../../shared/repl"
import { OpenModifierHeld, useOpenModifierHeld } from "../../../hooks/open-modifier"
import { cn } from "../../../lib/cn"
import { Answer, Printed } from "./EvaluationAnswer"
import { RubyCode } from "./RubyCode"
import { Marker, Text } from "./TranscriptText"

/** How near its end the Transcript can be scrolled and still follow what arrives. */
const FOLLOWING_SLACK = 24

/** An entry the Transcript is asked to scroll to. A new object for each ask. */
export type Reveal = { entry: number }

/**
 * The *REPL*'s *Transcript*: each evaluation's input highlighted as Ruby, then what it printed,
 * then its result or its error, with what the console process printed outside any evaluation as
 * entries of their own. Scrolled to its end as entries arrive and grow, unless it was scrolled up
 * away from it. An error's backtrace is drawn as the *Detail column* draws an exception's.
 *
 * Asked to `reveal` an entry, it scrolls to it, once it is drawn, and then tells `onRevealed`.
 */
export function Transcript({
  entries,
  railsRoot,
  reveal = null,
  onRevealed = () => {},
}: {
  entries: readonly TranscriptEntry[]
  railsRoot: string | null
  reveal?: Reveal | null
  onRevealed?: () => void
}) {
  const list = useRef<HTMLOListElement>(null)
  const following = useRef(true)
  const held = useOpenModifierHeld()

  useLayoutEffect(() => {
    const element = list.current
    if (element !== null && following.current) element.scrollTop = element.scrollHeight
  }, [entries])

  // After following, so a Transcript drawn by the same click that asks lands on the entry.
  useLayoutEffect(() => {
    if (reveal === null) return

    list.current?.querySelector(`[data-entry="${reveal.entry}"]`)?.scrollIntoView({ block: "start" })
    onRevealed()
  }, [reveal, onRevealed])

  function scrolled() {
    const element = list.current
    if (element !== null) following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOWING_SLACK
  }

  return (
    <OpenModifierHeld value={held}>
      <ol
        className="flex min-h-0 flex-auto flex-col gap-2 overflow-auto px-3 py-2 font-mono text-sm"
        aria-label="Transcript"
        ref={list}
        onScroll={scrolled}
      >
        {entries.map((entry) => (
          // An evaluation is a raised block edged in the accent, so where one ends and the next
          // begins reads at a glance, and so does which one a control at its far edge belongs to.
          <li
            key={entry.id}
            className={cn(entry.kind === "evaluation" && "bg-raised px-3 py-1.5 shadow-pinned")}
            data-entry={entry.id}
          >
            {entry.kind === "evaluation" ? (
              <>
                <Text className="text-strong">
                  <Marker>{"› "}</Marker>
                  <RubyCode source={entry.input} />
                </Text>
                <Printed output={entry.output} cut={entry.outputCut} />
                {entry.outcome !== null && <Answer outcome={entry.outcome} railsRoot={railsRoot} />}
              </>
            ) : (
              <Printed output={entry.output} cut={entry.outputCut} />
            )}
          </li>
        ))}
      </ol>
    </OpenModifierHeld>
  )
}
