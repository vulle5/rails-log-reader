import { useEffect, useState } from "react"

import { isLoopbackHostname } from "../../shared/loopback"

/**
 * Where the Reader's acts can be made from, when this page is not there, else `null`. The page
 * judges by its own hostname with the rule the server applies to `Host`, so a page opened
 * through a listed host shows no button the Reader would refuse.
 *
 * The port comes from `GET /reader-port`, fetched once: a tunnel's address carries its own
 * port, not the Reader's. Plain `localhost` until it answers.
 */
export function useActsOnlyFrom() {
  const mayAct = isLoopbackHostname(window.location.hostname)
  const [port, setPort] = useState<number | null>(null)

  useEffect(() => {
    if (mayAct) return
    let cancelled = false

    fetch("/reader-port")
      .then((response) => response.json() as Promise<{ port: number }>)
      .then((body) => {
        if (!cancelled) setPort(body.port)
      })
      .catch(() => {
        // Left as plain `localhost`, which is still where acting is possible from.
      })

    return () => {
      cancelled = true
    }
  }, [mayAct])

  if (mayAct) return null
  return port === null ? "localhost" : `localhost:${port}`
}
