import { useCallback, useLayoutEffect, useRef } from "react"

import type { TranscriptEntry } from "../../../../shared/repl"
import { useAutoScroll, type ColumnAutoScroll } from "../../../hooks/auto-scroll"

/** An entry the Transcript is asked to scroll to. A new object for each ask. */
export type Reveal = { entry: number }

/**
 * The *Transcript*'s *Auto-scroll* over `entries`: it keeps its bottom as entries arrive and grow,
 * and as its own height changes while the prompt grows or shrinks, until it is scrolled up.
 * Paused, it counts what came to something on the "↓ N new" pill: an evaluation ending, however
 * it ended, and an entry of what the console process printed outside any evaluation.
 * `refollowsWhen` changing alone resumes it, and drops the count.
 *
 * Kept by whatever outlives the Transcript, so a Transcript unmounted and mounted again reopens
 * following, or paused where it was, having counted what came to something in between.
 *
 * Asked to `reveal` an entry, it scrolls the Transcript to it, once it is drawn, and then tells
 * `onRevealed`. That scroll is read like any other, so an entry above the bottom pauses it.
 */
export function useTranscriptScroll({
  entries,
  refollowsWhen,
  reveal = null,
  onRevealed = () => {},
}: {
  entries: readonly TranscriptEntry[]
  /** Changes whenever this tab submits, or the session restarts. */
  refollowsWhen: string
  reveal?: Reveal | null
  onRevealed?: () => void
}): ColumnAutoScroll {
  const scroll = useAutoScroll({ items: useConclusions(entries), listing: refollowsWhen, refollowsWhen, content: entries })
  const transcript = useRef<HTMLElement>(null)
  const attach = scroll.port
  const port = useCallback(
    (element: HTMLElement) => {
      transcript.current = element
      const detach = attach(element)
      return () => {
        transcript.current = null
        detach?.()
      }
    },
    [attach],
  )

  // After following's, so a Transcript drawn by the same click that asks lands on the entry.
  useLayoutEffect(() => {
    if (reveal === null) return

    transcript.current?.querySelector(`[data-entry="${reveal.entry}"]`)?.scrollIntoView({ block: "start" })
    onRevealed()
  }, [reveal, onRevealed])

  return { ...scroll, port }
}

/**
 * How many entries have come to something while the Transcript was drawn: an evaluation once it
 * ended, however it ended, and an entry of what the console process printed outside any
 * evaluation from its start. Never falls, so the oldest entry the Transcript limit drops for
 * each new one takes nothing off it, and neither a running evaluation's output nor its start
 * ever adds to it.
 *
 * Counted by entry against the last `entries` it was handed, and handed the same `entries`
 * again it answers what it answered, so a render React repeats counts nothing twice.
 */
function useConclusions(entries: readonly TranscriptEntry[]) {
  const counted = useRef<{ entries: readonly TranscriptEntry[]; total: number } | null>(null)
  const last = counted.current

  if (last === null) {
    counted.current = { entries, total: entries.filter(concluded).length }
  } else if (last.entries !== entries) {
    const before = new Map(last.entries.map((entry) => [entry.id, concluded(entry)]))
    const came = entries.filter((entry) => concluded(entry) && before.get(entry.id) !== true).length
    counted.current = { entries, total: last.total + came }
  }

  return counted.current!.total
}

function concluded(entry: TranscriptEntry) {
  return entry.kind === "output" || entry.outcome !== null
}
