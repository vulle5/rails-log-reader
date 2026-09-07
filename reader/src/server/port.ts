/**
 * Which port the Reader listens on.
 *
 * Fixed by default, and that is the point: `rails-log-reader` and 5273 is the whole of what
 * a developer has to keep in their head, with nothing to configure and nothing to be told.
 *
 * The override exists because "fixed" and "one at a time" were the same sentence, and they
 * should not have to be. Two Rails apps open at once want two Readers, and the Reader's own
 * tests want a port that a Reader someone left running could not possibly be holding — the
 * suite used to fail for exactly that reason. `0` is honoured and means "whatever the OS
 * has free", which is what those tests use: the Reader announces the port it actually got,
 * so nothing downstream has to guess or race to claim one first.
 *
 * Namespaced rather than the conventional bare `PORT`, which a Rails developer may well
 * have exported for `rails s` or for a `foreman` line. A Reader that silently moved because
 * of a variable meant for something else would be worse than one that could not move at all.
 */

export const PORT_VARIABLE = "RAILS_LOG_READER_PORT"

export const DEFAULT_PORT = 5273

/**
 * The port the setting asks for, or `null` if it asks for something that is not one — which
 * is a mistake to report rather than to fall back from. Silently serving on 5273 because
 * `RAILS_LOG_READER_PORT=808O` has a letter in it would send a developer to the wrong tab
 * and tell them the Reader was broken.
 */
export function readPort(setting: string | undefined): number | null {
  if (setting === undefined || setting.trim() === "") return DEFAULT_PORT

  const port = Number(setting)
  // `0` is the ask for an ephemeral one and is allowed; 65535 is the last real port.
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return null

  return port
}
