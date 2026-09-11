import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { INITIALIZER_RELATIVE_PATH, MARKER_RELATIVE_PATH } from "../src/server/initializer-file"
import { DEFAULT_PORT, PORT_VARIABLE, readPort } from "../src/server/port"
import type { Envelope } from "../src/shared/wire"
import { aRun, appendToSidecar } from "./sidecar.fixtures"

const SERVER = Bun.fileURLToPath(new URL("../src/server/index.ts", import.meta.url))

const started: Bun.Subprocess[] = []
const temporary: string[] = []

afterEach(async () => {
  // Waited for, not just signalled: a Reader is a watcher on a temp directory this hook is
  // about to delete, and one still following it would spend its last moments on ENOENT.
  for (const reader of started.splice(0)) {
    reader.kill()
    await reader.exited
  }
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function emptyDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "reader-command-"))
  temporary.push(directory)
  return directory
}

/** The one file that unambiguously marks a Rails root. */
async function railsRoot() {
  const root = await emptyDirectory()
  await mkdir(join(root, "config"), { recursive: true })
  await writeFile(join(root, "config", "application.rb"), "module ExampleApp\nend\n")
  await mkdir(join(root, "log"), { recursive: true })
  return root
}

/**
 * Every Reader here starts on port `0` — an ephemeral one the OS hands out — so that a
 * Reader a developer left running against their own app can never be the reason this suite
 * fails, and so that two of these tests overlapping could never talk to each other's Rails
 * root. Which port 0 became is a thing only the process knows, and `readerUrl` is how it
 * says so. That the *default* is 5273 is asserted where it lives, next door.
 */
function run(cwd: string) {
  const reader = Bun.spawn([Bun.which("bun") ?? "bun", SERVER], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, [PORT_VARIABLE]: "0" },
  })
  started.push(reader)
  return reader
}

/**
 * Where the Reader says it is, read from the line it prints on the way up. That line is
 * written after the socket is bound, so arriving at it is also how these tests know the
 * Reader is up — there is nothing to poll and no port to have guessed.
 */
async function readerUrl(reader: Bun.Subprocess) {
  const stream = reader.stdout as ReadableStream<Uint8Array>
  const decoder = new TextDecoder()
  let said = ""

  for await (const chunk of stream) {
    said += decoder.decode(chunk, { stream: true })

    const announced = said.match(/(http:\/\/\S+)/)
    if (announced?.[1] !== undefined) return announced[1]
  }

  throw new Error(`the Reader never said where it was, only: ${said}`)
}

/** `Bun.fetch` rather than the global, which the shell tests replace with happy-dom's. */
async function reachReader(reader: Bun.Subprocess) {
  return await Bun.fetch(await readerUrl(reader))
}

type MessageKind = "envelopes" | "history" | "loaded"

/**
 * Every SSE message up to and including the first of a given kind, decoded, in the order
 * they were sent. The stream carries three: the envelopes themselves, which have no `event:`
 * line; `history`, which says where the load-on-open history the Reader attached on begins;
 * and `loaded`, which says that history has all been sent — so a reader of this stream has
 * to tell them apart rather than take the first `data:` it sees.
 */
async function messagesThrough(response: Response, kind: MessageKind) {
  const stream = response.body?.getReader()
  if (stream === undefined) throw new Error("the Reader answered /events with no body")

  const decoder = new TextDecoder()
  const seen: { kind: string; data: unknown }[] = []
  let received = ""

  try {
    while (true) {
      const messages = received.split("\n\n")
      // The last is whatever has arrived of the next message, which may be nothing at all.
      received = messages.pop() ?? ""

      for (const message of messages) {
        const named = /^event: (\S+)$/m.exec(message)?.[1] ?? "envelopes"
        const data = /^data: (.*)$/m.exec(message)?.[1]
        if (data === undefined) continue

        seen.push({ kind: named, data: JSON.parse(data) })
        if (named === kind) return seen
      }

      const { value, done } = await stream.read()
      if (done) throw new Error(`the stream ended before a ${kind} message arrived`)
      received += decoder.decode(value, { stream: true })
    }
  } finally {
    await stream.cancel()
  }
}

async function firstMessage<T>(response: Response, kind: MessageKind) {
  return (await messagesThrough(response, kind)).at(-1)?.data as T
}

