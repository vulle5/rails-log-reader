/**
 * The *REPL* session as the server holds it and every tab is shown it: the console process's
 * state, whether it is sandboxed, and the *Transcript*. The server sends a snapshot when a tab
 * attaches, then updates, and both sides fold an update with `applyReplUpdate`, so the
 * Transcript they hold is the same.
 */

import type { ActivityRow, EvaluationRow, EvictedEvaluations } from "./activity"

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

/**
 * An error an evaluation raised. Its `backtrace` runs from where it was raised down to the
 * developer's last `(repl):N` frame, so it holds none of the eval loop's own, and is empty for
 * an error that came before any of their code ran, such as a SyntaxError. It is cut to 64 KB of
 * frames, from its far end, when `cut`.
 */
export type RubyError = { className: string; message: string; backtrace: string[]; cut?: true }

/**
 * How an evaluation ended. An `error`'s `causes` are the errors that led to it, nearest first,
 * and only the nearest ten are held when `causesCut`.
 */
export type Outcome =
  /**
   * The name of its value's class, its value's `pretty_inspect`, cut to 64 KB when `cut`, and
   * the value laid out as `tree`. `inspectError` says what an `inspect` raised while the result
   * was built, when one did.
   */
  | { kind: "result"; className: string; text: string; cut: boolean; tree: RubyNode; inspectError: string | null }
  | ({ kind: "error" } & RubyError & { causes: RubyError[]; causesCut?: true })
  /** The console process ended before the evaluation answered. */
  | { kind: "lost" }

/**
 * What kind of Ruby value a node is: one the eval loop lays out, or a leaf's type class.
 *
 * Laid out: a `hash`, an `array`, a `set`, a `struct`, a `data`, a `record` (an Active Record
 * model's instance) and a `relation`. An `object` is laid out as its ivars when Ruby's own
 * `inspect` writes it, and is a leaf of its own `inspect` otherwise.
 *
 * A leaf: `time` is a Time or a Date, `decimal` a BigDecimal, `filtered` a record's attribute
 * the app's `filter_attributes` hide, and `cycle` a value met again inside itself, as Ruby's
 * `inspect` writes the repeat, such as `{...}`.
 */
export type RubyTypeClass =
  | "hash"
  | "array"
  | "set"
  | "struct"
  | "data"
  | "record"
  | "relation"
  | "nil"
  | "boolean"
  | "string"
  | "symbol"
  | "integer"
  | "float"
  | "rational"
  | "complex"
  | "decimal"
  | "time"
  | "object"
  | "filtered"
  | "cycle"

/**
 * A node of a result's value as the eval loop laid it out, breadth-first, until its node budget
 * was spent.
 */
export type RubyNode = {
  type: RubyTypeClass
  /** Its own `inspect`, cut to 4 KB when `cut`. */
  inspect: string
  cut?: true
  /** The name of its class, on a laid-out value other than a Hash or an Array. Absent for an anonymous class. */
  class?: string
  /**
   * The `[…]` that reaches it from its container. The whole value has none, and neither has a
   * Set's member, a Data's member or an ivar, which no `[…]` reaches.
   */
  step?: string
  /** A Hash's `[key, value]` pairs, in its order. A key is a leaf, never laid out. */
  pairs?: [RubyNode, RubyNode][]
  /** An Array's, a Set's or a Relation's items. A Relation's are its first ten records. */
  items?: RubyNode[]
  /** A record's attributes, a Struct's or a Data's members, or an object's ivars, by name. */
  fields?: [string, RubyNode][]
  /**
   * How many entries the budget left out, or `null` when a Relation has more records than it
   * holds, which the loop never counts. Absent for a value carried whole.
   */
  more?: number | null
}

/**
 * What kind of name a completion candidate is: a `method` or a `constant` after a `.` or a `::`,
 * and where none leads a `local`, a `keyword`, an `ivar`, a `cvar`, a `gvar`, a `symbol` or,
 * inside a `require`, a `path`.
 */
export type CandidateKind = "method" | "constant" | "local" | "ivar" | "cvar" | "gvar" | "keyword" | "symbol" | "path"

/** One completion candidate: the word that replaces what was typed of it, and what kind of name it is. */
export type Candidate = { text: string; kind: CandidateKind }

