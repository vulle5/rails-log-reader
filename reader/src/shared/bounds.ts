/** How many events the Reader reads on open, and how many it then holds. */
export const LOAD_ON_OPEN_EVENTS = 5_000

/**
 * How many bytes one *Load earlier* click reads before it stops, whatever it left split:
 * the Initializer's own cap on the Sidecar.
 */
export const EARLIER_BUDGET_BYTES = 64 * 1024 * 1024
