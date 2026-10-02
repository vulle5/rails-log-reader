/**
 * The cut a *Transcript* entry makes in what it printed and in its result as first drawn, so one
 * long entry never buries the rest.
 */

/** The most lines an entry draws of what it printed, and of its result, before it cuts them. */
export const ENTRY_LINES = 20

/**
 * `text` cut to its first `limit` lines, and how many lines it left out, or `null` when `text`
 * has no more than `limit`. A line break that ends `text` starts no line of its own.
 */
export function cutLines(text: string, limit: number): { shown: string; more: number } | null {
  const lines = text.replace(/\n$/, "").split("\n")
  if (lines.length <= limit) return null
  return { shown: lines.slice(0, limit).join("\n"), more: lines.length - limit }
}
