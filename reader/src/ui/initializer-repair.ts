import { useEffect, useRef, useState } from "react"

import type { InitializerFileStatus } from "../shared/initializer-status"

/**
 * `GET /initializer-status`, fetched once on mount. `null` until it answers, which
 * `detectMismatch` reads the same way it reads *not installed* — nothing to compare yet, so
 * no banner flashes on a fresh page load ahead of the read that would justify one.
 *
 * `markRepaired` stands in for a second round trip: a `POST /initializer-repair` that
 * resolved is a write this same process just made, so there is nothing left to learn by
 * reading the file back — the caller reports the one fact a repair can ever produce rather
 * than reaching in to set the whole shape itself.
 */
export function useInitializerFileStatus() {
  const [status, setStatus] = useState<InitializerFileStatus | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch("/initializer-status")
      .then((response) => response.json() as Promise<InitializerFileStatus>)
      .then((body) => {
        if (!cancelled) setStatus(body)
      })
      .catch(() => {
        /* Left `null`: a failed read is nothing to compare yet, the same as one never made. */
      })

    return () => {
      cancelled = true
    }
  }, [])

  function markRepaired() {
    setStatus({ installed: true, current: true })
  }

  return { status, markRepaired }
}

export type RepairState =
  | { phase: "idle" }
  | { phase: "repairing" }
  | { phase: "failed"; error: string }
  /** The file is copied; the developer still has to restart Rails to load it. */
  | { phase: "awaiting-restart" }
  /** A new `run_id` arrived after the copy — #29's own definition of a confirmed repair. */
  | { phase: "restarted" }

/**
 * The one click #29 asks for: overwrite the Work app's copy, prompt for a restart, and
 * confirm success by the arrival of a new `run_id` — never by polling `/initializer-status`
 * again, which could only ever confirm the file, not the process that has to reload it.
 *
 * `liveRunId` is watched rather than read once, so a restart that lands after the click —
 * whenever the developer gets to it — is still caught: the effect below fires again on
 * every id the live Sidecar reports and only acts while a repair is still `awaiting-restart`.
 */
export function useInitializerRepair(liveRunId: string | null) {
  const [state, setState] = useState<RepairState>({ phase: "idle" })
  /** The `run_id` current at the moment the copy succeeded — restart confirms against this. */
  const runIdAtRepair = useRef<string | null>(null)

  useEffect(() => {
    setState((current) => {
      if (current.phase !== "awaiting-restart") return current
      if (liveRunId === null || liveRunId === runIdAtRepair.current) return current
      return { phase: "restarted" }
    })
  }, [liveRunId])

  /** Resolves to whether the copy actually happened, which is what the caller needs to know
   * — the state update above lands asynchronously and cannot be read back from this render's
   * closure the instant `await` returns. */
  async function repair(): Promise<boolean> {
    setState({ phase: "repairing" })

    try {
      const response = await fetch("/initializer-repair", { method: "POST" })
      const body = (await response.json()) as { ok: boolean; error?: string }
      if (!body.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`)

      runIdAtRepair.current = liveRunId
      setState({ phase: "awaiting-restart" })
      return true
    } catch (problem) {
      setState({ phase: "failed", error: problem instanceof Error ? problem.message : String(problem) })
      return false
    }
  }

  function dismiss() {
    setState({ phase: "idle" })
  }

  return { state, repair, dismiss }
}
