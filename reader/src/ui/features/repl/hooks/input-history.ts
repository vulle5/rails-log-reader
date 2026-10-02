import { useEffect, useRef, useState } from "react"

import { runningPid, type ReplSnapshot } from "../../../../shared/repl"
import { historyKey, parseHistory, recallHistory, rememberHistory, withSubmitted, type HistoryEntry } from "../lib/input-history"

/** The *Input history*, and how an input joins it. */
export type InputHistory = {
  /** Oldest first, a repeat kept once at its latest. */
  entries: readonly HistoryEntry[]
  /** Adds `input`, just submitted to the console process the snapshot says is running it. */
  record: (input: string) => void
}

/** An input submitted from this tab whose evaluation has not finished. */
type Pending = { input: string; at: number; after: number }

/**
 * The *Input history* of the Host app at `railsRoot`: read from `localStorage` once, and again
 * only when another tab writes it, so typing never waits on it. It is written when an input is
 * recorded, and once more when that input's evaluation finishes, to mark that it raised.
 * Before the root is known it is held for the session alone.
 */
export function useInputHistory(railsRoot: string | null, snapshot: ReplSnapshot): InputHistory {
  const [held, setHeld] = useState(() => ({ railsRoot, entries: recallHistory(railsRoot) }))
  const entries = held.railsRoot === railsRoot ? held.entries : recallHistory(railsRoot)
  const latest = useRef({ railsRoot, entries, snapshot })
  latest.current = { railsRoot, entries, snapshot }
  const pending = useRef<Pending | null>(null)

  if (held.railsRoot !== railsRoot) setHeld({ railsRoot, entries })

  useEffect(() => {
    if (railsRoot === null) return

    const key = historyKey(railsRoot)
    // A `storage` event fires in the other tabs only, and a `clear()` names no key.
    const written = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setHeld({ railsRoot, entries: parseHistory(event.newValue) })
    }
    window.addEventListener("storage", written)
    return () => window.removeEventListener("storage", written)
  }, [railsRoot])

  function change(to: HistoryEntry[]) {
    rememberHistory(latest.current.railsRoot, to)
    latest.current.entries = to
    setHeld({ railsRoot: latest.current.railsRoot, entries: to })
  }

  function record(input: string) {
    const { state, transcript } = latest.current.snapshot
    const pid = runningPid(state)
    if (pid === null) return

    const at = Date.now()
    pending.current = { input, at, after: Math.max(0, ...transcript.map((entry) => entry.id)) }
    change(withSubmitted(latest.current.entries, { input, at, pid, raised: false }))
  }

  // The evaluation this tab sent is the first one after what it held that has its input. A
  // Restart empties the Transcript first, and then it is never found.
  useEffect(() => {
    const waiting = pending.current
    if (waiting === null) return

    for (const entry of snapshot.transcript) {
      if (entry.kind !== "evaluation" || entry.id <= waiting.after || entry.input !== waiting.input) continue
      if (entry.outcome === null) return

      pending.current = null
      if (entry.outcome.kind !== "error") return
      change(latest.current.entries.map((each) => (each.at === waiting.at && each.input === waiting.input ? { ...each, raised: true } : each)))
      return
    }
  }, [snapshot.transcript])

  return { entries, record }
}
