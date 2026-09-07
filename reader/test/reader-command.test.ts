import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

/** The first SSE message the Reader sends, decoded back into the envelopes it carries. */
async function firstEnvelopes(response: Response) {
  const stream = response.body?.getReader()
  if (stream === undefined) throw new Error("the Reader answered /events with no body")

  const decoder = new TextDecoder()
  let received = ""

  try {
    while (true) {
      const data = received.indexOf("data: ")
      const end = data === -1 ? -1 : received.indexOf("\n", data)
      if (end !== -1) return JSON.parse(received.slice(data + "data: ".length, end)) as Envelope[]

      const { value, done } = await stream.read()
      if (done) throw new Error("the stream ended before an envelope arrived")
      received += decoder.decode(value, { stream: true })
    }
  } finally {
    await stream.cancel()
  }
}

describe("starting the Reader", () => {
  test("serves the Reader when started from a Rails root", async () => {
    const response = await reachReader(run(await railsRoot()))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(await response.text()).toContain('<div id="root">')
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
    expect((await firstEnvelopes(response)).map((envelope) => envelope.type)).toEqual([
      "run_header",
      "request_start",
    ])
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
