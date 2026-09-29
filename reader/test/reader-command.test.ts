import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"

import { ALLOWED_HOSTS_VARIABLE, readAllowedHosts } from "../src/server/allowed-hosts"
import { APP_NAME_VARIABLE, readAppNameOverride } from "../src/server/app-name"
import { INITIALIZER_RELATIVE_PATH, MARKER_RELATIVE_PATH } from "../src/server/initializer-file"
import { DEFAULT_PORT, PORT_VARIABLE, readPort } from "../src/server/port"
import { EMPTY_SNAPSHOT, type ReplCommand, type ReplMessage } from "../src/shared/repl"
import type { Envelope } from "../src/shared/wire"
import { stubConsoleHeard, stubConsoleRoot, stubConsoleStarts } from "./repl.fixtures"
import { aRun, appendToSidecar } from "./sidecar.fixtures"

const SERVER = Bun.fileURLToPath(new URL("../src/server/index.ts", import.meta.url))
const LAUNCHER = Bun.fileURLToPath(new URL("../bin/rails-log-reader.ts", import.meta.url))

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
function run(cwd: string, env: Record<string, string> = {}) {
  return spawnReader(SERVER, cwd, env)
}

/** The way the READMEs start it, which is the only way its stylesheet gets compiled. */
function launch(cwd: string, env: Record<string, string> = {}) {
  return spawnReader(LAUNCHER, cwd, env)
}

function spawnReader(entry: string, cwd: string, env: Record<string, string>) {
  const reader = Bun.spawn([Bun.which("bun") ?? "bun", entry], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, [PORT_VARIABLE]: "0", ...env },
  })
  started.push(reader)
  return reader
}

/**
 * Everything a Reader has printed so far, read for as long as it runs. Kept per Reader rather
 * than read afresh, because a stream stops being readable once one reader lets go of it, and
 * the Reader goes on printing after the line that says where it is.
 */
type Transcript = { said: string; grew: Promise<boolean> }

const transcripts = new WeakMap<Bun.Subprocess, Transcript>()

function transcriptOf(reader: Bun.Subprocess) {
  const existing = transcripts.get(reader)
  if (existing !== undefined) return existing

  // `grew` settles each time more arrives, `true`, and once more when stdout closes, `false`.
  let settle = (_more: boolean) => {}
  const pending = () => new Promise<boolean>((resolve) => (settle = resolve))
  const transcript: Transcript = { said: "", grew: pending() }

  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of reader.stdout as ReadableStream<Uint8Array>) {
      transcript.said += decoder.decode(chunk, { stream: true })
      const grown = settle
      transcript.grew = pending()
      grown(true)
    }
    settle(false)
  })()

  transcripts.set(reader, transcript)
  return transcript
}

/** The first match for `pattern` in what the Reader has printed, once it has printed one. */
async function printed(reader: Bun.Subprocess, pattern: RegExp) {
  const transcript = transcriptOf(reader)

  while (true) {
    const found = transcript.said.match(pattern)
    if (found !== null) return found
    if (!(await transcript.grew)) throw new Error(`the Reader never printed ${pattern}, only: ${transcript.said}`)
  }
}

/**
 * Where the Reader says it is, read from the line it prints on the way up. That line is
 * written after the socket is bound, so arriving at it is also how these tests know the
 * Reader is up — there is nothing to poll and no port to have guessed.
 */
async function readerUrl(reader: Bun.Subprocess) {
  return (await printed(reader, /(http:\/\/\S+)/))[1] ?? ""
}

/** `Bun.fetch` rather than the global, which the shell tests replace with happy-dom's. */
async function reachReader(reader: Bun.Subprocess) {
  return await Bun.fetch(await readerUrl(reader))
}

/**
 * The stylesheet a launched Reader serves in production, as `bun start` and the README run
 * it, from a working directory that is not the Reader's own.
 */
