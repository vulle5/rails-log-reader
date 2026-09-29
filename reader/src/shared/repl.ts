/**
 * The *REPL* session as the server holds it and every tab is shown it: the console process's
 * state, and the *Transcript*. The server sends a snapshot when a tab attaches, then updates,
 * and both sides fold an update with `applyReplUpdate`, so the Transcript they hold is the same.
 */

/** The most entries the Transcript holds. The oldest drop first. */
export const TRANSCRIPT_LIMIT = 100

/**
 * The most text an entry's printed output holds. What is printed past it is dropped, and the
 * entry says so.
 */
export const OUTPUT_LIMIT = 64 * 1024

export type ReplState =
  /** No console process has been started: no tab has opened the drawer yet. */
  | { kind: "idle" }
  | { kind: "booting" }
  | { kind: "ready"; pid: number }
  /** Running evaluation `id`, sent at `since`, in milliseconds since the epoch. */
  | { kind: "busy"; pid: number; id: number; since: number }
  /** `code` is `null` when the process was never started or ended on a signal. */
  | { kind: "exited"; code: number | null }

export type Outcome =
  /** Its value's `pretty_inspect`, cut to 64 KB when `cut`. */
  | { kind: "result"; text: string; cut: boolean }
  | { kind: "error"; className: string; message: string }
  /** The console process ended before the evaluation answered. */
  | { kind: "lost" }

export type TranscriptEntry =
  /** One *Evaluation*: its input, what it printed, and how it ended, once it has. */
  | { kind: "evaluation"; id: number; input: string; output: string; outputCut: boolean; outcome: Outcome | null }
  /** What the console process printed outside any evaluation, such as while it booted. */
  | { kind: "output"; id: number; output: string; outputCut: boolean }

export type ReplSnapshot = {
  state: ReplState
  /** What the eval loop said it can do besides evaluate, when it was ready. */
  capabilities: readonly string[]
  transcript: readonly TranscriptEntry[]
}

export type ReplUpdate =
  | { type: "state"; state: ReplState; capabilities: readonly string[] }
  /** An entry opened: an evaluation the moment it is sent, or output printed outside one. */
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "output"; id: number; text: string }
  | { type: "finished"; id: number; outcome: Outcome }

/** What the server sends a tab. A refusal goes only to the tab whose input was refused. */
export type ReplMessage = { type: "snapshot"; snapshot: ReplSnapshot } | ReplUpdate | { type: "refused"; reason: string; input: string }

/** What a tab sends the server. `boot` starts the console process unless one has been started. */
export type ReplCommand = { type: "boot" } | { type: "submit"; input: string }

export const EMPTY_SNAPSHOT: ReplSnapshot = { state: { kind: "idle" }, capabilities: [], transcript: [] }

/** `snapshot` with `update` applied. Never changes `snapshot` itself. */
export function applyReplUpdate(snapshot: ReplSnapshot, update: ReplUpdate): ReplSnapshot {
  switch (update.type) {
    case "state":
      return { ...snapshot, state: update.state, capabilities: update.capabilities }
    case "entry":
      return { ...snapshot, transcript: [...snapshot.transcript, update.entry].slice(-TRANSCRIPT_LIMIT) }
    case "output":
      return replacing(snapshot, update.id, (entry) => printed(entry, update.text))
    case "finished":
      return replacing(snapshot, update.id, (entry) => (entry.kind === "evaluation" ? { ...entry, outcome: update.outcome } : entry))
  }
}

/** Why an input submitted in `state` is refused, or `null` when it would run. */
export function submitRefusal(state: ReplState): string | null {
  switch (state.kind) {
    case "idle":
      return "The REPL hasn't started."
    case "booting":
      return "The REPL is still booting."
    case "ready":
      return null
    case "busy":
      return "Already running. Wait for it to finish."
    case "exited":
      return "The REPL has exited."
  }
}

function replacing(snapshot: ReplSnapshot, id: number, change: (entry: TranscriptEntry) => TranscriptEntry) {
  return { ...snapshot, transcript: snapshot.transcript.map((entry) => (entry.id === id ? change(entry) : entry)) }
}

function printed<Entry extends TranscriptEntry>(entry: Entry, text: string): Entry {
  if (entry.outputCut) return entry

  const output = entry.output + text
  return output.length > OUTPUT_LIMIT ? { ...entry, output: output.slice(0, OUTPUT_LIMIT), outputCut: true } : { ...entry, output }
}
