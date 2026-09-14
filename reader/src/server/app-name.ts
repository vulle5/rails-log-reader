/**
 * The Host app's display name, when the developer wants it fixed rather than read off the
 * wire — a Bun-process env var, read once at this process's own startup, mirroring
 * `RAILS_LOG_READER_PORT`'s own pattern rather than the wire's `run_header.app_name`. There
 * is no shell to export a Host-app-side variable from under puma-dev, the same constraint
 * that ruled one out for the Marker file — but the Reader is started from the developer's own
 * shell, which is exactly the shell this reads from.
 */

export const APP_NAME_VARIABLE = "RAILS_LOG_READER_APP_NAME"

/**
 * The override the setting asks for, or `null` if none was set. Unlike the port, there is no
 * invalid value to refuse — any non-empty string names an app — so the only thing this tells
 * apart is set from unset, trimmed so a shell that exports the empty string, or one with
 * stray surrounding whitespace, reads the same as whatever was actually meant.
 */
export function readAppNameOverride(setting: string | undefined): string | null {
  if (setting === undefined) return null

  const trimmed = setting.trim()
  return trimmed === "" ? null : trimmed
}
