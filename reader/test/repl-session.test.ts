import { afterEach, describe, expect, test } from "bun:test"
import { chmod, rm } from "node:fs/promises"
import { join } from "node:path"

import { REPL_LOOP, replSession, type ReplSession } from "../src/server/repl-session"
import {
  applyReplUpdate,
  evaluationEntry,
  isReplUpdate,
  type EvaluationEntry,
  TRANSCRIPT_LIMIT,
  type ReplMessage,
  type ReplSnapshot,
  type ReplState,
} from "../src/shared/repl"
import {
  stubConsoleCompleted,
  stubConsoleFailsToBoot,
  stubConsoleHeard,
  stubConsoleRoot,
  stubConsoleStarts,
  stubConsoleUncheckable,
  stubConsoleUncompletable,
} from "./repl.fixtures"

/**
 * The server's *REPL* session, driven through its interface over the stub console in
 * `stub-console.ts`, installed as a temporary Rails root's `bin/rails`.
 */

const sessions: ReplSession[] = []
const roots: string[] = []

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function aSession() {
  const root = await stubConsoleRoot()
  roots.push(root)
  const session = replSession(root)
  sessions.push(session)
  return { root, session }
}

/**
 * A listener attached to `session`, holding what it was sent: every message in order, and the
 * snapshot those messages fold into.
 */
function listen(session: ReplSession) {
  const heard: ReplMessage[] = []
  let snapshot: ReplSnapshot | null = null

  const attachment = session.attach((message) => {
    heard.push(message)
    if (message.type === "snapshot") snapshot = message.snapshot
    else if (isReplUpdate(message) && snapshot !== null) snapshot = applyReplUpdate(snapshot, message)
  })

  return {
    ...attachment,
    heard,
    get snapshot(): ReplSnapshot {
      if (snapshot === null) throw new Error("the session sent no snapshot")
      return snapshot
    },
    /** The snapshot, once `holds` is true of it. */
    async until(holds: (snapshot: ReplSnapshot) => boolean) {
      const deadline = Date.now() + 5_000
      while (snapshot === null || !holds(snapshot)) {
        if (Date.now() > deadline) throw new Error(`gave up waiting, at ${JSON.stringify(snapshot)}`)
        await Bun.sleep(10)
      }
      return snapshot
    },
  }
}

type Listening = ReturnType<typeof listen>

const isReady = (snapshot: ReplSnapshot) => snapshot.state.kind === "ready"
const isExited = (snapshot: ReplSnapshot) => snapshot.state.kind === "exited"
const isEvaluated = (id: number) => (snapshot: ReplSnapshot) =>
  snapshot.state.kind === "ready" && snapshot.transcript.some((entry) => entry.id === id && entry.kind === "evaluation" && entry.outcome !== null)

/** The pid of a console process that has said it is ready. */
function pidOf(state: ReplState) {
  if (state.kind !== "ready" && state.kind !== "busy") throw new Error(`the session is ${state.kind}, with no pid`)
  return state.pid
}

async function booted(listening: Listening) {
  listening.boot()
  return await listening.until(isReady)
}

/** Submits `input`, waits for it to finish, and hands back its entry. */
async function evaluate(listening: Listening, input: string) {
  expect(listening.submit(input)).toBeNull()
  const state = listening.snapshot.state
  if (state.kind !== "busy") throw new Error(`submitted, but the session is ${state.kind}`)

  const snapshot = await listening.until(isEvaluated(state.id))
  return snapshot.transcript.find((entry) => entry.id === state.id)
}

