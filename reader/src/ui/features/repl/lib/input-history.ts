/**
 * The *REPL*'s *Input history*, oldest first, as `localStorage` keeps it for one Host app.
 *
 * Synchronous, and guarded the way `preference.ts` is: `localStorage` throws outright in a
 * browser with site data blocked, and a blocked history reads as empty and is kept for the
 * session alone.
 */

/** The most distinct inputs kept, the oldest dropped first. */
export const HISTORY_LIMIT = 200

/** One submitted input: when it ran, the console process it ran in, and whether it raised. */
export type HistoryEntry = { input: string; at: number; pid: number; raised: boolean }

/** The `localStorage` key `railsRoot`'s history is kept under, which a `storage` event names. */
export function historyKey(railsRoot: string) {
  return `rails-log-reader.repl-history:${railsRoot}`
}

/** What `railsRoot` has kept, or nothing when it is not known yet or storage is blocked. */
export function recallHistory(railsRoot: string | null): HistoryEntry[] {
  if (railsRoot === null) return []
  try {
    return parseHistory(localStorage.getItem(historyKey(railsRoot)))
  } catch {
    return []
  }
}

/** Stores `entries` as `railsRoot`'s history. A blocked write is dropped, and never written before the root is known. */
export function rememberHistory(railsRoot: string | null, entries: readonly HistoryEntry[]) {
  if (railsRoot === null) return
  try {
    localStorage.setItem(historyKey(railsRoot), JSON.stringify(entries))
  } catch {
    // The history still holds for this session.
  }
}

/** A stored history as entries: nothing for a value that is not one, only the entries in it that are whole, and the same distinct latest `HISTORY_LIMIT` a write keeps. */
export function parseHistory(stored: string | null): HistoryEntry[] {
  if (stored === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const whole = parsed.flatMap((each: Partial<HistoryEntry> | null) =>
    typeof each?.input === "string" && typeof each.at === "number" && typeof each.pid === "number"
      ? [{ input: each.input, at: each.at, pid: each.pid, raised: each.raised === true }]
      : [],
  )
  return whole.reduce<HistoryEntry[]>(withSubmitted, [])
}

/** `entries` with `entry` newest, a repeat of its input kept once at its latest, and only the latest `HISTORY_LIMIT` kept. */
export function withSubmitted(entries: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [...entries.filter((each) => each.input !== entry.input), entry].slice(-HISTORY_LIMIT)
}
