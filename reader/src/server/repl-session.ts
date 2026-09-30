import { connect, type Socket } from "node:net"
import { join } from "node:path"

import {
  applyReplUpdate,
  completeRefusal,
  EMPTY_SNAPSHOT,
  OUTPUT_LIMIT,
  submitRefusal,
  type Candidate,
  type Completion,
  type Outcome,
  type ReplMessage,
  type ReplSnapshot,
  type ReplState,
  type ReplUpdate,
  type RubyError,
  type RubyNode,
} from "../shared/repl"

/** The eval loop the console process runs, beside the Initializer's master copy. Never copied into the Host app. */
export const REPL_LOOP = Bun.fileURLToPath(new URL("../../rails/repl.rb", import.meta.url))

export type ReplListener = (message: ReplMessage) => void

/** One listener's hold on the session. */
export type ReplAttachment = {
  /** Starts the console process, unless one has already been started. */
  boot: () => void
  /** Runs `input`, or says why it will not: `null` when it was sent. */
  submit: (input: string) => string | null
  /**
   * Whether `text` is a whole input, rather than one that needs more lines, such as an open
   * `do`. Always true when the console process has no multi-line check, or is not running.
   */
  check: (text: string) => Promise<boolean>
  /**
   * What the word ending at `caret` in `text`, counted in UTF-16 code units, could be. Never asked of
   * the console process while an evaluation runs, or when it has no completion: `none`, with why,
   * answers then, and once the console process is not running.
   */
  complete: (text: string, caret: number) => Promise<Completion>
  /** Interrupts the running evaluation, as Ctrl-C does, which ends it as raising `Interrupt`. Nothing when none is running. */
  interrupt: () => void
  /**
   * Stops the console process, if one is running, and starts a fresh one, sandboxed when
   * `sandbox`, with an empty Transcript.
   */
  restart: (sandbox: boolean) => void
  detach: () => void
}

export type ReplSession = {
  /** `listener` is sent the session's snapshot at once, then every update after it. */
  attach: (listener: ReplListener) => ReplAttachment
  /** Stops the console process, if one is running: closes its stdin, then sends it SIGTERM. */
  close: () => void
}

/** An error's own fields in an `error` frame, as a cause carries them. */
type ErrorFrame = { class: string; message: string; backtrace: string[]; cut?: true }

/** A frame the eval loop sends on fd 3. */
type Frame =
  | { type: "ready"; pid: number; capabilities: string[] }
  | { type: "result"; id: number; text: string; cut: boolean; tree: RubyNode; inspect_error?: string }
  | (ErrorFrame & { type: "error"; id: number; causes: ErrorFrame[]; causes_cut?: true })
  | { type: "checked"; id: number; complete: boolean }
  | { type: "completions"; id: number; from?: number; receiver?: string | null; candidates?: Candidate[]; reason?: string }

/** How long a stopped console process has to end on SIGTERM before it is sent SIGKILL. */
const STOP_GRACE_MS = 5_000

/**
 * How long an exit waits for fds 1 and 2 to be read to their end, which a process the console
 * started and left running can hold open.
 */
const PRINTED_GRACE_MS = 1_000

/** One start of `bin/rails console`. */
type ConsoleProcess = {
  child: Bun.Subprocess<"pipe", "pipe", "pipe">
  frames: Socket
  /** The latest of what it has printed on fd 2, at most `OUTPUT_LIMIT` characters. */
  stderr: string
  /** The SIGKILL that follows a SIGTERM it has not yet ended on. */
  forced?: ReturnType<typeof setTimeout>
  /** Its unanswered checks, by id, each resolved with whether the text is complete. */
  checks: Map<number, (complete: boolean) => void>
  /** Its unanswered completions, by id, each resolved with what they came to. */
  completions: Map<number, (completion: Completion) => void>
}

/**
 * The *REPL*'s one console process, `bin/rails console` running the eval loop from
 * `railsRoot`, shared by every listener for as long as the Reader runs. Nothing starts it until
 * an attachment asks, so a Reader only used for reading logs never starts one, and nothing but
 * a Restart starts it again once it has exited.
 *
 * It runs in the Reader's own environment. Frames travel on fd 3, a socket. What the console
 * process prints on fds 1 and 2 is credited to the running evaluation, or becomes an output
 * entry of its own when none is running.
 *
 * A Restart stops the console process with SIGTERM, and SIGKILL if that has not ended it, then
 * starts the next without waiting. From then on the one it replaced is heard from only once: the
 * exit notice every listener is sent when a console process ends.
 *
 * A frame is acted on a macrotask after it arrives. What an evaluation printed was written
 * before its answer, but the two travel on different fds and the answer can be read first;
 * the wait lets the output that is already there be read and credited to it.
 */