describe("the REPL session", () => {
  test("starts no console process for an attachment that does not ask for one", async () => {
    const { root, session } = await aSession()

    const listening = listen(session)
    await Bun.sleep(200)

    expect(listening.snapshot.state).toEqual({ kind: "idle" })
    expect(await stubConsoleStarts(root)).toEqual([])
  })

  test("boots bin/rails console with the eval loop on the first attachment that asks, and says booting, then ready", async () => {
    const { root, session } = await aSession()
    const listening = listen(session)

    const snapshot = await booted(listening)

    expect(await stubConsoleStarts(root)).toEqual([["console", "--", "-f", "-r", REPL_LOOP]])
    const states = listening.heard.flatMap((message) => (message.type === "state" ? [message.state.kind] : []))
    expect(states).toEqual(["booting", "ready"])
    expect(snapshot.state).toEqual({ kind: "ready", pid: expect.any(Number) })
  })

  test("boots one console process however many attachments ask", async () => {
    const { root, session } = await aSession()
    const first = listen(session)
    const second = listen(session)

    first.boot()
    second.boot()
    await second.until(isReady)
    listen(session).boot()

    expect(await stubConsoleStarts(root)).toHaveLength(1)
  })

  test("runs an evaluation: busy from when it is sent, then its result, then ready", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    const { state: ready } = await booted(listening)
    const before = Date.now()

    expect(listening.submit("1 + 1")).toBeNull()
    const busy = listening.snapshot.state
    if (busy.kind !== "busy") throw new Error(`submitted, but the session is ${busy.kind}`)
    const { transcript } = await listening.until(isEvaluated(busy.id))

    expect(busy).toEqual({ kind: "busy", pid: pidOf(ready), id: expect.any(Number), since: expect.any(Number) })
    expect(busy.since).toBeGreaterThanOrEqual(before)
    expect(transcript.at(-1)).toEqual({
      kind: "evaluation",
      id: busy.id,
      input: "1 + 1",
      output: "",
      outputCut: false,
      outcome: { kind: "result", className: "Object", text: "1 + 1", cut: false, tree: { type: "object", inspect: "1 + 1" }, inspectError: null },
    })
  })

  test("answers an evaluation whose inspect raised as a result, noting what inspect raised", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    const entry = await evaluate(listening, "broken")

    expect(entry).toMatchObject({ outcome: { kind: "result", text: "#<Broken>", inspectError: "RuntimeError: nope" } })
  })

  test("answers an evaluation that raised with its error's class, message and backtrace", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    const entry = await evaluate(listening, "raise ArgumentError: nope")

    expect(entry).toMatchObject({
      outcome: { kind: "error", className: "ArgumentError", message: "nope", backtrace: ["(repl):1:in '<main>'"], causes: [] },
    })
  })

  test("answers an error with the causes behind it, each as its class, message and backtrace", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    const entry = await evaluate(listening, "wrap TypeError: top")

    expect(entry).toMatchObject({
      outcome: {
        kind: "error",
        className: "TypeError",
        causes: [{ className: "KeyError", message: "root", backtrace: ["(repl):1:in 'fetch'", "(repl):1:in '<main>'"] }],
      },
    })
  })

  test("keeps what an error says was cut, its backtrace's, a cause's and the causes'", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    const entry = await evaluate(listening, "cutoff TypeError: top")

    expect(entry).toMatchObject({
      outcome: { kind: "error", cut: true, causesCut: true, causes: [{ className: "KeyError", cut: true }] },
    })
  })

  test("leaves an error that was cut nowhere without a cut", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    const entry = await evaluate(listening, "wrap TypeError: top")

    if (entry?.kind !== "evaluation" || entry.outcome?.kind !== "error") throw new Error("the evaluation did not raise")
    expect(entry.outcome).not.toHaveProperty("cut")
    expect(entry.outcome).not.toHaveProperty("causesCut")
    expect(entry.outcome.causes[0]).not.toHaveProperty("cut")
  })

  test("interrupts a running evaluation with SIGINT, which ends it as raising Interrupt", async () => {
    const { root, session } = await aSession()
    const listening = listen(session)
    const { state: ready } = await booted(listening)
    listening.submit("nap 60000")
    const running = listening.snapshot.state
    if (running.kind !== "busy") throw new Error(`submitted, but the session is ${running.kind}`)
    await listening.until(({ transcript }) => transcript.at(-1)?.output === "napping\n")

    listening.interrupt()
    const { state, transcript } = await listening.until(isEvaluated(running.id))

    expect(await stubConsoleHeard(root)).toEqual(["SIGINT"])
    expect(transcript.at(-1)).toMatchObject({ outcome: { kind: "error", className: "Interrupt", message: "" } })
    expect(state).toEqual(ready)
  })

  test("sends no signal when interrupted with nothing running", async () => {
    const { root, session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    listening.interrupt()
    await evaluate(listening, "1 + 1")

    expect(await stubConsoleHeard(root)).toEqual([])
  })

  test("runs one evaluation at a time, refusing a second with a reason and leaving the Transcript alone", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)
    listening.submit("sleep 300")
    const transcript = listening.snapshot.transcript

    const refusal = listening.submit("1 + 1")

    expect(refusal).toBe("Already running. Wait for it to finish.")
    expect(listening.snapshot.transcript).toEqual(transcript)
  })

  test("refuses an input while the console process is still booting", async () => {
    const { session } = await aSession()
    const listening = listen(session)

    listening.boot()

    expect(listening.submit("1 + 1")).toBe("The REPL is still booting.")
  })

  test("credits what an evaluation prints, on either stream, to that evaluation", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    const printed = await evaluate(listening, "puts hello")
    const warned = await evaluate(listening, "warn careful")

    expect(printed).toMatchObject({ output: "hello\n" })
    expect(warned).toMatchObject({ output: "careful\n" })
  })

  test("makes what the console process prints outside any evaluation an entry of its own", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    const { transcript } = await booted(listening)

    expect(transcript).toEqual([{ kind: "output", id: expect.any(Number), output: "Loading development environment (stub)\n", outputCut: false }])

    await evaluate(listening, "later afterwards")
    const snapshot = await listening.until((snapshot) => snapshot.transcript.at(-1)?.kind === "output")

    expect(snapshot.transcript.map((entry) => entry.kind)).toEqual(["output", "evaluation", "output"])
    expect(snapshot.transcript.at(-1)).toMatchObject({ output: "afterwards\n" })
    expect(snapshot.transcript.at(-2)).toMatchObject({ output: "" })
  })

  test("shows a late attachment the whole Transcript and the current state, then its updates", async () => {
    const { session } = await aSession()
    const first = listen(session)
    await booted(first)
    await evaluate(first, "puts hello")
    first.submit("sleep 200")

    const late = listen(session)

    expect(late.heard[0]).toEqual({ type: "snapshot", snapshot: first.snapshot })
    await late.until(isReady)
    expect(late.snapshot).toEqual(first.snapshot)
  })

  test("keeps the latest 100 entries in the Transcript, dropping the oldest first", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    for (let n = 1; n <= TRANSCRIPT_LIMIT; n++) await evaluate(listening, `${n}`)

    const inputs = listening.snapshot.transcript.map((entry) => (entry.kind === "evaluation" ? entry.input : "(output)"))
    expect(TRANSCRIPT_LIMIT).toBe(100)
    expect(inputs).toHaveLength(100)
    expect(inputs[0]).toBe("1")
    expect(inputs.at(-1)).toBe("100")
  })

  test("stops hearing about the session once detached", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    listening.detach()

    listen(session).boot()
    await Bun.sleep(200)

    expect(listening.heard.map((message) => message.type)).toEqual(["snapshot"])
  })
})

