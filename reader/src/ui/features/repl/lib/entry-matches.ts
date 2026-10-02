import type { EvaluationEntry, Outcome, RubyError, TranscriptEntry } from "../../../../shared/repl"
import type { Search } from "../../../hooks/search"
import { countMatches } from "../../value-viewer/lib/value-matches"
import { described } from "./ruby-error"
import { rubySource } from "./ruby-source"

/**
 * *Search* in the *REPL*: how many matches of the current term a *Transcript* entry lights, the
 * same ones its components light. An input, what was printed, a result and an error's class,
 * message and frames are matched, each on its own. The Reader's own words are never matched:
 * `›` and `=>`, the row link, a cut's note, `Caused by`, and what is said for an evaluation the
 * console process never answered.
 */

/** How many matches the *Transcript* lights in all of `entries`, every result drawn pretty. */
export function transcriptMatches(search: Search, entries: readonly TranscriptEntry[]) {
  return entries.reduce((count, entry) => count + entryMatches(search, entry), 0)
}

function entryMatches(search: Search, entry: TranscriptEntry) {
  if (entry.kind === "output") return search.find(entry.output).length
  return search.find(entry.input).length + resultMatches(search, entry, false)
}

/** How many matches the Result tab lights in an evaluation's entry, its result drawn `raw` or pretty: never its input, which it does not show. */
export function resultMatches(search: Search, entry: EvaluationEntry, raw: boolean) {
  return search.find(entry.output).length + answerMatches(search, entry.outcome, raw)
}

/** How many matches an evaluation's answer lights, its result drawn `raw` or pretty. */
function answerMatches(search: Search, outcome: Outcome | null, raw: boolean) {
  switch (outcome?.kind) {
    case "result": {
      const source = rubySource(outcome.tree)
      return source === null || raw ? search.find(outcome.text).length : countMatches(search, source.tree)
    }
    case "error":
      return [outcome, ...outcome.causes].reduce((count, error) => count + errorMatches(search, error), 0)
    case "lost":
    case undefined:
      return 0
  }
}

/** How many matches of the current term lie in an error's frames. */
export function framesMatches(search: Search, { backtrace }: RubyError) {
  return backtrace.reduce((count, frame) => count + search.find(frame).length, 0)
}

function errorMatches(search: Search, error: RubyError) {
  return search.find(described(error)).length + framesMatches(search, error)
}
