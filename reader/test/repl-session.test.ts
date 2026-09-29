import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"

import { REPL_LOOP, replSession, type ReplSession } from "../src/server/repl-session"
import { applyReplUpdate, TRANSCRIPT_LIMIT, type ReplMessage, type ReplSnapshot } from "../src/shared/repl"
import { stubConsoleRoot, stubConsoleStarts } from "./repl.fixtures"

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
    else if (message.type !== "refused" && snapshot !== null) snapshot = applyReplUpdate(snapshot, message)
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
const isEvaluated = (id: number) => (snapshot: ReplSnapshot) =>
  snapshot.state.kind === "ready" && snapshot.transcript.some((entry) => entry.id === id && entry.kind === "evaluation" && entry.outcome !== null)

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

    expect(busy).toEqual({ kind: "busy", pid: (ready as { pid: number }).pid, id: expect.any(Number), since: expect.any(Number) })
    expect(busy.since).toBeGreaterThanOrEqual(before)
    expect(transcript.at(-1)).toEqual({
      kind: "evaluation",
      id: busy.id,
      input: "1 + 1",
      output: "",
      outputCut: false,
      outcome: { kind: "result", text: "1 + 1", cut: false },
    })
  })

  test("answers an evaluation that raised with its error's class and message", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    const entry = await evaluate(listening, "raise ArgumentError: nope")

    expect(entry).toMatchObject({ outcome: { kind: "error", className: "ArgumentError", message: "nope" } })
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

  test("says the console process exited, and ends a running evaluation without an answer", async () => {
    const { session } = await aSession()
    const listening = listen(session)
    await booted(listening)

    listening.submit("exit 3")
    const snapshot = await listening.until((snapshot) => snapshot.state.kind === "exited")

    expect(snapshot.state).toEqual({ kind: "exited", code: 3 })
    expect(snapshot.transcript.at(-1)).toMatchObject({ input: "exit 3", outcome: { kind: "lost" } })
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