async function servedStylesheet() {
  const url = await readerUrl(launch(await railsRoot(), { NODE_ENV: "production" }))
  const page = await (await Bun.fetch(url)).text()

  const link = page.match(/<link[^>]*rel="stylesheet"[^>]*>/)?.[0] ?? ""
  const href = link.match(/href="([^"]+)"/)?.[1]
  expect(href).toBeDefined()
  return await (await Bun.fetch(new URL(href ?? "", url))).text()
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

  test("serves compiled Tailwind when launched from inside a Host app", async () => {
    const stylesheet = await servedStylesheet()

    expect(stylesheet).not.toContain('@import "tailwindcss"')
    expect(stylesheet).toContain("--color-sunken")
    // The Settings dialog's centring, which Preflight's reset would otherwise take away.
    expect(stylesheet).toMatch(/\.m-auto\s*\{\s*margin:\s*auto/)
  })

  test("compiles its stylesheet with the same Tailwind it imports", async () => {
    // The plugin bundles a Tailwind compiler of its own but resolves `@import "tailwindcss"`
    // — Preflight and the default theme — from the installed package, and the stylesheet
    // test compiles with that package too. Different versions mix the two with no error.
    const compiler = (await servedStylesheet()).match(/tailwindcss v(\S+)/)?.[1]
    const installed = (await Bun.file(Bun.resolveSync("tailwindcss/package.json", import.meta.dir)).json()).version

    expect(compiler).toBe(installed)
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

const STALE_INITIALIZER = "# a stale copy of the Initializer\n"

/** A Host app with a copy of the Initializer that has drifted from the master. */
async function staleRoot() {
  const root = await railsRoot()
  await mkdir(join(root, "config", "initializers"), { recursive: true })
  await writeFile(join(root, INITIALIZER_RELATIVE_PATH), STALE_INITIALIZER)
  return root
}

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
    const root = await staleRoot()
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
    const root = await staleRoot()
    const url = await readerUrl(run(root))

    const repaired = await Bun.fetch(new URL("initializer-repair", url), {
      method: "POST",
      headers: { origin: new URL(url).origin },
    })

    expect(await repaired.json()).toEqual({ ok: true })
    expect(await readFile(join(root, INITIALIZER_RELATIVE_PATH))).toEqual(await readFile(MASTER_INITIALIZER))
    // Never the Marker file: creating and removing it stays the developer's own act.
    expect(await Bun.file(join(root, "log", "rails_log_reader.enabled")).exists()).toBe(false)

    const status = await Bun.fetch(new URL("initializer-status", url))
    expect(await status.json()).toEqual(answer({ installed: true, current: true }))
  })
})

/**
 * A request as a browser on some other page would send it: the `Host` it was addressed to and
 * the `Origin` of the page that sent it, either of which may be absent. Sent to the Reader's
 * own socket whatever `Host` says, the way a rebound name arrives.
 */
async function requestAs(
  url: string,
  path: string,
  { host, origin, method = "GET" }: { host?: string; origin?: string; method?: string },
) {
  const headers: Record<string, string> = {}
  if (host !== undefined) headers.host = host
  if (origin !== undefined) headers.origin = origin
  return await Bun.fetch(new URL(path, url), { method, headers })
}

async function repaired(root: string) {
  return (await readFile(join(root, INITIALIZER_RELATIVE_PATH), "utf8")) !== STALE_INITIALIZER
}

