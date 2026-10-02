import type { ReactNode } from "react"

import type { EvaluationRow } from "../../../../shared/activity"
import { LOAD_ON_OPEN_EVENTS } from "../../../../shared/bounds"
import type { EntryRow, Outcome } from "../../../../shared/repl"
import { useCopy } from "../../../components/CopyButton"
import { LinkButton } from "../../../components/LinkButton"
import { cn } from "../../../lib/cn"
import { elapsed, ms } from "../../../lib/format"
import { useClimbingElapsed } from "../../activity-table/lib/elapsed"
import type { DetailTabId } from "../../detail-column/components/DetailTabs"
import { rubySource } from "../lib/ruby-source"
import type { RawView } from "./EvaluationResult"

/**
 * A *Transcript* evaluation's status strip, along the bottom of its block: what it came to, in
 * words; its *Evaluation row*'s counts and time, as a link that opens the row on its Timeline
 * tab, or that the *Memory bound* took the row; and, after a divider, a result's Pretty | Raw
 * and Copy. An entry with no row has neither the link nor the note, and a value with no
 * structure to draw has Copy alone.
 *
 * Its Pretty | Raw is `rawView`, which the entry's result is drawn by.
 */
export function StatusStrip({
  outcome,
  row,
  onShowRow,
  rawView,
  className,
}: {
  outcome: Outcome | null
  row: EntryRow | null
  onShowRow: (row: EvaluationRow, tab: DetailTabId) => void
  rawView: RawView
  className?: string
}) {
  return (
    // A faint hairline over it and no fill, so it reads as its block's own bottom.
    <div
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 py-1 font-ui text-2xs text-muted", className)}
      role="group"
      aria-label="Status"
    >
      <OutcomeWords outcome={outcome} />
      {row?.kind === "held" && (
        <LinkButton className="text-2xs tabular-nums" onClick={() => onShowRow(row.row, "timeline")}>
          <RowSummary row={row.row} />
          <span aria-hidden="true">{" →"}</span>
        </LinkButton>
      )}
      {row?.kind === "evicted" && (
        <span
          className="text-faint"
          title={`The Reader keeps only its latest ${LOAD_ON_OPEN_EVENTS.toLocaleString("en")} events, and let go of the queries and log lines this ran as some of the oldest`}
        >
          queries cleared to save memory
        </span>
      )}
      {outcome?.kind === "result" && (
        <>
          <span className="h-3 border-l border-border" aria-hidden="true" />
          <ResultControls result={outcome} rawView={rawView} />
        </>
      )}
    </div>
  )
}

/** What an evaluation came to: its result's class, `raised`, that it lost its console process, or that it still runs. */
function OutcomeWords({ outcome }: { outcome: Outcome | null }) {
  switch (outcome?.kind) {
    case undefined:
      return <span className="text-faint">running…</span>
    case "result":
      return <span className="font-mono text-foreground">{outcome.className}</span>
    case "error":
      return <span className="text-error">raised</span>
    case "lost":
      return <span className="text-error">lost its console</span>
  }
}

/**
 * A row's non-zero counts, or `no queries` when both are zero, then its time: its duration once
 * it finished, in milliseconds under a second and seconds above, and otherwise in seconds,
 * climbing while it is *In-flight* and frozen at its last reading once *Interrupted*. No time
 * while there is nothing to measure it from.
 */
function RowSummary({ row }: { row: EvaluationRow }) {
  const climbing = row.state === "in-flight"
  const climbed = useClimbingElapsed(row.provenElapsed, climbing)
  const parts: string[] = []
  if (row.sqlCount > 0) parts.push(`${row.sqlCount} ${row.sqlCount === 1 ? "query" : "queries"}`)
  if (row.logCount > 0) parts.push(`${row.logCount} ${row.logCount === 1 ? "log" : "logs"}`)
  if (parts.length === 0) parts.push("no queries")
  if (row.durationMs !== null) parts.push(row.durationMs < 1000 ? ms(row.durationMs) : elapsed(row.durationMs))
  else if (climbed !== null) parts.push(elapsed(climbed))

  return parts.join(" · ")
}

/**
 * A result's Pretty | Raw, when it has structure to draw, and Copy, which copies what shows: the
 * value's `inspect` while Pretty, its `pretty_inspect` text while Raw or with nothing to draw.
 */
function ResultControls({ result, rawView: [raw, onRaw] }: { result: Extract<Outcome, { kind: "result" }>; rawView: RawView }) {
  const source = rubySource(result.tree)
  const [copied, copy] = useCopy()

  return (
    <>
      {source !== null && (
        <div className="inline-flex rounded-full bg-background p-px" role="group" aria-label="Show the result as">
          <PillHalf pressed={!raw} onClick={() => onRaw(false)}>
            Pretty
          </PillHalf>
          <PillHalf pressed={raw} onClick={() => onRaw(true)}>
            Raw
          </PillHalf>
        </div>
      )}
      <button
        type="button"
        className="flex flex-none cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-faint hover:bg-selected hover:text-foreground"
        aria-label="Copy result"
        onClick={() => copy(source === null || raw ? result.text : source.copyText(source.tree))}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </button>
    </>
  )
}

/** One half of the Pretty | Raw pill: filled while pressed, faint while not. */
function PillHalf({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="cursor-pointer rounded-full px-2 leading-4 text-faint hover:text-foreground aria-pressed:bg-selected aria-pressed:text-foreground"
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function CopyIcon() {
  return (
    <Icon>
      <rect width="13" height="13" x="9" y="9" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  )
}

function CheckIcon() {
  return (
    <Icon>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  )
}

/** A stroked icon the size of the strip's text. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="size-3 flex-none fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  )
}