/**
 * What completing the word before a caret came to. Candidates are sorted, each once, and
 * `from` is where the word starts in the text: each candidate's `text` replaces the text from
 * there to the caret. `receiver` names what a member was asked of, and is `null` for a name no
 * `.` or `::` leads. When there are no candidates, `reason` says why.
 */
export type Completion =
  | { kind: "candidates"; from: number; receiver: string | null; candidates: Candidate[] }
  | { kind: "none"; reason: string }

/** One *Evaluation*: its input, what it printed, and how it ended, once it has. */
export type EvaluationEntry = { kind: "evaluation"; id: number; input: string; output: string; outputCut: boolean; outcome: Outcome | null }

export type TranscriptEntry =
  | EvaluationEntry
  /** What the console process printed outside any evaluation, such as while it booted. */
  | { kind: "output"; id: number; output: string; outputCut: boolean }

/**
 * A console process the session has started, by its pid, from when it said it was ready.
 * `cleared` once a Restart has emptied the Transcript of its entries.
 */
export type StartedConsole = { pid: number; cleared: boolean }

export type ReplSnapshot = {
  state: ReplState
  /** Whether the console process was started with `--sandbox`: the choice the latest Restart made. */
  sandbox: boolean
  /** What the eval loop said it can do besides evaluate, when it was ready. */
  capabilities: readonly string[]
  transcript: readonly TranscriptEntry[]
  /**
   * Every console process the session has started, oldest first. The Transcript's entries are
   * all the one's that is not `cleared`, if any.
   */
  consoles: readonly StartedConsole[]
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
 * check's or a completion's answer only to the tab that asked, under the id it asked with. The exit notice goes
 * to every tab, once for each console process that ends, including one a Restart replaced, and
 * changes nothing the session holds.
 */
export type ReplMessage =
  | { type: "snapshot"; snapshot: ReplSnapshot }
  | ReplUpdate
  | { type: "refused"; reason: string; input: string }
  | { type: "checked"; id: number; complete: boolean }
  | { type: "completions"; id: number; completion: Completion }
  | { type: "exit"; pid: number }

/**
 * What a tab sends the server. `boot` starts the console process unless one has been started.
 * `check` asks whether `text` is a whole input or needs more lines, and `complete` what the word
 * ending at `caret` in `text`, counted in UTF-16 code units, could be. `interrupt` interrupts the
 * running evaluation, if any. `restart` stops the one running, if any, and starts a fresh one.
 */
export type ReplCommand =
  | { type: "boot" }
  | { type: "submit"; input: string }
  | { type: "check"; id: number; text: string }
  | { type: "complete"; id: number; text: string; caret: number }
  | { type: "interrupt" }
  | { type: "restart"; sandbox: boolean }

export const EMPTY_SNAPSHOT: ReplSnapshot = { state: { kind: "idle" }, sandbox: false, capabilities: [], transcript: [], consoles: [] }

/** Whether `message` is an update `applyReplUpdate` folds, rather than a snapshot, a refusal, an answer or an exit notice. */
export function isReplUpdate(message: ReplMessage): message is ReplUpdate {
  return (
    message.type !== "snapshot" &&
    message.type !== "refused" &&
    message.type !== "checked" &&
    message.type !== "completions" &&
    message.type !== "exit"
  )
}

/** `snapshot` with `update` applied. Never changes `snapshot` itself. */
export function applyReplUpdate(snapshot: ReplSnapshot, update: ReplUpdate): ReplSnapshot {
  switch (update.type) {
    case "state":
      return { ...snapshot, state: update.state, capabilities: update.capabilities, consoles: started(snapshot.consoles, update.state) }
    case "entry":
      return { ...snapshot, transcript: [...snapshot.transcript, update.entry].slice(-TRANSCRIPT_LIMIT) }
    case "output":
      return replacing(snapshot, update.id, (entry) => printed(entry, update.text))
    case "finished":
      return replacing(snapshot, update.id, (entry) => (entry.kind === "evaluation" ? { ...entry, outcome: update.outcome } : entry))
    case "restarted":
      return {
        ...snapshot,
        sandbox: update.sandbox,
        transcript: [],
        consoles: snapshot.consoles.map((started) => ({ ...started, cleared: true })),
      }
  }
}

/**
 * Where an *Evaluation*'s entry is: `held` in the Transcript, or why it is gone. A Restart
 * cleared it, or the Transcript dropped it as one of its oldest, or it was run `elsewhere`: by a
 * console process this session never started, such as one an earlier Reader started.
 */
export type HeldEntry = { kind: "held"; entry: EvaluationEntry } | { kind: "gone"; reason: "restarted" | "dropped" | "elsewhere" }

/**
 * The entry of the evaluation the console process `pid` recorded in the Sidecar as
 * `evaluationId`, or why there is none. The eval loop records an evaluation as
 * `repl-<token>-<id>`, where `id` is its entry's. `pid` is `null` when it is not known.
 */
export function evaluationEntry(snapshot: ReplSnapshot, pid: number | null, evaluationId: string): HeldEntry {
  const id = entryId(evaluationId)
  const ranIn = snapshot.consoles.filter((started) => started.pid === pid)
  if (ranIn.length === 0 || id === null) return { kind: "gone", reason: "elsewhere" }
  if (ranIn.every((started) => started.cleared)) return { kind: "gone", reason: "restarted" }

  const entry = snapshot.transcript.find((each) => each.kind === "evaluation" && each.id === id)
  return entry?.kind === "evaluation" ? { kind: "held", entry } : { kind: "gone", reason: "dropped" }
}

/**
 * Where an evaluation entry's *Evaluation row* is: `held` in the Activity table, or `evicted`
 * by the *Memory bound*. An entry with neither has no row: its console process ran it with no
 * Initializer recording it, or with one that was disabled.
 */
export type EntryRow = { kind: "held"; row: EvaluationRow } | { kind: "evicted" }

/**
 * The *Evaluation row* of each Transcript entry that has one, by the entry's id: a row of
 * `rows` the Transcript's console process ran, or one `evicted` names with that process's pid,
 * as `ActivityTable.evictedEvaluations` does.
 */
export function entryRows(
  snapshot: ReplSnapshot,
  rows: readonly ActivityRow[],
  evicted: EvictedEvaluations,
): ReadonlyMap<number, EntryRow> {
  const found = new Map<number, EntryRow>()
  const pid = snapshot.consoles.find((started) => !started.cleared)?.pid
  if (pid === undefined) return found

  for (const [evaluationId, ranBy] of evicted) {
    const id = entryId(evaluationId)
    if (ranBy === pid && id !== null) found.set(id, { kind: "evicted" })
  }
  for (const row of rows) {
    const id = row.kind === "evaluation" && row.pid === pid ? entryId(row.evaluationId) : null
    if (row.kind === "evaluation" && id !== null) found.set(id, { kind: "held", row })
  }
  return found
}

/** The id of the entry the eval loop recorded as `evaluationId`, `repl-<token>-<id>`, or `null` when it is not one of its. */
function entryId(evaluationId: string) {
  const id = /^repl-[^-]+-(\d+)$/.exec(evaluationId)?.[1]
  return id === undefined ? null : Number(id)
}

/** `consoles` with the console process `state` says is ready, unless it is already there and not cleared. */
function started(consoles: readonly StartedConsole[], state: ReplState) {
  if (state.kind !== "ready" || consoles.some((each) => each.pid === state.pid && !each.cleared)) return consoles
  return [...consoles, { pid: state.pid, cleared: false }]
}

/** The pid of the console process `state` has running, or `null` when none is. */
export function runningPid(state: ReplState): number | null {
  return state.kind === "ready" || state.kind === "busy" ? state.pid : null
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

/**
 * Why a completion asked in `state`, by a console process with `capabilities`, is not asked, or
 * `null` when it would be. It never runs beside an evaluation.
 */
export function completeRefusal(state: ReplState, capabilities: readonly string[]): string | null {
  if (state.kind === "busy") return "Completion waits for the running evaluation to finish."
  if (state.kind !== "ready") return submitRefusal(state)
  return capabilities.includes("complete") ? null : "Completion isn't available."
}

function replacing(snapshot: ReplSnapshot, id: number, change: (entry: TranscriptEntry) => TranscriptEntry) {
  return { ...snapshot, transcript: snapshot.transcript.map((entry) => (entry.id === id ? change(entry) : entry)) }
}

function printed<Entry extends TranscriptEntry>(entry: Entry, text: string): Entry {
  if (entry.outputCut) return entry

  const output = entry.output + text
  return output.length > OUTPUT_LIMIT ? { ...entry, output: output.slice(0, OUTPUT_LIMIT), outputCut: true } : { ...entry, output }
}
