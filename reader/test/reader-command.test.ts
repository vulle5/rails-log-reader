import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Envelope } from "../src/shared/wire"
import { aRun, appendToSidecar } from "./sidecar.fixtures"

const SERVER = Bun.fileURLToPath(new URL("../src/server/index.ts", import.meta.url))
const READER_URL = "http://localhost:5273/"

const started: Bun.Subprocess[] = []
const temporary: string[] = []

afterEach(async () => {
  // Waited for, not just signalled: the next test binds the same fixed port, and a Reader
  // still holding it would leave that test talking to this one's Rails root.
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

function run(cwd: string) {
  const reader = Bun.spawn([Bun.which("bun") ?? "bun", SERVER], { cwd, stdout: "pipe", stderr: "pipe" })
  started.push(reader)
  return reader
}

/**
 * Poll rather than parse startup output: the Reader is up when it answers. `Bun.fetch`
 * rather than the global, which the shell tests replace with happy-dom's.
 */
async function reachReader(reader: Bun.Subprocess) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (reader.exitCode !== null) throw new Error(`the Reader exited with ${reader.exitCode}`)
    try {
      return await Bun.fetch(READER_URL)
    } catch {
      await Bun.sleep(100)
    }
  }
  throw new Error(`the Reader never answered on ${READER_URL}`)
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
  test("serves the Reader on port 5273 when started from a Rails root", async () => {
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
    await reachReader(run(root))
    const response = await Bun.fetch(`${READER_URL}events`)

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