export function replSession(railsRoot: string): ReplSession {
  let snapshot: ReplSnapshot = EMPTY_SNAPSHOT
  const listeners = new Set<ReplListener>()
  let running: ConsoleProcess | null = null
  let nextId = 1
  let nextCheck = 1
  let nextCompletion = 1

  function send(message: ReplMessage) {
    for (const listener of listeners) listener(message)
  }

  function publish(update: ReplUpdate) {
    snapshot = applyReplUpdate(snapshot, update)
    send(update)
  }

  function become(state: ReplState, capabilities = snapshot.capabilities) {
    publish({ type: "state", state, capabilities })
  }

  function boot() {
    if (snapshot.state.kind === "idle") start()
  }

  function restart(sandbox: boolean) {
    if (running !== null) stop(running)
    running = null
    publish({ type: "restarted", sandbox })
    start()
  }

  function start() {
    become({ kind: "booting" }, [])

    let child: ConsoleProcess["child"]
    try {
      const sandbox = snapshot.sandbox ? ["--sandbox"] : []
      child = Bun.spawn([join(railsRoot, "bin", "rails"), "console", ...sandbox, "--", "-f", "-r", REPL_LOOP], {
        cwd: railsRoot,
        stdio: ["pipe", "pipe", "pipe", "socket-fd"],
      })
    } catch (problem) {
      become({ kind: "exited", code: null, signal: null, stderr: String(problem) })
      return
    }

    const frames = connect({ fd: child.stdio[3] } as never)
    const started: ConsoleProcess = { child, frames, stderr: "", checks: new Map(), completions: new Map() }
    running = started

    frames.setEncoding("utf8")
    frames.on("error", () => {
      // The console process went away mid-frame. Its exit says so.
    })
    readLines(frames, (line) => {
      const frame = parsedFrame(line)
      if (frame?.type === "checked") started.checks.get(frame.id)?.(frame.complete)
      else if (frame?.type === "completions") started.completions.get(frame.id)?.(completionOf(frame))
      else if (frame !== null) setTimeout(() => running === started && answered(frame))
    })
    const printed = Promise.all([readText(child.stdout, (text) => printedBy(started, text)), readText(child.stderr, (text) => warnedBy(started, text))])
    void child.exited.then(async () => {
      await Promise.race([printed, Bun.sleep(PRINTED_GRACE_MS)])
      exited(started)
    })
  }

  /** Closes the console process's stdin, then sends it SIGTERM, and SIGKILL if that has not ended it in time. */
  function stop(stopping: ConsoleProcess) {
    void stopping.child.stdin.end()
    stopping.child.kill("SIGTERM")
    stopping.forced = setTimeout(() => stopping.child.kill("SIGKILL"), STOP_GRACE_MS)
    stopping.forced.unref()
  }

  function answered(frame: Exclude<Frame, { type: "checked" | "completions" }>) {
    const state = snapshot.state

    if (frame.type === "ready") {
      become({ kind: "ready", pid: frame.pid }, frame.capabilities)
      return
    }
    if (state.kind !== "busy" || state.id !== frame.id) return

    const outcome: Outcome =
      frame.type === "result"
        ? { kind: "result", text: frame.text, cut: frame.cut, tree: frame.tree, inspectError: frame.inspect_error ?? null }
        : {
            kind: "error",
            ...rubyError(frame),
            causes: frame.causes.map(rubyError),
            ...(frame.causes_cut && { causesCut: true as const }),
          }
    publish({ type: "finished", id: frame.id, outcome })
    become({ kind: "ready", pid: state.pid })
  }

  function exited(ended: ConsoleProcess) {
    clearTimeout(ended.forced)
    ended.frames.destroy()
    for (const resolve of ended.checks.values()) resolve(true)
    for (const resolve of ended.completions.values()) resolve({ kind: "none", reason: "The REPL has exited." })

    if (running === ended) {
      running = null
      const state = snapshot.state
      if (state.kind === "busy") publish({ type: "finished", id: state.id, outcome: { kind: "lost" } })
      const { exitCode: code, signalCode: signal } = ended.child
      become({ kind: "exited", code, signal, stderr: ended.stderr })
    }
    send({ type: "exit", pid: ended.child.pid })
  }

  function printedBy(printing: ConsoleProcess, text: string) {
    if (running === printing) credit(text)
  }

  function warnedBy(printing: ConsoleProcess, text: string) {
    printing.stderr = (printing.stderr + text).slice(-OUTPUT_LIMIT)
    printedBy(printing, text)
  }

  function credit(text: string) {
    if (text === "") return

    const state = snapshot.state
    const last = snapshot.transcript.at(-1)
    const credited = state.kind === "busy" ? state.id : last?.kind === "output" ? last.id : null

    if (credited === null) {
      publish({ type: "entry", entry: { kind: "output", id: nextId++, output: "", outputCut: false } })
      credit(text)
      return
    }
    // Past its limit an entry keeps nothing more, so there is nothing to tell a listener.
    if (snapshot.transcript.find((entry) => entry.id === credited)?.outputCut === true) return
    publish({ type: "output", id: credited, text })
  }

  function submit(input: string) {
    const state = snapshot.state
    const refusal = submitRefusal(state)
    if (refusal !== null || state.kind !== "ready") return refusal

    const id = nextId++
    publish({ type: "entry", entry: { kind: "evaluation", id, input, output: "", outputCut: false, outcome: null } })
    become({ kind: "busy", pid: state.pid, id, since: Date.now() })
    running?.frames.write(`${JSON.stringify({ type: "eval", id, input })}\n`)
    return null
  }

  function check(text: string) {
    const checking = running
    const state = snapshot.state
    if (checking === null || (state.kind !== "ready" && state.kind !== "busy") || !snapshot.capabilities.includes("check")) {
      return Promise.resolve(true)
    }

    const id = nextCheck++
    return new Promise<boolean>((resolve) => {
      checking.checks.set(id, (complete) => {
        checking.checks.delete(id)
        resolve(complete)
      })
      checking.frames.write(`${JSON.stringify({ type: "check", id, text })}\n`)
    })
  }

  function complete(text: string, caret: number) {
    const completing = running
    const refusal = completeRefusal(snapshot.state, snapshot.capabilities)
    if (completing === null || refusal !== null) return Promise.resolve<Completion>({ kind: "none", reason: refusal ?? "The REPL has exited." })

    const id = nextCompletion++
    return new Promise<Completion>((resolve) => {
      completing.completions.set(id, (completion) => {
        completing.completions.delete(id)
        resolve(completion)
      })
      completing.frames.write(`${JSON.stringify({ type: "complete", id, text, caret })}\n`)
    })
  }

  function interrupt() {
    if (snapshot.state.kind === "busy") running?.child.kill("SIGINT")
  }

  return {
    attach(listener) {
      listeners.add(listener)
      listener({ type: "snapshot", snapshot })
      return { boot, submit, check, complete, interrupt, restart, detach: () => listeners.delete(listener) }
    },
    close() {
      if (running !== null) stop(running)
    },
  }
}

