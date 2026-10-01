import { useContext, useState } from "react"

import type { Outcome, RubyError } from "../../../../shared/repl"
import { Backtrace } from "../../../components/Backtrace"
import { FoldedOverMatches } from "../../../components/Matches"
import { Highlight, SearchContext, type Search } from "../../../hooks/search"
import { framesMatches } from "../lib/entry-matches"
import { described } from "../lib/ruby-error"
import { CutText, useEntryCut, type EntryCut } from "./EntryCut"
import { EvaluationResult, type RawView } from "./EvaluationResult"
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
 * An evaluation's result, cut by `entryCut` when given, and shown raw or pretty by `rawView` when
 * given, or its error drawn as the *Detail column* draws an exception's backtrace.
 */
export function Answer({
  outcome,
  railsRoot,
  entryCut,
  rawView,
}: {
  outcome: Outcome
  railsRoot: string | null
  entryCut?: EntryCut
  rawView?: RawView
}) {
  switch (outcome.kind) {
    case "result":
      return <EvaluationResult outcome={outcome} entryCut={entryCut} rawView={rawView} />
    case "error":
      return (
        <>
          <Text className="text-error">
            <Highlight text={described(outcome)} />
          </Text>
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

/**
 * An error's cause: "Caused by" its class and message, folded, and its backtrace once opened. A
 * cause with no backtrace has nothing to open, so it is only that line.
 *
 * *Search* lights its class and message, and opens it for a match in its backtrace until the
 * developer folds it, which holds until the term changes, its line lit and counting the matches.
 */
function Cause({ cause, railsRoot }: { cause: RubyError; railsRoot: string | null }) {
  const search = useContext(SearchContext)
  const [opened, setOpened] = useState(false)
  // The search the developer folded it under, over a match.
  const [foldedUnder, setFoldedUnder] = useState<Search | null>(null)
  const found = framesMatches(search, cause)
  const open = opened || (found > 0 && foldedUnder !== search)
  const label = (
    <>
      {"Caused by "}
      <Highlight text={described(cause)} />
    </>
  )

  if (cause.backtrace.length === 0) {
    return <p className="mt-1 pl-[2ch] text-xs text-muted">{label}</p>
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        className="cursor-pointer text-left text-xs text-muted hover:text-foreground"
        aria-expanded={open}
        onClick={() => {
          setOpened(!open)
          setFoldedUnder(open && found > 0 ? search : null)
        }}
      >
        <Marker>{open ? "▾ " : "▸ "}</Marker>
        {!open && found > 0 ? <FoldedOverMatches count={found}>{label}</FoldedOverMatches> : label}
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
