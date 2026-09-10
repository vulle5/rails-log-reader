import { join } from "node:path"

import index from "../ui/index.html"
import { initializerFileStatus, repairInitializerFile } from "./initializer-file"
import { PORT_VARIABLE, readPort } from "./port"
import { RAILS_ROOT_MARKER, findRailsRoot } from "./rails-root"
import { openSidecar, readEarlier, type Sidecar } from "./sidecar"

const detectedRailsRoot = findRailsRoot(process.cwd())

if (detectedRailsRoot === null) {
  console.error(
    `rails-log-reader: ${process.cwd()} is not a Rails root.\n` +
      `No ${RAILS_ROOT_MARKER} was found here or in any parent directory. ` +
      `Start the Reader from inside your Rails app.`,
  )
  process.exit(1)
}

// Narrowed into its own binding, straight-line, rather than trusted to stay narrowed inside
// `initializerStatus` and `repairInitializer` below: both are closures TypeScript type-checks
// independently of the control flow above, so the union type would otherwise survive into them.
const railsRoot: string = detectedRailsRoot

const port = readPort(process.env[PORT_VARIABLE])

if (port === null) {
  console.error(
    `rails-log-reader: ${PORT_VARIABLE} is set to "${process.env[PORT_VARIABLE]}", which is not a port number.`,
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
      function send(message: string) {
        try {
          controller.enqueue(message)
        } catch {
          // The browser went away between one append and the next. Let go of the Sidecar
          // here rather than waiting for a `cancel` that an errored stream may never send:
          // a watcher and a 1 Hz timer left behind would follow the file forever.
          attached?.close()
        }
      }

      // An SSE comment, sent before anything is read. The response headers do not leave the
      // server until the body produces its first bytes, and a Reader watching a Rails app
      // that has not booted yet has nothing to say for as long as that takes — so without
      // this the browser cannot tell "attached, and quiet" from "not attached".
      controller.enqueue(": attached\n\n")

      attached = await openSidecar(
        logDirectory,
        (batch) => send(`data: ${JSON.stringify(batch)}\n\n`),
        // Where the window this attachment opened on begins — an event of its own, because
        // it is not envelopes and because it is sent again whenever the window moves under a
        // truncation. The browser holds it and hands it back to `GET /earlier`: the cursor
        // belongs to the side that holds the model, so a reconnection cannot forget how far
        // back the developer had asked to see.
        (from) => send(`event: window\ndata: ${JSON.stringify({ from })}\n\n`),
      )
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

/**
 * The *load-earlier* control: the block of envelopes immediately before the window the
 * browser holds, read by continuing the same backward scan ADR-0003's load-on-open is. A
 * `GET` because it only ever reads, and stateless because the offset comes in with the
 * request — the server is the Sidecar and nothing else, and holds no window of its own.
 */
async function earlier(request: Request) {
  const from = Number(new URL(request.url).searchParams.get("from"))

  if (!Number.isSafeInteger(from) || from < 0) {
    return Response.json({ error: "from must be a byte offset into the Sidecar" }, { status: 400 })
  }

  return Response.json(await readEarlier(logDirectory, from))
}

/**
 * #29: is the Work app's copy of the Initializer the Reader's own master copy, byte for
 * byte? A GET because it only ever reads — the two fixed-contract paths ADR-0004 relies on
 * are read here exactly as they are for the Marker file check that never made it into this
 * file at all, because the Reader only ever reads the Work app's files outside this one
 * repair action.
 */
async function initializerStatus() {
  return Response.json(await initializerFileStatus(railsRoot))
}

/**
 * #29's one write: overwrite `config/initializers/rails_log_reader.rb` with the Reader's
 * master copy, and nothing else. Never the Marker file, never any other path in the Work
 * app — creating and removing the Marker stays the developer's own act. The Reader cannot
 * restart Rails, so the client is left to prompt for one and confirm it by the arrival of a
 * new `run_id` on the Sidecar it is already watching.
 */
async function repairInitializer() {
  try {
    await repairInitializerFile(railsRoot)
    return Response.json({ ok: true })
  } catch (problem) {
    return Response.json({ ok: false, error: String(problem) }, { status: 500 })
  }
}

const server = serveOrSaySo(port)

// The port it actually bound, which with an ephemeral one is the only place that is written
// down. Printed before anything else, because it is the line a developer came for.
console.log(`Rails log reader  ${server.url}`)
console.log(`Rails root        ${railsRoot}`)

/**
 * A port already in use is the ordinary consequence of a fixed one — a second Rails app, or
 * a Reader still running in a tab that was closed — so it gets the plain sentence the
 * missing-Rails-root case gets, and names the way out. Anything else that stops the server
 * binding is genuinely unexpected and keeps its stack trace.
 */
function serveOrSaySo(port: number) {
  try {
    return Bun.serve({
      port,
      routes: {
        "/events": envelopeStream,
        "/earlier": { GET: earlier },
        "/initializer-status": { GET: initializerStatus },
        "/initializer-repair": { POST: repairInitializer },
        "/*": index,
      },
      development: process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
    })
  } catch (problem) {
    if ((problem as { code?: string }).code !== "EADDRINUSE") throw problem

    console.error(
      `rails-log-reader: port ${port} is already in use.\n` +
        `Another Reader is probably still running. Stop it, or start this one with ` +
        `${PORT_VARIABLE} set to a different port.`,
    )
    process.exit(1)
  }
}
