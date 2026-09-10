/**
 * The one number, and the one place it is written down.
 *
 * ADR-0003 bounds what the Reader reads on open — the last ~5,000 events, scanned backwards
 * from EOF — and #27 bounds what the Reader then holds. They are deliberately the *same*
 * figure rather than two that have to be reasoned about together: the fold opens holding
 * exactly the history it was given, and everything past it is reached the one way,
 * through the *load-earlier* control that continues the same backward scan.
 *
 * Which is why this sits in `shared/` and not beside the file reading: ingestion is a server
 * concern and the fold is a browser one, and the moment either of them owned the number the
 * other would be free to have its own.
 */
export const LOAD_ON_OPEN_EVENTS = 5_000
