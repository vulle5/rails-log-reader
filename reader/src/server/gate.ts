import { isLoopbackHostname } from "../shared/loopback"
import { ALLOWED_HOSTS_VARIABLE, isAllowedHost } from "./allowed-hosts"

/**
 * What a route does, decided once where the route is declared. A view shows the log and is
 * served to any allowed host. An act does something on this machine, and is served only to a
 * loopback host, from the Reader's own page.
 */
export type RouteKind = "view" | "act"

/**
 * Why `request` may not be served, as the words the Reader prints about it, or `null` when it
 * may. The `Host` must be loopback or listed, on any port. An act's `Origin` must be exactly
 * `http://` + that `Host`, so a missing or `null` one is refused. A view's may also be
 * `https://` + that `Host`, the page of a tunnel that serves https and passes it on as http. A
 * view needs no `Origin`, and a same-origin GET has none.
 */
export function refusal(request: Request, kind: RouteKind, allowedHosts: readonly string[]): string | null {
  const host = request.headers.get("host")
  const hostname = host === null ? null : hostnameOf(host)

  if (host === null || hostname === null) return "a request with no readable Host"

  const loopback = isLoopbackHostname(hostname)
  if (!loopback && !isAllowedHost(hostname, allowedHosts)) {
    return `Host ${host}: not localhost, 127.0.0.1, or a name in ${ALLOWED_HOSTS_VARIABLE}`
  }
  if (kind === "act" && !loopback) return `Host ${host}: acting needs localhost`

  const origin = request.headers.get("origin")
  if (origin === null) return kind === "act" ? `a request to act on Host ${host} with no Origin` : null
  const own = kind === "act" ? [`http://${host}`] : [`http://${host}`, `https://${host}`]
  if (!own.includes(origin)) return `Origin ${origin} on Host ${host}`

  return null
}

/**
 * The hostname of a `Host` header, lower-cased, or `null` when it is not a name with an
 * optional port. An IPv6 literal is `null` too: it is neither loopback name nor listable.
 */
function hostnameOf(host: string) {
  const [, hostname, port] = /^([^:]+)(?::(\d+))?$/.exec(host) ?? []
  if (hostname === undefined || !/^[a-z0-9.-]+$/i.test(hostname)) return null
  if (port !== undefined && Number(port) > 65_535) return null
  return hostname.toLowerCase()
}
