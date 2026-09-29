import { useMemo, useState } from "react"

import type { Outcome } from "../../../../shared/repl"
import { ToggleButton, ToggleGroup } from "../../../components/ToggleButton"
import { ValueViewer } from "../../value-viewer/components/ValueViewer"
import type { ValueSource } from "../../value-viewer/lib/value-tree"
import { rubySource } from "../lib/ruby-source"
import { Cut, ErrorNote, Marker, Text } from "./TranscriptText"

/**
 * An *Evaluation*'s result: its value drawn in the *Value viewer*, with Tree | Text beside it to
 * show its `pretty_inspect` text instead. A value with no structure to draw is its text alone,
 * with no toggle. The toggle is this instance's own, and every instance opens on the tree.
 * An `inspect` that raised while the result was built is noted under it.
 */
export function EvaluationResult({ outcome }: { outcome: Extract<Outcome, { kind: "result" }> }) {
  const source = useMemo(() => rubySource(outcome.tree), [outcome.tree])
  const [asText, setAsText] = useState(false)
  const showsText = source === null || asText

  return (
    <>
      {source === null ? (
        <Text>
          <Marker>{"=> "}</Marker>
          {outcome.text}
        </Text>
      ) : (
        <ResultView source={source} text={outcome.text} asText={asText} onAsText={setAsText} />
      )}
      {showsText && outcome.cut && <Cut>Result cut at 64 KB</Cut>}
      {outcome.inspectError !== null && <ErrorNote>{`inspect raised ${outcome.inspectError}`}</ErrorNote>}
    </>
  )
}

function ResultView({
  source,
  text,
  asText,
  onAsText,
}: {
  source: ValueSource
  text: string
  asText: boolean
  onAsText: (asText: boolean) => void
}) {
  const caption = (
    <div className="flex items-baseline gap-1">
      <Marker>{"=>"}</Marker>
      <ToggleGroup label="Show the result as">
        <ToggleButton pressed={!asText} onClick={() => onAsText(false)}>
          Tree
        </ToggleButton>
        <ToggleButton pressed={asText} onClick={() => onAsText(true)}>
          Text
        </ToggleButton>
      </ToggleGroup>
    </div>
  )

  if (!asText) return <ValueViewer label="Result" source={source} caption={caption} />
  return (
    <>
      {caption}
      <Text>{text}</Text>
    </>
  )
}
