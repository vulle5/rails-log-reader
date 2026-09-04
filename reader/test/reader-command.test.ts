import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SERVER = Bun.fileURLToPath(new URL("../src/server/index.ts", import.meta.url))
const READER_URL = "http://localhost:5273/"

const started: Bun.Subprocess[] = []
const temporary: string[] = []

afterEach(async () => {
  for (const reader of started.splice(0)) reader.kill()
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
})