describe("the REPL session's console process ending", () => {
  test("says it exited, with its code and what it printed on stderr, and ends a running evaluation without an answer", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)
    await evaluate(listening, "warn about to go")

    listening.submit("exit 3")
    const snapshot = await listening.until(isExited)

    expect(snapshot.state).toEqual({ kind: "exited", code: 3, signal: null, stderr: "about to go\n" })
    expect(snapshot.transcript.at(-1)).toMatchObject({ input: "exit 3", outcome: { kind: "lost" } })
  })

  test("says which signal ended it", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    listening.submit("signal SIGKILL")

    expect((await listening.until(isExited)).state).toMatchObject({ kind: "exited", code: null, signal: "SIGKILL" })
  })

  test("says a failed boot exited, with what it printed on stderr, and never starts it again", async () => {
    const { root, session } = await aSession()
    await stubConsoleFailsToBoot(root, "config/application.rb:1: boom (RuntimeError)\n")
    const listening = listen(session)

    listening.boot()
    const snapshot = await listening.until(isExited)
    await Bun.sleep(300)
    listen(session).boot()
    await Bun.sleep(200)

    expect(snapshot.state).toEqual({ kind: "exited", code: 1, signal: null, stderr: "config/application.rb:1: boom (RuntimeError)\n" })
    expect(listening.snapshot.state.kind).toBe("exited")
    expect(await stubConsoleStarts(root)).toHaveLength(1)
  })

  test("says a console process that could not be started exited, and why", async () => {
    const { root, session } = await aSession()
    await chmod(join(root, "bin", "rails"), 0o644)
    const listening = listen(session)

    listening.boot()

    expect(listening.snapshot.state).toEqual({ kind: "exited", code: null, signal: null, stderr: expect.stringContaining("bin/rails") })
  })

  test("tells every listener it exited, with its pid", async () => {
    const { session } = await aSession()
    const first = listen(session)
    const second = listen(session)
    const pid = pidOf((await booted(first)).state)

    first.submit("exit 3")
    await first.until(isExited)

    for (const listening of [first, second]) expect(listening.heard.filter((message) => message.type === "exit")).toEqual([{ type: "exit", pid }])
  })

  test("closes its stdin, then sends it SIGTERM, when the session closes", async () => {
    const { root, session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    session.close()
    await listening.until(isExited)

    expect(await stubConsoleHeard(root)).toEqual(["stdin closed", "SIGTERM"])
    expect(listening.snapshot.state).toMatchObject({ signal: "SIGTERM" })
  })
})

