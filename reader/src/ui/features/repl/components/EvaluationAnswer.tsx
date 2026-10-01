import { useState } from "react"

import type { Outcome, RubyError } from "../../../../shared/repl"
import { Backtrace } from "../../../components/Backtrace"
import { CutText, useEntryCut, type EntryCut } from "./EntryCut"
import { EvaluationResult } from "./EvaluationResult"
import { Cut, ErrorNote, Marker, Text } from "./TranscriptText"

/**
 * What an *Evaluation* printed and how it ended, as the *Transcript* draws it under its input and
 * the Result tab draws it with more room. Each instance's folds and Pretty | Raw are its own.
 */

/**
 * What an evaluation, or the console process outside one, printed, cut by `entryCut` when given.
 * Nothing when it printed nothing.
 */
export function Printed({ output, cut, entryCut }: { output: string; cut: boolean; entryCut?: EntryCut }) {
  const note = useEntryCut(entryCut)
  if (output === "") return null

  return (
    <>
      <CutText className="text-muted" text={output} note={note} />
      {cut && <Cut>Output cut at 64K characters</Cut>}
    </>
  )
}

/**
 * An evaluation's result, cut by `entryCut` when given, or its error drawn as the *Detail
 * column* draws an exception's backtrace.
 */
export function Answer({ outcome, railsRoot, entryCut }: { outcome: Outcome; railsRoot: string | null; entryCut?: EntryCut }) {
  switch (outcome.kind) {
    case "result":
      return <EvaluationResult outcome={outcome} entryCut={entryCut} />
    case "error":
      return (
        <>
          <Text className="text-error">{described(outcome)}</Text>
          <Backtrace className="mt-1" backtrace={outcome.backtrace} railsRoot={railsRoot} />
          {outcome.cut && <Cut>Backtrace cut at 64 KB</Cut>}
          {outcome.causes.map((cause, at) => (
            <Cause key={at} cause={cause} railsRoot={railsRoot} />
          ))}
          {outcome.causesCut && <Cut>Further causes left out</Cut>}
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

/**
 * An error's cause: "Caused by" its class and message, folded, and its backtrace once opened. A
 * cause with no backtrace has nothing to open, so it is only that line.
 */
function Cause({ cause, railsRoot }: { cause: RubyError; railsRoot: string | null }) {
  const [open, setOpen] = useState(false)
  const label = `Caused by ${described(cause)}`

  if (cause.backtrace.length === 0) {
    return <p className="mt-1 pl-[2ch] text-xs text-muted">{label}</p>
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        className="cursor-pointer text-left text-xs text-muted hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Marker>{open ? "▾ " : "▸ "}</Marker>
        {label}
      </button>
      {open && (
        <>
          <Backtrace className="mt-1" backtrace={cause.backtrace} railsRoot={railsRoot} />
          {cause.cut && <Cut>Backtrace cut at 64 KB</Cut>}
        </>
      )}
    </div>
  )
}
