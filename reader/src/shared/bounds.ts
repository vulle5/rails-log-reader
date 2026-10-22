/**
 * How many events the Reader reads on open, and how many it then holds, until *Events kept*
 * says otherwise: the default, and the lowest choice.
 */
export const LOAD_ON_OPEN_EVENTS = 5_000

/** The figures *Events kept* offers: the one list the Settings entry and the server's check both read. */
export const EVENTS_KEPT_CHOICES: readonly number[] = [LOAD_ON_OPEN_EVENTS, 10_000, 25_000, 50_000]

/**
 * The *Events kept* figure `text` names — a stored preference or a query parameter — or `null`
 * when it is anything but one of the choices. Whole numbers only, spelled the way `String`
 * spells them, so `5000.0` and ` 5000` are not the figure.
 */
export function eventsKeptFrom(text: string): number | null {
  return EVENTS_KEPT_CHOICES.find((choice) => String(choice) === text) ?? null
}
