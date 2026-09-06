import { join } from "node:path"

import index from "../ui/index.html"
import { RAILS_ROOT_MARKER, findRailsRoot } from "./rails-root"
import { openSidecar, type Sidecar } from "./sidecar"

/** Fixed, so there is nothing to configure and nothing to tell the Reader about. */
const PORT = 5273

const railsRoot = findRailsRoot(process.cwd())

if (railsRoot === null) {
  console.error(
    `rails-log-reader: ${process.cwd()} is not a Rails root.\n` +
      `No ${RAILS_ROOT_MARKER} was found here or in any parent directory. ` +
      `Start the Reader from inside your Rails app.`,
  )
  process.exit(1)
}

const logDirectory = join(railsRoot, "log")

/**
 * The server is the Sidecar and nothing else: it holds no fold, no rows and no history of
 * its own, and sends envelopes on exactly as they were appended. The wire contract stays
 * the only thing the two halves share, and the browser holds the model — so a second tab
 * is a second reader of the same file rather than a share of one server-side state.
 *
 * A connection is one attachment to the Sidecar, opening on the load-on-open history and
 * following the file from there. `(run_id, seq)` makes a reconnection free: the browser
 * folds what it already has for a second time and nothing doubles.
 */
function envelopeStream() {
  let attached: Sidecar | null = null

  const envelopes = new ReadableStream<string>({
    async start(controller) {
      // An SSE comment, sent before anything is read. The response headers do not leave the
      // server until the body produces its first bytes, and a Reader watching a Rails app
      // that has not booted yet has nothing to say for as long as that takes — so without
      // this the browser cannot tell "attached, and quiet" from "not attached".
      controller.enqueue(": attached\n\n")

      attached = await openSidecar(logDirectory, (batch) => {
        try {
          controller.enqueue(`data: ${JSON.stringify(batch)}\n\n`)
        } catch {
          // The browser went away between one append and the next. Let go of the Sidecar
          // here rather than waiting for a `cancel` that an errored stream may never send:
          // a watcher and a 1 Hz timer left behind would follow the file forever.
          attached?.close()
        }
      })
    },
    cancel() {
      attached?.close()
    },
  })

  return new Response(envelopes.pipeThrough(new TextEncoderStream()), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  })
}

const server = Bun.serve({
  port: PORT,
  routes: {
    "/events": envelopeStream,
    "/*": index,
  },
  development: process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
})

console.log(`Rails log reader  ${server.url}`)
console.log(`Rails root        ${railsRoot}`)
