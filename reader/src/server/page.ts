import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import index from "../ui/index.html"
import { onShutdown } from "./shutdown"

type Development = Bun.Serve.Options<undefined>["development"]

/** A browser's WebSocket held open to the page server's own, and what it sent before that opened. */
export type PageSocket = {
  kind: "page"
  path: string
  protocols: string[]
  upstream?: WebSocket
  queued: (string | Uint8Array<ArrayBuffer>)[]
}

/**
 * The HTML bundle, served on a unix socket of its own and reached only through the Reader's
 * gated server. `Bun.serve` serves an HTML bundle, its assets and, in development, its HMR
 * socket without calling any handler of the Reader's, so a bundle on the Reader's own port
 * would answer every `Host`. Browsers cannot open a unix socket.
 *
 * `fetch` passes a GET or HEAD on as it came, minus the `Host` and `Origin` the gate has
 * already judged, which Bun's development server would otherwise judge again by its own rules.
 * `websocket` does the same for the HMR socket, which exists only in development. Anything
 * else is refused here, because what reaches `fetch` is what no route declared, and it was
 * gated as a view: a write or a socket of the Reader's own is an act, and needs its route.
 */
export function servePage(development: Development) {
  const socket = pageSocket(development)
  const hmr = development !== false && development !== undefined
  const forwarded = { host: "localhost", origin: "http://localhost" }

  function fetch(request: Request, server: Bun.Server<PageSocket>) {
    const url = new URL(request.url)
    const path = url.pathname + url.search

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!hmr || url.pathname !== "/_bun/hmr") return new Response(null, { status: 404 })
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((each) => each.trim()).filter(Boolean)
      const data: PageSocket = { kind: "page", path, protocols, queued: [] }
      const upgraded =
        protocols[0] === undefined
          ? server.upgrade(request, { data })
          : server.upgrade(request, { data, headers: new Headers({ "sec-websocket-protocol": protocols[0] }) })
      return upgraded ? undefined : new Response(null, { status: 400 })
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
    }

    const headers = new Headers(request.headers)
    headers.set("host", forwarded.host)
    headers.delete("origin")
    return globalThis.fetch(new URL(path, "http://localhost"), {
      unix: socket,
      method: request.method,
      headers,
      redirect: "manual",
      decompress: false,
    })
  }

  const websocket: Bun.WebSocketHandler<PageSocket> = {
    open(browser) {
      // Bun's own constructor, which takes headers: the DOM's, which the types describe, does not.
      const options = { headers: forwarded, protocols: browser.data.protocols } as unknown as string[]
      const upstream = new WebSocket(`ws+unix://${socket}:${browser.data.path}`, options)
      upstream.binaryType = "arraybuffer"
      browser.data.upstream = upstream

      upstream.onopen = () => {
        for (const message of browser.data.queued.splice(0)) upstream.send(message)
      }
      upstream.onmessage = (event) => browser.send(event.data as string | ArrayBuffer)
      upstream.onclose = () => browser.close()
    },
    message(browser, received) {
      const message = typeof received === "string" ? received : new Uint8Array(received)
      const upstream = browser.data.upstream
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(message)
      else browser.data.queued.push(message)
    },
    close(browser) {
      browser.data.upstream?.close()
    },
  }

  return { fetch, websocket }
}

declare global {
  /** The page server's socket, kept on `globalThis` because `bun --hot` runs this module again. */
  var readerPageSocket: string | undefined
}

/**
 * The socket the page server listens on, started on the first call and the same one after.
 * The HTML bundle reloads itself in development, so a server module that `--hot` runs again
 * has no reason to start a second.
 */
function pageSocket(development: Development) {
  if (globalThis.readerPageSocket !== undefined) return globalThis.readerPageSocket

  const directory = mkdtempSync(join(tmpdir(), "rails-log-reader-"))
  const socket = join(directory, "page.sock")
  onShutdown(() => rmSync(directory, { recursive: true, force: true }))

  Bun.serve({ unix: socket, routes: { "/*": index }, development })
  globalThis.readerPageSocket = socket
  return socket
}
