import { TRANSCRIPT_LIMIT, type HeldEntry } from "../../../../shared/repl"
import { Answer, Printed } from "./EvaluationAnswer"

/**
 * An *Evaluation row*'s Result tab: its *Transcript* entry with more room, what it printed and
 * then its result or its error, drawn as the Transcript draws them. A second view of the entry
 * and not a copy, so it waits while the evaluation runs and shows the answer once it comes.
 *
 * `held` is where the entry is, or `null` while this page holds no session to look in. An entry
 * that is gone says why in plain words, so the tab is never an unexplained blank.
 */
export function ResultPanel({
  held,
  actsOnlyFrom,
  railsRoot,
}: {
  held: HeldEntry | null
  /** Where acts can be made from, when this page is not there, else `null`. */
  actsOnlyFrom: string | null
  railsRoot: string | null
}) {
  if (held === null) {
    return <Note>{actsOnlyFrom === null ? "Connecting to the REPL…" : `Results are shown on ${actsOnlyFrom}, where the REPL runs.`}</Note>
  }
  if (held.kind === "gone") return <Note>{goneBecause(held.reason)}</Note>

  const { entry } = held
  return (
    <div className="px-3 py-2 font-mono text-sm">
      <Printed output={entry.output} cut={entry.outputCut} />
      {entry.outcome === null ? (
        <p className="font-ui text-faint">Waiting for the evaluation to finish…</p>
      ) : (
        <Answer outcome={entry.outcome} railsRoot={railsRoot} />
      )}
    </div>
  )
}

/**
 * What the Result tab's label says before it is opened: `raised` for an evaluation that raised,
 * which the Sidecar says after its entry is gone, and otherwise its result's class while the
 * entry is held. `null` while it runs, or once its entry is gone.
 */
export function resultLabel(outcome: "ok" | "raised" | null, held: HeldEntry | null) {
  const answer = held?.kind === "held" ? held.entry.outcome : null
  if (outcome === "raised" || answer?.kind === "error") return "raised"
  return answer?.kind === "result" ? answer.className : null
}

function goneBecause(reason: Extract<HeldEntry, { kind: "gone" }>["reason"]) {
  switch (reason) {
    case "restarted":
      return "The REPL was restarted after this ran, which cleared its result."
    case "dropped":
      return `The REPL keeps only its latest ${TRANSCRIPT_LIMIT} entries, and this one was dropped as one of the oldest.`
    case "elsewhere":
      return "This ran in a console this Reader didn't start, so its result isn't here."
  }
}

function Note({ children }: { children: string }) {
  return <p className="px-3 py-2 text-faint">{children}</p>
}
