import { useLayoutEffect, useRef } from "react"

import type { Outcome, TranscriptEntry } from "../../../../shared/repl"
import { cn } from "../../../lib/cn"
import { EvaluationResult } from "./EvaluationResult"
import { RubyCode } from "./RubyCode"
import { Cut, ErrorNote, Marker, Text } from "./TranscriptText"

/** How near its end the Transcript can be scrolled and still follow what arrives. */
const FOLLOWING_SLACK = 24

/**
 * The *REPL*'s *Transcript*: each evaluation's input highlighted as Ruby, then what it printed,
 * then its result or its error, with what the console process printed outside any evaluation as
 * entries of their own. Scrolled to its end as entries arrive and grow, unless it was scrolled up
 * away from it.
 */
export function Transcript({ entries }: { entries: readonly TranscriptEntry[] }) {
  const list = useRef<HTMLOListElement>(null)
  const following = useRef(true)

  useLayoutEffect(() => {
    const element = list.current
    if (element !== null && following.current) element.scrollTop = element.scrollHeight
  }, [entries])

  function scrolled() {
    const element = list.current
    if (element !== null) following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOWING_SLACK
  }

  return (
    <ol
      className="flex min-h-0 flex-auto flex-col gap-2 overflow-auto px-3 py-2 font-mono text-sm"
      aria-label="Transcript"
      ref={list}
      onScroll={scrolled}
    >
      {entries.map((entry) => (
        // An evaluation is a raised block edged in the accent, so where one ends and the next
        // begins reads at a glance, and so does which one a control at its far edge belongs to.
        <li key={entry.id} className={cn(entry.kind === "evaluation" && "bg-raised px-3 py-1.5 shadow-pinned")}>
          {entry.kind === "evaluation" ? (
            <>
              <Text className="text-strong">
                <Marker>{"› "}</Marker>
                <RubyCode source={entry.input} />
              </Text>
              <Printed output={entry.output} cut={entry.outputCut} />
              {entry.outcome !== null && <Answer outcome={entry.outcome} />}
            </>
          ) : (
            <Printed output={entry.output} cut={entry.outputCut} />
          )}
        </li>
      ))}
    </ol>
  )
}

function Printed({ output, cut }: { output: string; cut: boolean }) {
  if (output === "") return null

  return (
    <>
      <Text className="text-muted">{output}</Text>
      {cut && <Cut>Output cut at 64K characters</Cut>}
    </>
  )
}

function Answer({ outcome }: { outcome: Outcome }) {
  switch (outcome.kind) {
    case "result":
      return <EvaluationResult outcome={outcome} />
    case "error":
      return (
        <Text className="text-error">{outcome.message === "" ? outcome.className : `${outcome.className}: ${outcome.message}`}</Text>
      )
    case "lost":
      return <ErrorNote>The REPL exited before it answered.</ErrorNote>
  }
}
