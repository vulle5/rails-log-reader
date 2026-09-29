import { useMemo, useState } from "react"

import type { Outcome } from "../../../../shared/repl"
import { ToggleButton, ToggleGroup } from "../../../components/ToggleButton"
import { ValueViewer } from "../../value-viewer/components/ValueViewer"
import type { ValueSource } from "../../value-viewer/lib/value-tree"
import { rubySource } from "../lib/ruby-source"
import { Cut, ErrorNote, Marker, Text } from "./TranscriptText"

/**
 * An *Evaluation*'s result: its value drawn in the *Value viewer* as Pretty, with Raw beside it
 * to show its `pretty_inspect` text instead, as the Response tab offers a body. A value with no
 * structure to draw is its text alone, with no toggle. The toggle is this instance's own, and
 * every instance opens pretty. An `inspect` that raised while the result was built is noted
 * under it.
 */
export function EvaluationResult({ outcome }: { outcome: Extract<Outcome, { kind: "result" }> }) {
  const source = useMemo(() => rubySource(outcome.tree), [outcome.tree])
  const [raw, setRaw] = useState(false)
  const showsRaw = source === null || raw

  return (
    <>
      {source === null ? (
        <Text>
          <Marker>{"=> "}</Marker>
          {outcome.text}
        </Text>
      ) : (
        <ResultView source={source} text={outcome.text} raw={raw} onRaw={setRaw} />
      )}
      {showsRaw && outcome.cut && <Cut>Result cut at 64 KB</Cut>}
      {outcome.inspectError !== null && <ErrorNote>{`inspect raised ${outcome.inspectError}`}</ErrorNote>}
    </>
  )
}

function ResultView({
  source,
  text,
  raw,
  onRaw,
}: {
  source: ValueSource
  text: string
  raw: boolean
  onRaw: (raw: boolean) => void
}) {
  const caption = (
    <div className="flex items-baseline gap-3 pb-1">
      <Marker>{"=>"}</Marker>
      <ToggleGroup label="Show the result as">
        <ToggleButton pressed={!raw} onClick={() => onRaw(false)}>
          Pretty
        </ToggleButton>
        <ToggleButton pressed={raw} onClick={() => onRaw(true)}>
          Raw
        </ToggleButton>
      </ToggleGroup>
    </div>
  )

  if (!raw) return <ValueViewer label="Result" source={source} caption={caption} />
  return (
    <>
      {caption}
      <Text>{text}</Text>
    </>
  )
}
