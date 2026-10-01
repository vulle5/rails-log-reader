import { useState, type ReactNode } from "react"

import { LinkButton } from "../../../components/LinkButton"
import { cutLines, ENTRY_LINES } from "../lib/entry-cut"
import { Cut, Text } from "./TranscriptText"

/**
 * How a *Transcript* entry cuts what it printed and its result, each at `ENTRY_LINES` lines as
 * first drawn. `openResult` opens its *Evaluation row*'s Result tab for the rest, and an entry
 * with no row held, `null`, shows the rest in place.
 */
export type EntryCut = { openResult: (() => void) | null }

/** The note under a cut, given how many lines it left out. */
export type CutNote = (more: number) => ReactNode

/**
 * The note under one of an entry's cuts, while it cuts. `null` with no `entryCut`, and once the
 * rest is shown in place, which holds for this instance.
 */
export function useEntryCut(entryCut: EntryCut | undefined): CutNote | null {
  const [whole, setWhole] = useState(false)
  if (entryCut === undefined || whole) return null

  const { openResult } = entryCut
  return (more) => (
    <Cut>
      {`…${more} more ${more === 1 ? "line" : "lines"} · `}
      <LinkButton onClick={openResult ?? (() => setWhole(true))}>{openResult === null ? "show all" : "open in Result"}</LinkButton>
    </Cut>
  )
}

/** `text` after `children`, cut at `ENTRY_LINES` lines with `note` under it, unless `note` is `null`. */
export function CutText({ text, note, className, children }: { text: string; note: CutNote | null; className?: string; children?: ReactNode }) {
  const kept = note === null ? null : cutLines(text, ENTRY_LINES)

  return (
    <>
      <Text className={className}>
        {children}
        {kept === null ? text : kept.shown}
      </Text>
      {kept !== null && note?.(kept.more)}
    </>
  )
}
