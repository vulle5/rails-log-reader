import { useEffect, useLayoutEffect, useRef, useState } from "react"

import type { EvaluationRow } from "../../../../shared/activity"
import type { EntryRow, EvaluationEntry, TranscriptEntry } from "../../../../shared/repl"
import { OpenModifierHeld, useOpenModifierHeld } from "../../../hooks/open-modifier"
import { useMatches } from "../../../hooks/search"
import { cn } from "../../../lib/cn"
import type { DetailTabId } from "../../detail-column/components/DetailTabs"
import { type EntryCut } from "./EntryCut"
import { Answer, Printed } from "./EvaluationAnswer"
import { RubyCode } from "./RubyCode"
import { StatusStrip } from "./StatusStrip"
import { Marker, Text } from "./TranscriptText"

/** How near its end the Transcript can be scrolled and still follow what arrives. */
const FOLLOWING_SLACK = 24

/** An entry the Transcript is asked to scroll to. A new object for each ask. */
export type Reveal = { entry: number }

/**
 * The *REPL*'s *Transcript*: each evaluation's input highlighted as Ruby, then what it printed,
 * then its result or its error, with what the console process printed outside any evaluation as
 * entries of their own. Scrolled to its end as entries arrive and grow, unless it was scrolled up
 * away from it, and likewise when its own height changes, as it does while the prompt grows or
 * shrinks. An error's backtrace is drawn as the *Detail column* draws an exception's.
 *
 * An evaluation is a raised block with a status strip along its bottom, which says what it came
 * to, links to its *Evaluation row*, by `entryRows`, and holds its result's controls. Its left
 * edge is the accent, and the error colour once it raised or lost its console process. What an
 * entry printed and its result are each cut at `ENTRY_LINES` lines as first drawn: the cut opens
 * the row on its Result tab, or, with no row held, shows the rest in place.
 *
 * Asked to `reveal` an entry, it scrolls to it, once it is drawn, and then tells `onRevealed`.
 */
export function Transcript({
  entries,
  railsRoot,
  entryRows = NO_ROWS,
  onShowRow = () => {},
  reveal = null,
  onRevealed = () => {},
}: {
  entries: readonly TranscriptEntry[]
  railsRoot: string | null
  /** Each evaluation's *Evaluation row*, by its entry's id: `entryRows`. */
  entryRows?: ReadonlyMap<number, EntryRow>
  /** Selects `row`, on its Detail tab `tab`. */
  onShowRow?: (row: EvaluationRow, tab: DetailTabId) => void
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

  // The prompt growing or shrinking under it changes its height without a scroll or an entry.
  useEffect(() => {
    const element = list.current
    if (element === null || typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

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
          // An evaluation is a raised block, so where one ends and the next begins reads at a glance.
          <li
            key={entry.id}
            className={cn(entry.kind === "evaluation" && "bg-raised px-3 pt-1.5 shadow-pinned data-[outcome=error]:shadow-failed")}
            data-entry={entry.id}
            data-outcome={entry.kind === "evaluation" ? cameTo(entry) : undefined}
          >
            {entry.kind === "evaluation" ? (
              <Evaluation entry={entry} row={entryRows.get(entry.id) ?? null} railsRoot={railsRoot} onShowRow={onShowRow} />
            ) : (
              <Printed output={entry.output} cut={entry.outputCut} entryCut={IN_PLACE} />
            )}
          </li>
        ))}
      </ol>
    </OpenModifierHeld>
  )
}

const NO_ROWS: ReadonlyMap<number, EntryRow> = new Map()

const IN_PLACE: EntryCut = { openResult: null }

/**
 * What an evaluation came to, as its edge draws it: `result` once it returned one, `error` once
 * it raised or lost its console process, and nothing while it runs.
 */
function cameTo({ outcome }: EvaluationEntry) {
  if (outcome === null) return undefined
  return outcome.kind === "result" ? "result" : "error"
}

/**
 * An evaluation's entry: its input, then what it printed, then its answer, and its status strip
 * under them all. Its Pretty | Raw is its own, and opens pretty.
 */
function Evaluation({
  entry,
  row,
  railsRoot,
  onShowRow,
}: {
  entry: EvaluationEntry
  row: EntryRow | null
  railsRoot: string | null
  onShowRow: (row: EvaluationRow, tab: DetailTabId) => void
}) {
  const entryCut: EntryCut = row?.kind === "held" ? { openResult: () => onShowRow(row.row, "result") } : IN_PLACE
  const inputMatches = useMatches(entry.input)
  const rawView = useState(false)

  return (
    <>
      <Text className="text-strong">
        <Marker>{"› "}</Marker>
        <RubyCode source={entry.input} matches={inputMatches} />
      </Text>
      <Printed output={entry.output} cut={entry.outputCut} entryCut={entryCut} />
      {entry.outcome !== null && <Answer outcome={entry.outcome} railsRoot={railsRoot} entryCut={entryCut} rawView={rawView} bare />}
      {/* Out to the block's sides, short of its coloured edge, so the hairline over it spans the block. */}
      <StatusStrip
        className="mt-1.5 -mr-3 -ml-2.5 pr-3 pl-2.5"
        outcome={entry.outcome}
        row={row}
        onShowRow={onShowRow}
        rawView={rawView}
      />
    </>
  )
}
