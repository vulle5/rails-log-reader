import type { RequestRow, RunRow } from "../shared/activity"

/** The Reader's display conversions, in one place because two columns show the same numbers. */

/**
 * `at_wall` is display only: read here, and never sorted on or subtracted anywhere. Local
 * time, because a strictly local tool is read beside the terminal that printed the request.
 */
export function clock(at: number | null) {
  if (at === null) return ""

  const when = new Date(at)
  const hours = String(when.getHours()).padStart(2, "0")
  const minutes = String(when.getMinutes()).padStart(2, "0")
  const seconds = String(when.getSeconds()).padStart(2, "0")
  return `${hours}:${minutes}:${seconds}.${String(when.getMilliseconds()).padStart(3, "0")}`
}

/** Rails' own shorthand: the suffix every controller carries says nothing. */
export function controllerAction(row: RequestRow) {
  if (row.controller === null) return "—"
  return `${row.controller.replace(/Controller$/, "")}#${row.action ?? ""}`
}

/** A zero is blank, so the eye only ever lands on a count that is there. */
export function count(howMany: number) {
  return howMany === 0 ? "" : String(howMany)
}

export function ms(duration: number | null) {
  if (duration === null) return ""
  return duration < 10 ? `${duration.toFixed(1)}ms` : `${Math.round(duration)}ms`
}

/**
 * How long a request has been in flight. Read in seconds and never in milliseconds, because
 * this number is watched rather than compared: a request still running is already past the
 * point where a millisecond meant anything, and a tenth of a second is what makes the pill
 * visibly climb. Minutes and hours are spelled out rather than left as `184.0s`, since a
 * request that has hung that long is the one this column exists for.
 */
export function elapsed(duration: number) {
  const seconds = Math.max(duration, 0) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds - minutes * 60)}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * What a *Run row* is a row for, in the words the `run_header` used. `null` where the Reader
 * attached inside the Run and never saw one: "Run" alone, because the one thing it knows is
 * that these events came from a process it never met the start of.
 */
export function runDescription(row: Pick<RunRow, "runKind" | "pid">) {
  return {
    kind: row.runKind ?? "Run",
    /** Whatever else the header said about the process, and nothing where it said nothing. */
    facts: row.pid === null ? [] : [`pid ${row.pid}`],
  }
}
