/**
 * Whether a hostname names this machine in a way DNS cannot rebind: the only hosts an act is
 * served to, and so the only pages that offer one. The server asks it of a request's `Host`,
 * the page of its own `location.hostname`. Exact, with no port: a remapped forward keeps its
 * hostname and changes only its port.
 */
export function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1"
}
