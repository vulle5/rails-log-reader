/**
 * The names beyond `localhost` and `127.0.0.1` the Reader answers to, for a tunnel that shows
 * the log on another device. Read once at this process's own startup, like
 * `RAILS_LOG_READER_PORT`. Hostnames only, with no port, because a tunnel arrives on 443
 * whatever the Reader's own port is. A leading dot allows the name and every name under it, as
 * Rails' `config.hosts` does.
 *
 * There is no allow-all value. A listed host is served views and refused acts.
 */

export const ALLOWED_HOSTS_VARIABLE = "RAILS_LOG_READER_ALLOWED_HOSTS"

const HOSTNAME = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/

/**
 * The listed hostnames, lower-cased, or `null` when an entry is not a bare hostname. A port, a
 * scheme or a `*` is a mistake to report: silently dropping it would leave the developer's
 * tunnel refused with no reason given.
 */
export function readAllowedHosts(setting: string | undefined): string[] | null {
  if (setting === undefined) return []

  const hosts = setting
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "")

  return hosts.every((host) => HOSTNAME.test(host)) ? hosts : null
}

/** Whether `hostname`, already lower-cased and without its port, is one `allowed` lists. */
export function isAllowedHost(hostname: string, allowed: readonly string[]) {
  return allowed.some((entry) =>
    entry.startsWith(".") ? hostname === entry.slice(1) || hostname.endsWith(entry) : hostname === entry,
  )
}