describe("the REPL session's Restart", () => {
  const isRestarted = (pid: number) => (snapshot: ReplSnapshot) => snapshot.state.kind === "ready" && snapshot.state.pid !== pid

  test("starts a fresh console process and empties the Transcript", async () => {
    const { root, session } = await aSession()
    const listening = listen(session)
    const pid = pidOf((await booted(listening)).state)
    await evaluate(listening, "answer = 42")

    listening.restart(false)
    const snapshot = await listening.until(isRestarted(pid))

    expect(await stubConsoleStarts(root)).toHaveLength(2)
    expect(snapshot.transcript).toEqual([{ kind: "output", id: expect.any(Number), output: "Loading development environment (stub)\n", outputCut: false }])
  })

  test("stops the console process it replaces, which tells every listener it exited and changes nothing else", async () => {
    const { root, session } = await aSession()
    const listening = listen(session)
    const pid = pidOf((await booted(listening)).state)
    listening.submit("sleep 300")

    listening.restart(false)
    await listening.until(isRestarted(pid))
    await Bun.sleep(400)

    expect(listening.heard.filter((message) => message.type === "exit")).toEqual([{ type: "exit", pid }])
    expect(await stubConsoleHeard(root)).toEqual(["stdin closed", "SIGTERM"])
    expect(listening.snapshot.state.kind).toBe("ready")
    expect(listening.snapshot.transcript.map((entry) => entry.kind)).toEqual(["output"])
  })

  test("starts a console process that had exited", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)
    listening.submit("exit 3")
    await listening.until(isExited)

    listening.restart(false)

    expect((await listening.until(isReady)).transcript.map((entry) => entry.kind)).toEqual(["output"])
  })

  test("starts it sandboxed when asked, and holds that choice until a Restart asks otherwise", async () => {
    const { root, session } = await aSession()
    const listening = listen(session)
    const pid = pidOf((await booted(listening)).state)

    listening.restart(true)
    const sandboxed = await listening.until(isRestarted(pid))
    const late = listen(session)
    listening.restart(false)
    await listening.until((snapshot) => isReady(snapshot) && !snapshot.sandbox)

    expect(listening.snapshot.sandbox).toBe(false)
    expect(sandboxed.sandbox).toBe(true)
    expect(late.heard[0]).toMatchObject({ type: "snapshot", snapshot: { sandbox: true } })
    expect(await stubConsoleStarts(root)).toEqual([
      ["console", "--", "-f", "-r", REPL_LOOP],
      ["console", "--sandbox", "--", "-f", "-r", REPL_LOOP],
      ["console", "--", "-f", "-r", REPL_LOOP],
    ])
  })

  test("is not sandboxed before any Restart asks", async () => {
    const { session } = await aSession()

    expect(listen(session).snapshot.sandbox).toBe(false)
  })
})

