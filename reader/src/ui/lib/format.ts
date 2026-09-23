import type { RequestRow, RunRow } from "../../shared/activity"

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

/**
 * The one lookup the Activity table's method cell and the Detail heading's method share, as
 * the `data-method` both carry, so a verb renders the same colour in both places, or a colour
 * drifting between them would be a bug this function alone could have caught. GET keeps the
 * accent already used for it; POST, PUT/PATCH — read as one bucket, both "modify" — and DELETE
 * each get one of their own. Everything else — HEAD, OPTIONS, a verb this Reader has never
 * heard of, or no method at all — is `"other"`, which is plain neutral text and never GET's
 * colour by accident.
 */
export function methodCategory(method: string | null) {
  switch (method) {
    case "GET":
      return "get"
    case "POST":
      return "post"
    case "PUT":
    case "PATCH":
      return "put-patch"
    case "DELETE":
      return "delete"
    default:
      return "other"
  }
}

/**
 * The colour of each of `methodCategory`'s categories, read off the `data-method` it is
 * written to. A *Run row*'s kind carries no `data-method` — it is not a method to begin with.
 */
export const METHOD_TEXT =
  "data-[method=get]:text-accent data-[method=post]:text-method-post data-[method=put-patch]:text-method-put-patch data-[method=delete]:text-method-delete data-[method=other]:text-foreground"

/**
 * A status's `data-status`, grouped by class and not by exact code: a 404 and a 422 read the
 * same colour, and so do a 500 and a 503 — `5xx` shares `error` with a finish that had no
 * status rather than getting a token of its own, since a 5xx is the same failure. Only 4xx and
 * 5xx are ever coloured — 1xx, 2xx and 3xx render unchanged, so this returns `null` for them
 * rather than a category that would have to be styled as a no-op.
 */
export function statusCategory(status: number) {
  if (status >= 400 && status < 500) return "4xx"
  if (status >= 500 && status < 600) return "5xx"
  return null
}
