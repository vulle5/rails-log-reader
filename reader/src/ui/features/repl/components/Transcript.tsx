import { useLayoutEffect, useRef, useState } from "react"

import type { Outcome, RubyError, TranscriptEntry } from "../../../../shared/repl"
import { Backtrace } from "../../../components/Backtrace"
import { OpenModifierHeld, useOpenModifierHeld } from "../../../hooks/open-modifier"
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
 * away from it. An error's backtrace is drawn as the *Detail column* draws an exception's.
 */
export function Transcript({ entries, railsRoot }: { entries: readonly TranscriptEntry[]; railsRoot: string | null }) {
  const list = useRef<HTMLOListElement>(null)
  const following = useRef(true)
  const held = useOpenModifierHeld()

  useLayoutEffect(() => {
    const element = list.current
    if (element !== null && following.current) element.scrollTop = element.scrollHeight
  }, [entries])

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
          <li key={entry.id} className={cn(entry.kind === "evaluation" && "bg-raised px-3 py-1.5 shadow-pinned")}>
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

function Printed({ output, cut }: { output: string; cut: boolean }) {
  if (output === "") return null

  return (
    <>
      <Text className="text-muted">{output}</Text>
      {cut && <Cut>Output cut at 64K characters</Cut>}
    </>
  )
}

function Answer({ outcome, railsRoot }: { outcome: Outcome; railsRoot: string | null }) {
  switch (outcome.kind) {
    case "result":
      return <EvaluationResult outcome={outcome} />
    case "error":
      return (
        <>
          <Text className="text-error">{described(outcome)}</Text>
          <Backtrace className="mt-1" backtrace={outcome.backtrace} railsRoot={railsRoot} />
          {outcome.causes.map((cause, at) => (
            <Cause key={at} cause={cause} railsRoot={railsRoot} />
          ))}
        </>
      )
    case "lost":
      return <ErrorNote>The REPL exited before it answered.</ErrorNote>
  }
}

/** An error as its class, then its message when it has one. */
function described({ className, message }: RubyError) {
  return message === "" ? className : `${className}: ${message}`
}

/** An error's cause, folded to "Caused by" its class and message, and its backtrace once opened. */
function Cause({ cause, railsRoot }: { cause: RubyError; railsRoot: string | null }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="mt-1">
      <button
        type="button"
        className="cursor-pointer text-left text-xs text-muted hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Marker>{open ? "▾ " : "▸ "}</Marker>
        {`Caused by ${described(cause)}`}
      </button>
      {open && <Backtrace className="mt-1" backtrace={cause.backtrace} railsRoot={railsRoot} />}
    </div>
  )
}