describe("starting the Reader", () => {
  test("serves the Reader when started from a Rails root", async () => {
    const response = await reachReader(run(await railsRoot()))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(await response.text()).toContain('<div id="root">')
  })

  test("serves a page that sets its theme before its stylesheet applies", async () => {
    const page = await (await reachReader(run(await railsRoot()))).text()

    // Bun bundles `index.html` on the way out, so the page it serves is the one that has to
    // keep the order: an inline script that runs after the stylesheet has painted is the
    // white flash it exists to prevent.
    const theme = page.indexOf("dataset.theme")
    expect(theme).toBeGreaterThan(-1)
    expect(theme).toBeLessThan(page.indexOf('rel="stylesheet"'))
  })

  test("finds the Rails root from a directory inside the app", async () => {
    const root = await railsRoot()
    await mkdir(join(root, "app", "models"), { recursive: true })

    const response = await reachReader(run(join(root, "app", "models")))

    expect(response.status).toBe(200)
  })

  test("says so plainly, and serves nothing, when it is not a Rails root", async () => {
    const reader = run(await emptyDirectory())

    const exitCode = await reader.exited
    const said = await new Response(reader.stderr).text()

    expect(exitCode).not.toBe(0)
    expect(said).toContain("not a Rails root")
    expect(said).toContain("config/application.rb")
    expect(said.trim().split("\n").length).toBeLessThanOrEqual(3) // a plain sentence, never a stack trace
  })

  test("streams the Sidecar's envelopes to the browser as they are appended", async () => {
    const root = await railsRoot()
    const url = await readerUrl(run(root))
    const response = await Bun.fetch(new URL("events", url))

    // Written only once the browser is attached, so what arrives is the file being
    // followed rather than the history it opened on.
    const rails = aRun("srv-1")
    await appendToSidecar(join(root, "log"), rails.header(), rails.start("req-1", "GET", "/posts/12"))

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect((await firstMessage<Envelope[]>(response, "envelopes")).map((envelope) => envelope.type)).toEqual([
      "run_header",
      "request_start",
    ])
  })

  test("tells the browser where the history it attached on begins, so load-earlier can go on from there", async () => {
    const root = await railsRoot()
    const rails = aRun("srv-1")
    await appendToSidecar(join(root, "log"), rails.header(), rails.start("req-1"))
    const url = await readerUrl(run(root))

    const response = await Bun.fetch(new URL("events", url))

    // The whole file fits inside the load-on-open figure, so the history opens at its top —
    // and a cursor of 0 is the Reader saying there is nothing earlier to ask it for.
    expect(await firstMessage<{ from: number }>(response, "history")).toEqual({ from: 0 })
  })

  test("says when the history it attached on has all been sent, and only after sending it", async () => {
    const root = await railsRoot()
    const rails = aRun("srv-1")
    await appendToSidecar(join(root, "log"), rails.header(), rails.start("req-1"), rails.log("req-1"))
    const url = await readerUrl(run(root))

    const sent = await messagesThrough(await Bun.fetch(new URL("events", url)), "loaded")

    // What lets the browser tell "nothing has happened yet" from "has not arrived yet": every
    // envelope of the history is already in hand by the time this is.
    const envelopes = sent.filter((message) => message.kind === "envelopes").flatMap((message) => message.data as Envelope[])
    expect(envelopes.map((envelope) => envelope.type)).toEqual(["run_header", "request_start", "app_log"])
    expect(sent.at(-1)?.kind).toBe("loaded")
  })

  test("says the history has all been sent when there is no Sidecar at all", async () => {
    const url = await readerUrl(run(await railsRoot()))

    const sent = await messagesThrough(await Bun.fetch(new URL("events", url)), "loaded")

    expect(sent.map((message) => message.kind)).toEqual(["loaded"])
  })

  test("GET /earlier answers the load-earlier control from wherever it is asked to scan", async () => {
    const root = await railsRoot()
    const rails = aRun("srv-1")
    await appendToSidecar(join(root, "log"), rails.header(), rails.start("req-1"))
    const url = await readerUrl(run(root))

    const answered = await Bun.fetch(new URL("earlier?from=0", url))

    // Asked from the top of the file, which is where this one's history already begins:
    // nothing earlier, and the same offset back, rather than the file over again.
    expect(await answered.json()).toEqual({ envelopes: [], from: 0 })
  })

  test("refuses a load-earlier cursor that is not an offset into the Sidecar", async () => {
    const url = await readerUrl(run(await railsRoot()))

    const answered = await Bun.fetch(new URL("earlier?from=halfway", url))

    expect(answered.status).toBe(400)
  })
})

