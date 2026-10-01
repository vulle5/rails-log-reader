import { useLayoutEffect, useRef } from "react"

import type { EvaluationRow } from "../../../../shared/activity"
import type { EntryRow, EvaluationEntry, TranscriptEntry } from "../../../../shared/repl"
import { OpenModifierHeld, useOpenModifierHeld } from "../../../hooks/open-modifier"
import { cn } from "../../../lib/cn"
import { LinkButton } from "../../../components/LinkButton"
import type { DetailTabId } from "../../detail-column/components/DetailTabs"
import { type EntryCut } from "./EntryCut"
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
 * An evaluation links to its *Evaluation row*, by `entryRows`, with the row's counts, and says so
 * once the *Memory bound* has taken it. What an entry printed and its result are each cut at
 * `ENTRY_LINES` lines as first drawn: the cut opens the row on its Result tab, or, with no row
 * held, shows the rest in place.
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

/** An evaluation's entry: its input and the link to its row, then what it printed, then its answer. */
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

  return (
    <>
      {/* Spaced from what follows, so a result's controls, which stand taller than its first line,
          clear the row link at the same edge. */}
      <div className="mb-1 flex items-baseline gap-3">
        <Text className="min-w-0 flex-auto text-strong">
          <Marker>{"› "}</Marker>
          <RubyCode source={entry.input} />
        </Text>
        {row?.kind === "held" && (
          <LinkButton className="flex-none" onClick={() => onShowRow(row.row, "timeline")}>
            {counts(row.row)}
          </LinkButton>
        )}
        {row?.kind === "evicted" && <span className="flex-none font-ui text-xs text-faint">timeline no longer held</span>}
      </div>
      <Printed output={entry.output} cut={entry.outputCut} entryCut={entryCut} />
      {entry.outcome !== null && <Answer outcome={entry.outcome} railsRoot={railsRoot} entryCut={entryCut} />}
    </>
  )
}

/** A row's SQL and log counts: `3 queries · 1 log`. */
function counts({ sqlCount, logCount }: EvaluationRow) {
  return `${sqlCount} ${sqlCount === 1 ? "query" : "queries"} · ${logCount} ${logCount === 1 ? "log" : "logs"}`
}
