import { useState } from "react"

import type { Outcome } from "../../../../shared/repl"
import { Copyable } from "../../../components/CopyButton"
import { ToggleButton, ToggleGroup } from "../../../components/ToggleButton"
import { ValueViewer } from "../../value-viewer/components/ValueViewer"
import type { ValueSource } from "../../value-viewer/lib/value-tree"
import { ENTRY_LINES } from "../lib/entry-cut"
import { CutText, useEntryCut, type CutNote, type EntryCut } from "./EntryCut"
import { rubySource } from "../lib/ruby-source"
import { Cut, ErrorNote, Marker } from "./TranscriptText"

/**
 * An *Evaluation*'s result: its value drawn in the *Value viewer* as Pretty, with Raw beside it
 * to show its `pretty_inspect` text instead, as the Response tab offers a body. A value with no
 * structure to draw is its text alone, with no toggle. The toggle is this instance's own, and
 * every instance opens pretty. An `inspect` that raised while the result was built is noted
 * under it.
 *
 * An `entryCut` cuts the value, its tree, its text or its Raw text, at `ENTRY_LINES` lines as
 * first drawn, and the one note under the cut opens the rest wherever the value shows.
 *
 * A `rawView` holds the toggle in its owner's place instead, for an owner that counts what it lights.
 */
export function EvaluationResult({
  outcome,
  entryCut,
  rawView,
}: {
  outcome: Extract<Outcome, { kind: "result" }>
  entryCut?: EntryCut
  rawView?: RawView
}) {
  const source = rubySource(outcome.tree)
  const [ownRaw, setOwnRaw] = useState(false)
  const [raw, setRaw] = rawView ?? [ownRaw, setOwnRaw]
  const showsRaw = source === null || raw
  const note = useEntryCut(entryCut)

  return (
    <>
      {source === null ? (
        <CutText text={outcome.text} note={note}>
          <Marker>{"=> "}</Marker>
        </CutText>
      ) : (
        <ResultView source={source} text={outcome.text} raw={raw} onRaw={setRaw} note={note} />
      )}
      {showsRaw && outcome.cut && <Cut>Result cut at 64 KB</Cut>}
      {outcome.inspectError !== null && <ErrorNote>{`inspect raised ${outcome.inspectError}`}</ErrorNote>}
    </>
  )
}

/** Whether a result shows Raw, and what chooses. */
export type RawView = readonly [raw: boolean, onRaw: (raw: boolean) => void]

/**
 * `=>`, then the result beside it, with Pretty | Raw and the copy control at the right of its
 * first line, so a result's controls sit together whichever way it shows.
 */
function ResultView({
  source,
  text,
  raw,
  onRaw,
  note,
}: {
  source: ValueSource
  text: string
  raw: boolean
  onRaw: (raw: boolean) => void
  note: CutNote | null
}) {
  const toggles = (
    <ToggleGroup label="Show the result as">
      <ToggleButton pressed={!raw} onClick={() => onRaw(false)}>
        Pretty
      </ToggleButton>
      <ToggleButton pressed={raw} onClick={() => onRaw(true)}>
        Raw
      </ToggleButton>
    </ToggleGroup>
  )

  return (
    // The gap is a space wide, as `=> ` is before a result's text.
    <div className="flex gap-[1ch] leading-sql">
      <Marker>{"=>"}</Marker>
      <div className="min-w-0 flex-1">
        {raw ? (
          <Copyable text={text} label="Copy result" controls={toggles}>
            <CutText text={text} note={note} />
          </Copyable>
        ) : (
          <ValueViewer label="Result" source={source} controls={toggles} cut={note === null ? undefined : { lines: ENTRY_LINES, note }} />
        )}
      </div>
    </div>
  )
}