describe("who the Reader answers", () => {
  test("listens on 127.0.0.1 alone, and says it is on localhost", async () => {
    const url = await readerUrl(run(await railsRoot()))
    const port = new URL(url).port

    expect(url).toBe(`http://localhost:${port}/`)
    expect((await Bun.fetch(`http://127.0.0.1:${port}/app-name-override`)).status).toBe(200)

    const elsewhere = Object.values(networkInterfaces())
      .flat()
      .filter((address) => address !== undefined && !address.internal && address.family === "IPv4")
      .map((address) => address?.address)
    for (const address of ["[::1]", ...elsewhere]) {
      await expect(Bun.fetch(`http://${address}:${port}/app-name-override`)).rejects.toThrow()
    }
  })

  test("refuses a view and an act addressed to a Host outside the allowlist, and names the Host", async () => {
    const root = await staleRoot()
    const reader = run(root)
    const url = await readerUrl(reader)

    const view = await requestAs(url, "/", { host: "rebound.example:5273" })
    const act = await requestAs(url, "/initializer-repair", {
      method: "POST",
      host: "elsewhere.example",
      origin: "http://elsewhere.example",
    })

    expect(view.status).toBe(403)
    expect(await view.text()).toBe("")
    expect(act.status).toBe(403)
    expect(await act.text()).toBe("")
    expect(await repaired(root)).toBe(false)
    await printed(reader, /refused.*Host rebound\.example:5273/)
    await printed(reader, /refused.*Host elsewhere\.example/)
  })

  test("serves localhost and 127.0.0.1 on any port, so a remapped forward still works", async () => {
    const url = await readerUrl(run(await railsRoot()))

    for (const host of ["localhost:8080", "127.0.0.1:5274", "localhost"]) {
      expect((await requestAs(url, "/", { host })).status).toBe(200)
    }
  })

  test("serves views to a host in RAILS_LOG_READER_ALLOWED_HOSTS, a leading dot's subdomains included, and refuses it acts", async () => {
    const root = await staleRoot()
    const reader = run(root, { [ALLOWED_HOSTS_VARIABLE]: "tunnel.example, .ngrok.example" })
    const url = await readerUrl(reader)

    for (const host of ["tunnel.example", "abc.ngrok.example:443", "ngrok.example"]) {
      expect((await requestAs(url, "/", { host })).status).toBe(200)
      expect((await requestAs(url, "/initializer-status", { host, origin: `http://${host}` })).status).toBe(200)
    }
    expect((await requestAs(url, "/", { host: "other.tunnel.example" })).status).toBe(403)

    // A tunnel serves the page over https and passes it on as http, so the browser's Origin
    // names the scheme the page was loaded on, not the one the Reader was reached on.
    expect((await requestAs(url, "/initializer-status", { host: "tunnel.example", origin: "https://tunnel.example" })).status).toBe(200)
    expect((await requestAs(url, "/initializer-status", { host: "tunnel.example", origin: "https://elsewhere.example" })).status).toBe(403)

    const act = await requestAs(url, "/initializer-repair", {
      method: "POST",
      host: "tunnel.example",
      origin: "http://tunnel.example",
    })
    expect(act.status).toBe(403)
    expect(await repaired(root)).toBe(false)
    await printed(reader, /refused.*Host tunnel\.example/)
  })

  test("repairs the Initializer only for the Reader's own exact Origin", async () => {
    const root = await staleRoot()
    const reader = run(root)
    const url = await readerUrl(reader)
    const host = new URL(url).host

    for (const origin of ["http://attacker.example", "http://localhost:3000", `https://${host}`, "null", undefined]) {
      const refused = await requestAs(url, "/initializer-repair", { method: "POST", host, origin })
      expect(refused.status).toBe(403)
    }
    expect(await repaired(root)).toBe(false)
    await printed(reader, /refused.*Origin http:\/\/localhost:3000/)

    const accepted = await requestAs(url, "/initializer-repair", { method: "POST", host, origin: `http://${host}` })
    expect(accepted.status).toBe(200)
    expect(await repaired(root)).toBe(true)
  })

  test("refuses a GET whose Origin is not its own, and serves one with none", async () => {
    const url = await readerUrl(run(await railsRoot()))
    const host = new URL(url).host

    expect((await requestAs(url, "/initializer-status", { host, origin: "http://localhost:3000" })).status).toBe(403)
    expect((await requestAs(url, "/", { host, origin: "null" })).status).toBe(403)
    expect((await requestAs(url, "/initializer-status", { host })).status).toBe(200)
    expect((await requestAs(url, "/initializer-status", { host, origin: `http://${host}` })).status).toBe(200)
  })

  test("answers anything no route declares only as the page, read with GET or HEAD", async () => {
    const url = await readerUrl(run(await railsRoot()))
    const host = new URL(url).host
    const origin = `http://${host}`

    for (const [method, path] of [["POST", "/nowhere"], ["PUT", "/"], ["DELETE", "/initializer-repair"]] as const) {
      expect((await requestAs(url, path, { method, host, origin })).status).toBe(405)
    }
    expect((await requestAs(url, "/nowhere", { method: "HEAD", host })).status).toBe(200)
  })

  test("opens no socket that no route declares, the development page's own aside", async () => {
    const url = await readerUrl(run(await railsRoot()))
    const host = new URL(url).host

    const upgrade = (path: string) =>
      Bun.fetch(new URL(path, url), {
        headers: {
          host,
          origin: `http://${host}`,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      })

    expect((await upgrade("/nowhere")).status).toBe(404)
    expect((await upgrade("/_bun/hmr")).status).toBe(101)
  })

  test("never says Access-Control-Allow-Origin, whether it serves or refuses", async () => {
    const url = await readerUrl(run(await railsRoot()))
    const host = new URL(url).host

    const routes = ["/", "/earlier?from=0", "/app-name-override", "/initializer-status", "/reader-port", "/nowhere"]
    for (const origin of [undefined, `http://${host}`, "http://attacker.example"]) {
      for (const path of routes) {
        for (const method of ["GET", "OPTIONS"]) {
          const response = await requestAs(url, path, { host, origin, method })
          expect(response.headers.get("access-control-allow-origin")).toBeNull()
          await response.body?.cancel()
        }
      }
      const repair = await requestAs(url, "/initializer-repair", { method: "POST", host: "attacker.example", origin })
      expect(repair.headers.get("access-control-allow-origin")).toBeNull()
    }
  })

  test("tells the page which port it is on, which a tunnelled page cannot read off its own address", async () => {
    const url = await readerUrl(run(await railsRoot()))

    const response = await Bun.fetch(new URL("reader-port", url))

    expect(await response.json()).toEqual({ port: Number(new URL(url).port) })
  })
})

/**
 * The page's side of `/repl`: a WebSocket that is sent every message as it arrives and hands
 * back the first one after a given point that `holds` is true of.
 */
function replSocket(url: string, origin: string) {
  const socket = new WebSocket(url.replace(/^http/, "ws") + "repl", { headers: { origin } })
  const received: ReplMessage[] = []
  let arrived = () => {}
  socket.on("message", (data) => {
    received.push(JSON.parse(String(data)) as ReplMessage)
    arrived()
  })
  const opened = new Promise<void>((resolve, reject) => {
    socket.on("open", resolve)
    socket.on("error", reject)
  })

  return {
    async send(command: ReplCommand) {
      await opened
      socket.send(JSON.stringify(command))
    },
    async next(holds: (message: ReplMessage) => boolean, from = 0) {
      const deadline = Date.now() + 10_000
      while (true) {
        const found = received.slice(from).find(holds)
        if (found !== undefined) return found
        if (Date.now() > deadline) throw new Error(`no such message, only ${JSON.stringify(received)}`)
        await new Promise<void>((resolve) => {
          arrived = resolve
          setTimeout(resolve, 100)
        })
      }
    },
    received,
    close: () => socket.close(),
  }
}

describe("the REPL socket", () => {
  async function aReaderOverTheStubConsole() {
    const root = await stubConsoleRoot()
    temporary.push(root)
    const url = await readerUrl(run(root))
    return { root, url, origin: `http://${new URL(url).host}` }
  }

  test("opens on the session's snapshot, and runs Ruby in the console process end to end", async () => {
    const { url, origin } = await aReaderOverTheStubConsole()
    const repl = replSocket(url, origin)

    expect(await repl.next((message) => message.type === "snapshot")).toEqual({ type: "snapshot", snapshot: EMPTY_SNAPSHOT })

    await repl.send({ type: "boot" })
    await repl.next((message) => message.type === "state" && message.state.kind === "ready")
    await repl.send({ type: "submit", input: "1 + 1" })

    expect(await repl.next((message) => message.type === "finished")).toEqual({
      type: "finished",
      id: expect.any(Number),
      outcome: { kind: "result", text: "1 + 1", cut: false, tree: { type: "object", inspect: "1 + 1" }, inspectError: null },
    })
    repl.close()
  })

  test("shows a tab that opens later the whole Transcript, and refuses its input only to it", async () => {
    const { url, origin } = await aReaderOverTheStubConsole()
    const first = replSocket(url, origin)
    await first.send({ type: "boot" })
    await first.next((message) => message.type === "state" && message.state.kind === "ready")
    await first.send({ type: "submit", input: "sleep 500" })
    await first.next((message) => message.type === "state" && message.state.kind === "busy")

    const second = replSocket(url, origin)
    const snapshot = await second.next((message) => message.type === "snapshot")
    await second.send({ type: "submit", input: "1 + 1" })

    expect(snapshot).toMatchObject({ snapshot: { state: { kind: "busy" }, transcript: [{ kind: "output" }, { input: "sleep 500" }] } })
    expect(await second.next((message) => message.type === "refused")).toEqual({
      type: "refused",
      reason: "Already running. Wait for it to finish.",
      input: "1 + 1",
    })
    await first.next((message) => message.type === "finished")
    await second.next((message) => message.type === "finished")
    expect(first.received.some((message) => message.type === "refused")).toBe(false)
    first.close()
    second.close()
  })

  test("interrupts the running evaluation", async () => {
    const { url, origin } = await aReaderOverTheStubConsole()
    const repl = replSocket(url, origin)
    await repl.send({ type: "boot" })
    await repl.next((message) => message.type === "state" && message.state.kind === "ready")
    await repl.send({ type: "submit", input: "nap 60000" })
    await repl.next((message) => message.type === "output" && message.text === "napping\n")

    await repl.send({ type: "interrupt" })

    expect(await repl.next((message) => message.type === "finished")).toMatchObject({ outcome: { kind: "error", className: "Interrupt" } })
    repl.close()
  })

  test("checks whether an input is complete, answering only the tab that asked", async () => {
    const { url, origin } = await aReaderOverTheStubConsole()
    const repl = replSocket(url, origin)
    const other = replSocket(url, origin)
    await repl.send({ type: "boot" })
    await repl.next((message) => message.type === "state" && message.state.kind === "ready")

    await repl.send({ type: "check", id: 7, text: "[1, 2].each do |x|" })
    await repl.send({ type: "check", id: 8, text: "1 + 1" })

    expect(await repl.next((message) => message.type === "checked" && message.id === 7)).toEqual({ type: "checked", id: 7, complete: false })
    expect(await repl.next((message) => message.type === "checked" && message.id === 8)).toEqual({ type: "checked", id: 8, complete: true })
    expect(other.received.some((message) => message.type === "checked")).toBe(false)
    repl.close()
    other.close()
  })

  test("restarts the console process, sandboxed when asked", async () => {
    const { root, url, origin } = await aReaderOverTheStubConsole()
    const repl = replSocket(url, origin)
    await repl.send({ type: "boot" })
    await repl.next((message) => message.type === "state" && message.state.kind === "ready")
    const from = repl.received.length

    await repl.send({ type: "restart", sandbox: true })
    await repl.next((message) => message.type === "state" && message.state.kind === "ready", from)

    expect((await stubConsoleStarts(root)).at(-1)).toContain("--sandbox")
    repl.close()
  })

  test("closes the console process's stdin and then sends it SIGTERM when the Reader is stopped by a signal", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const { root, url, origin } = await aReaderOverTheStubConsole()
      const reader = started.at(-1)!
      const repl = replSocket(url, origin)
      await repl.send({ type: "boot" })
      await repl.next((message) => message.type === "state" && message.state.kind === "ready")
      await repl.send({ type: "submit", input: "sleep 60000" })
      await repl.next((message) => message.type === "state" && message.state.kind === "busy")

      reader.kill(signal)
      await reader.exited
      const deadline = Date.now() + 2_000
      while ((await stubConsoleHeard(root)).length < 2 && Date.now() < deadline) await Bun.sleep(50)

      expect(await stubConsoleHeard(root)).toEqual(["stdin closed", "SIGTERM"])
    }
  })

  test("refuses the upgrade with a bare 403 for a foreign, other-port, missing or null Origin", async () => {
    const { root, url } = await aReaderOverTheStubConsole()
    const host = new URL(url).host

    for (const origin of ["http://attacker.example", "http://localhost:3000", `https://${host}`, "null", undefined]) {
      const headers: Record<string, string> = {
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      }
      if (origin !== undefined) headers.origin = origin
      const refused = await Bun.fetch(new URL("/repl", url), { headers })

      expect(refused.status).toBe(403)
      expect(await refused.text()).toBe("")
    }
    expect(await stubConsoleStarts(root)).toEqual([])
  })
})