/** The Reader's own master copy, read the same way `initializerFileStatus` reads it. */
const MASTER_INITIALIZER = join(import.meta.dir, "..", "rails", "rails_log_reader.rb")

/** What `GET /initializer-status` answers, with the Marker file absent unless a test says otherwise. */
function answer(said: { installed: boolean; current: boolean; enabled?: boolean }) {
  return { enabled: false, masterPath: MASTER_INITIALIZER, ...said }
}

describe("the Initializer's version-mismatch surface (#29)", () => {
  test("GET /initializer-status says not installed when the Work app has no copy at all", async () => {
    const url = await readerUrl(run(await railsRoot()))
    const response = await Bun.fetch(new URL("initializer-status", url))

    expect(await response.json()).toEqual(answer({ installed: false, current: false }))
  })

  test("GET /initializer-status says current once the copy matches the Reader's own master", async () => {
    const root = await railsRoot()
    await mkdir(join(root, "config", "initializers"), { recursive: true })
    await writeFile(join(root, INITIALIZER_RELATIVE_PATH), await readFile(MASTER_INITIALIZER))
    const url = await readerUrl(run(root))

    const response = await Bun.fetch(new URL("initializer-status", url))

    expect(await response.json()).toEqual(answer({ installed: true, current: true }))
  })

  test("GET /initializer-status says not current when the copy has drifted", async () => {
    const root = await railsRoot()
    await mkdir(join(root, "config", "initializers"), { recursive: true })
    await writeFile(join(root, INITIALIZER_RELATIVE_PATH), "# a stale copy of the Initializer\n")
    const url = await readerUrl(run(root))

    const response = await Bun.fetch(new URL("initializer-status", url))

    expect(await response.json()).toEqual(answer({ installed: true, current: false }))
  })

  test("GET /initializer-status says enabled once the Marker file exists (#28)", async () => {
    const root = await railsRoot()
    await writeFile(join(root, MARKER_RELATIVE_PATH), "")
    const url = await readerUrl(run(root))

    const response = await Bun.fetch(new URL("initializer-status", url))

    expect(await response.json()).toEqual(answer({ installed: false, current: false, enabled: true }))
  })

  test("POST /initializer-repair overwrites the copy in place and touches nothing else", async () => {
    const root = await railsRoot()
    await mkdir(join(root, "config", "initializers"), { recursive: true })
    await writeFile(join(root, INITIALIZER_RELATIVE_PATH), "# a stale copy of the Initializer\n")
    const url = await readerUrl(run(root))

    const repaired = await Bun.fetch(new URL("initializer-repair", url), { method: "POST" })

    expect(await repaired.json()).toEqual({ ok: true })
    expect(await readFile(join(root, INITIALIZER_RELATIVE_PATH))).toEqual(await readFile(MASTER_INITIALIZER))
    // Never the Marker file: creating and removing it stays the developer's own act.
    expect(await Bun.file(join(root, "log", "rails_log_reader.enabled")).exists()).toBe(false)

    const status = await Bun.fetch(new URL("initializer-status", url))
    expect(await status.json()).toEqual(answer({ installed: true, current: true }))
  })
})

/**
 * The port is a rule rather than a number — a default, an override, and a refusal — and the
 * rule is read here rather than by starting a Reader, because a test that binds 5273 to
 * prove 5273 is the default is a test that fails whenever the Reader it is about is running.
 * That is the bug this file had.
 */
describe("which port the Reader is on", () => {
  test("is 5273 unless it is told otherwise", () => {
    expect(readPort(undefined)).toBe(DEFAULT_PORT)
    expect(DEFAULT_PORT).toBe(5273)
  })

  test("is whatever the override asks for, an ephemeral one included", () => {
    expect(readPort("9999")).toBe(9999)
    // What every test above starts a Reader with, and the reason none of them collide.
    expect(readPort("0")).toBe(0)
  })

  test("is refused rather than fallen back from when the override is not a port", () => {
    // Silently serving on 5273 instead would send a developer to the wrong tab and let them
    // conclude the Reader was broken.
    expect(readPort("808O")).toBeNull()
    expect(readPort("70000")).toBeNull()
    expect(readPort("-1")).toBeNull()
    expect(readPort("5273.5")).toBeNull()
  })

  test("treats an override that is there but empty as not having been set", () => {
    // `RAILS_LOG_READER_PORT= bun ...`, and a shell that exports it as the empty string.
    expect(readPort("")).toBe(DEFAULT_PORT)
    expect(readPort("  ")).toBe(DEFAULT_PORT)
  })
})
