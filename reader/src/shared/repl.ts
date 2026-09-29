/**
 * The *REPL* session as the server holds it and every tab is shown it: the console process's
 * state, whether it is sandboxed, and the *Transcript*. The server sends a snapshot when a tab
 * attaches, then updates, and both sides fold an update with `applyReplUpdate`, so the
 * Transcript they hold is the same.
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
  | ExitedState

/**
 * The console process ended, or never started. `code` is its exit code and `signal` the signal
 * that ended it, and both are `null` when it never started. `stderr` is the latest of what it
 * printed on fd 2, or why it could not start.
 */
export type ExitedState = { kind: "exited"; code: number | null; signal: string | null; stderr: string }

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
  /** Whether the console process was started with `--sandbox`: the choice the latest Restart made. */
  sandbox: boolean
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
  /** A Restart: the Transcript is emptied, and the console process it starts is sandboxed when `sandbox`. */
  | { type: "restarted"; sandbox: boolean }

/**
 * What the server sends a tab. A refusal goes only to the tab whose input was refused, and a
 * check's answer only to the tab that asked, under the id it asked with. The exit notice goes
 * to every tab, once for each console process that ends, including one a Restart replaced, and
 * changes nothing the session holds.
 */
export type ReplMessage =
  | { type: "snapshot"; snapshot: ReplSnapshot }
  | ReplUpdate
  | { type: "refused"; reason: string; input: string }
  | { type: "checked"; id: number; complete: boolean }
  | { type: "exit"; pid: number }

/**
 * What a tab sends the server. `boot` starts the console process unless one has been started.
 * `check` asks whether `text` is a whole input or needs more lines. `interrupt` interrupts the
 * running evaluation, if any. `restart` stops the one running, if any, and starts a fresh one.
 */
export type ReplCommand =
  | { type: "boot" }
  | { type: "submit"; input: string }
  | { type: "check"; id: number; text: string }
  | { type: "interrupt" }
  | { type: "restart"; sandbox: boolean }

export const EMPTY_SNAPSHOT: ReplSnapshot = { state: { kind: "idle" }, sandbox: false, capabilities: [], transcript: [] }

/** Whether `message` is an update `applyReplUpdate` folds, rather than a snapshot, a refusal, a check's answer or an exit notice. */
export function isReplUpdate(message: ReplMessage): message is ReplUpdate {
  return message.type !== "snapshot" && message.type !== "refused" && message.type !== "checked" && message.type !== "exit"
}

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
    case "restarted":
      return { ...snapshot, sandbox: update.sandbox, transcript: [] }
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