describe("the Host app's display name (#95)", () => {
  test("GET /app-name-override says null when RAILS_LOG_READER_APP_NAME is not set", async () => {
    const url = await readerUrl(run(await railsRoot()))

    const response = await Bun.fetch(new URL("app-name-override", url))

    expect(await response.json()).toEqual({ override: null })
  })

  test("GET /app-name-override answers whatever the env var says, for the life of the process", async () => {
    const url = await readerUrl(run(await railsRoot(), { [APP_NAME_VARIABLE]: "MyApp" }))

    const response = await Bun.fetch(new URL("app-name-override", url))

    expect(await response.json()).toEqual({ override: "MyApp" })
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

/**
 * The same rule as the port's, minus the refusal: any non-empty string names an app, so the
 * only thing left to tell apart is set from unset.
 */
describe("the app-name override", () => {
  test("is null unless RAILS_LOG_READER_APP_NAME is set", () => {
    expect(readAppNameOverride(undefined)).toBeNull()
  })

  test("is whatever the override says", () => {
    expect(readAppNameOverride("MyApp")).toBe("MyApp")
  })

  test("treats an override that is there but empty, or only whitespace, as not having been set", () => {
    expect(readAppNameOverride("")).toBeNull()
    expect(readAppNameOverride("  ")).toBeNull()
  })

  test("trims surrounding whitespace from an override that is otherwise set", () => {
    expect(readAppNameOverride("  MyApp  ")).toBe("MyApp")
  })
})

/** Read once at startup, the way the port and the app name are. */
describe("the allowed-hosts setting", () => {
  test("allows nothing beyond loopback unless RAILS_LOG_READER_ALLOWED_HOSTS is set", () => {
    expect(readAllowedHosts(undefined)).toEqual([])
    expect(readAllowedHosts("  ")).toEqual([])
  })

  test("is a comma-separated list of hostnames, lower-cased and trimmed", () => {
    expect(readAllowedHosts(" Tunnel.Example , .ngrok.example,")).toEqual(["tunnel.example", ".ngrok.example"])
  })

  test("is refused rather than half-read when an entry is not a bare hostname", () => {
    expect(readAllowedHosts("tunnel.example:443")).toBeNull()
    expect(readAllowedHosts("*")).toBeNull()
    expect(readAllowedHosts("https://tunnel.example")).toBeNull()
    expect(readAllowedHosts(".")).toBeNull()
  })
})