/** An error frame's fields, named as the Reader names them. */
function rubyError({ class: className, message, backtrace, cut }: ErrorFrame): RubyError {
  return { className, message, backtrace, ...(cut && { cut }) }
}

/** A completions frame's fields, named as the Reader names them: candidates, or the reason for none. */
function completionOf(frame: Extract<Frame, { type: "completions" }>): Completion {
  if (frame.candidates === undefined || frame.from === undefined) return { kind: "none", reason: frame.reason ?? "Nothing completes here." }
  return { kind: "candidates", from: frame.from, receiver: frame.receiver ?? null, candidates: frame.candidates }
}

/** Calls `onText` with each piece of text `stream` carries, until it ends. */
async function readText(stream: ReadableStream<Uint8Array>, onText: (text: string) => void) {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }))
}

/** Calls `onLine` with each whole line `socket` receives, without its newline. */
function readLines(socket: Socket, onLine: (line: string) => void) {
  let received = ""
  socket.on("data", (chunk: string) => {
    received += chunk
    const lines = received.split("\n")
    received = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  })
}

/** The frame on `line`, or `null` when it is not JSON, as a line cut short by a crash is not. */
function parsedFrame(line: string) {
  try {
    return JSON.parse(line) as Frame
  } catch {
    return null
  }
}
