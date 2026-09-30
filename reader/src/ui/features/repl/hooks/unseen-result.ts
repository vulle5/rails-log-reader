import { useState } from "react"

import type { Outcome, TranscriptEntry } from "../../../../shared/repl"

/** How the latest *Unseen result* ended: an `error` when it raised or the console process died. */
export type UnseenResult = "result" | "error"

/**
 * The *Unseen result*: how the latest evaluation to finish since `counting` last turned on ended,
 * or `null` when none has. `counting` is when the drawer is folded and the session's snapshot has
 * arrived, so a reload onto a folded drawer takes the *Transcript* it replays as seen. Turning it
 * off forgets what had been seen, so the next fold counts afresh.
 *
 * An evaluation is told from the ones seen by its id and input, so a snapshot that replaces the
 * *Transcript* held, such as the one a reconnect brings, replays what was seen as seen.
 */
export function useUnseenResult(transcript: readonly TranscriptEntry[], counting: boolean): UnseenResult | null {
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null)

  // Adjusted while rendering, so the render that folds the drawer is the one that starts the count.
  if (counting && seen === null) setSeen(new Set(finished(transcript).map(([key]) => key)))
  if (!counting && seen !== null) setSeen(null)

  if (!counting || seen === null) return null
  const latest = finished(transcript).findLast(([key]) => !seen.has(key))
  if (latest === undefined) return null
  return latest[1].kind === "result" ? "result" : "error"
}

function finished(transcript: readonly TranscriptEntry[]) {
  return transcript.flatMap((entry): [string, Outcome][] =>
    entry.kind === "evaluation" && entry.outcome !== null ? [[`${entry.id}:${entry.input}`, entry.outcome]] : [],
  )
}
