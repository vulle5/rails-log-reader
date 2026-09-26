/**
 * A Reader-side preference, kept in `localStorage` under `rails-log-reader.<setting>`.
 *
 * Synchronous, so a preference is there to read before first paint. Every read and write is
 * guarded: `localStorage` throws outright in a browser with site data blocked, and a blocked
 * preference reads as its default.
 */
export type PreferenceSetting =
  | "theme"
  | "editor-scheme"
  | "console-filter"
  | "detail-filter"
  | "console-width"
  | "detail-width"
  | "console-collapsed"
  | "hidden-table-columns"

function keyFor(setting: PreferenceSetting) {
  return `rails-log-reader.${setting}`
}

/**
 * The stored preference, read through `parse` — or `fallback` when nothing is stored, storage
 * is blocked, or `parse` throws.
 */
export function recallPreference<T>(setting: PreferenceSetting, fallback: T, parse: (stored: string) => T): T {
  try {
    const stored = localStorage.getItem(keyFor(setting))
    return stored === null ? fallback : parse(stored)
  } catch {
    return fallback
  }
}

/** Stores `value`, or forgets the preference when it is `null`. A blocked write is dropped. */
export function rememberPreference(setting: PreferenceSetting, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(keyFor(setting))
    else localStorage.setItem(keyFor(setting), value)
  } catch {
    // The preference still applies for this session.
  }
}
