import { useMemo, useState } from "react"

import type { Outcome } from "../../../../shared/repl"
import { Copyable } from "../../../components/CopyButton"
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

/**
 * `=>`, then the result beside it, with Pretty | Raw and the copy control at the right of its
 * first line, so a result's controls sit together whichever way it shows.
 */
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
            <Text>{text}</Text>
          </Copyable>
        ) : (
          <ValueViewer label="Result" source={source} controls={toggles} />
        )}
      </div>
    </div>
  )
}