describe("the REPL session's hold on an evaluation's entry", () => {
  /** The id the eval loop records an evaluation in the Sidecar under, its token its own. */
  const recordedAs = (id: number) => `repl-0a1b2c3d-${id}`
  const isRestarted = (pid: number) => (snapshot: ReplSnapshot) => snapshot.state.kind === "ready" && snapshot.state.pid !== pid

  test("finds an evaluation's entry by its console process's pid and the id it was recorded under", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    const pid = pidOf((await booted(listening)).state)
    const entry = await evaluate(listening, "1 + 1")

    expect(evaluationEntry(listening.snapshot, pid, recordedAs(entry?.id ?? 0))).toEqual({ kind: "held", entry: entry as EvaluationEntry })
  })

  test("finds an evaluation still running", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    const pid = pidOf((await booted(listening)).state)
    listening.submit("sleep 300")
    const busy = listening.snapshot.state
    if (busy.kind !== "busy") throw new Error(`submitted, but the session is ${busy.kind}`)

    expect(evaluationEntry(listening.snapshot, pid, recordedAs(busy.id))).toMatchObject({ kind: "held", entry: { input: "sleep 300", outcome: null } })
  })

  test("says an evaluation a Restart cleared was cleared by a Restart", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    const pid = pidOf((await booted(listening)).state)
    const entry = await evaluate(listening, "1 + 1")

    listening.restart(false)
    await listening.until(isRestarted(pid))

    expect(evaluationEntry(listening.snapshot, pid, recordedAs(entry?.id ?? 0))).toEqual({ kind: "gone", reason: "restarted" })
  })

  test("says an evaluation the Transcript dropped was one of the oldest", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    const pid = pidOf((await booted(listening)).state)
    const first = await evaluate(listening, "first")

    for (let n = 1; n <= TRANSCRIPT_LIMIT; n++) await evaluate(listening, `${n}`)

    expect(evaluationEntry(listening.snapshot, pid, recordedAs(first?.id ?? 0))).toEqual({ kind: "gone", reason: "dropped" })
  })

  test("says an evaluation from a console process it never started is from a console this Reader didn't run", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    const pid = pidOf((await booted(listening)).state)
    const entry = await evaluate(listening, "1 + 1")

    expect(evaluationEntry(listening.snapshot, pid + 1, recordedAs(entry?.id ?? 0))).toEqual({ kind: "gone", reason: "elsewhere" })
    expect(evaluationEntry(listening.snapshot, null, recordedAs(entry?.id ?? 0))).toEqual({ kind: "gone", reason: "elsewhere" })
  })

  test("shows a late attachment the console processes it has started", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    const pid = pidOf((await booted(listening)).state)
    const entry = await evaluate(listening, "1 + 1")
    listening.restart(false)
    await listening.until(isRestarted(pid))

    const late = listen(session)

    expect(evaluationEntry(late.snapshot, pid, recordedAs(entry?.id ?? 0))).toEqual({ kind: "gone", reason: "restarted" })
  })
})

describe("the REPL session's multi-line check", () => {
  test("says the console process has it once it is ready", async () => {
    const { session } = await aSession()

    expect((await booted(listen(session))).capabilities).toEqual(["check", "complete"])
  })

  test("checks a complete input as complete, and one with an open block as incomplete", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    expect(await listening.check("1 + 1")).toBe(true)
    expect(await listening.check("[1, 2].each do |x|")).toBe(false)
    expect(await listening.check("[1, 2].each do |x|\n  x\nend")).toBe(true)
  })

  test("checks while an evaluation runs", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    listening.submit("sleep 500")

    expect(await listening.check("def greet")).toBe(false)
    expect(listening.snapshot.state.kind).toBe("busy")
  })

  test("checks every input as complete when the console process has no check", async () => {
    const { root, session } = await aSession()
    await stubConsoleUncheckable(root)
    const listening = listen(session)

    expect((await booted(listening)).capabilities).toEqual(["complete"])
    expect(await listening.check("[1, 2].each do |x|")).toBe(true)
  })

  test("checks every input as complete before the console process is ready, and once it has exited", async () => {
    const { session } = await aSession()
    const listening = listen(session)

    expect(await listening.check("def greet")).toBe(true)
    await booted(listening)
    listening.submit("exit 0")
    await listening.until(isExited)

    expect(await listening.check("def greet")).toBe(true)
  })
})

describe("the REPL session's completion", () => {
  test("says the console process has it once it is ready", async () => {
    const { session } = await aSession()

    expect((await booted(listen(session))).capabilities).toContain("complete")
  })

  test("completes the word before the caret, with where it starts, the receiver's name and each candidate's kind", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    expect(await listening.complete('"abc".up', 8)).toEqual({
      kind: "candidates",
      from: 6,
      receiver: "String",
      candidates: [
        { text: "upcase", kind: "method" },
        { text: "upcase!", kind: "method" },
      ],
    })
    expect(await listening.complete("upl", 3)).toEqual({ kind: "candidates", from: 0, receiver: null, candidates: [{ text: "upload", kind: "local" }] })
  })

  test("says why nothing completes, in the console process's words", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    expect(await listening.complete("zzz", 3)).toEqual({ kind: "none", reason: "Nothing completes “zzz”." })
  })

  test("answers each completion its own, though they are asked together", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    const [first, second] = await Promise.all([listening.complete("x.up", 4), listening.complete("x.do", 4)])

    expect(first.kind === "candidates" && first.candidates.map((each) => each.text)).toEqual(["upcase", "upcase!"])
    expect(second.kind === "candidates" && second.candidates.map((each) => each.text)).toEqual(["downcase"])
  })

  test("does not ask the console process while an evaluation runs, and says it waits", async () => {
    const { root, session } = await aSession()
    const listening = listen(session)
    await booted(listening)
    listening.submit("sleep 500")

    expect(await listening.complete("1.ab", 4)).toEqual({ kind: "none", reason: "Completion waits for the running evaluation to finish." })
    expect(await stubConsoleCompleted(root)).toEqual([])
    expect(listening.snapshot.state.kind).toBe("busy")
  })

  test("does not ask a console process that has no completion, and says so", async () => {
    const { root, session } = await aSession()
    await stubConsoleUncompletable(root)
    const listening = listen(session)

    expect((await booted(listening)).capabilities).toEqual(["check"])
    expect(await listening.complete("1.ab", 4)).toEqual({ kind: "none", reason: "Completion isn't available." })
    expect(await stubConsoleCompleted(root)).toEqual([])
  })

  test("says why before the console process is ready, and once it has exited", async () => {
    const { session } = await aSession()
    const listening = listen(session)

    expect(await listening.complete("1.ab", 4)).toEqual({ kind: "none", reason: "The REPL hasn't started." })
    await booted(listening)
    listening.submit("exit 0")
    await listening.until(isExited)

    expect(await listening.complete("1.ab", 4)).toEqual({ kind: "none", reason: "The REPL has exited." })
  })

  test("gives up on a completion the console process ended before it answered", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    const hanging = listening.complete("hang", 4)
    listening.submit("exit 0")

    expect(await hanging).toEqual({ kind: "none", reason: "The REPL has exited." })
  })
})
