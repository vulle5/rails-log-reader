import { connect, type Socket } from "node:net"
import { join } from "node:path"

import {
  applyReplUpdate,
  EMPTY_SNAPSHOT,
  submitRefusal,
  type Outcome,
  type ReplMessage,
  type ReplSnapshot,
  type ReplState,
  type ReplUpdate,
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
  detach: () => void
}

export type ReplSession = {
  /** `listener` is sent the session's snapshot at once, then every update after it. */
  attach: (listener: ReplListener) => ReplAttachment
  /** Stops the console process, if one is running. */
  close: () => void
}

/** A frame the eval loop sends on fd 3. */
type Frame =
  | { type: "ready"; pid: number; capabilities: string[] }
  | { type: "result"; id: number; text: string; cut: boolean }
  | { type: "error"; id: number; class: string; message: string }

/**
 * The *REPL*'s one console process, `bin/rails console` running the eval loop from
 * `railsRoot`, shared by every listener for as long as the Reader runs. Nothing starts it until
 * an attachment asks, so a Reader only used for reading logs never starts one.
 *
 * It runs in the Reader's own environment. Frames travel on fd 3, a socket. What the console
 * process prints on fds 1 and 2 is credited to the running evaluation, or becomes an output
 * entry of its own when none is running.
 *
 * A frame is acted on a macrotask after it arrives. What an evaluation printed was written
 * before its answer, but the two travel on different fds and the answer can be read first;
 * the wait lets the output that is already there be read and credited to it.
 */
export function replSession(railsRoot: string): ReplSession {
  let snapshot: ReplSnapshot = EMPTY_SNAPSHOT
  const listeners = new Set<ReplListener>()
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null
  let frames: Socket | null = null
  let nextId = 1

  function publish(update: ReplUpdate) {
    snapshot = applyReplUpdate(snapshot, update)
    for (const listener of listeners) listener(update)
  }

  function become(state: ReplState, capabilities = snapshot.capabilities) {
    publish({ type: "state", state, capabilities })
  }

  function boot() {
    if (snapshot.state.kind !== "idle") return
    become({ kind: "booting" })

    try {
      child = Bun.spawn([join(railsRoot, "bin", "rails"), "console", "--", "-f", "-r", REPL_LOOP], {
        cwd: railsRoot,
        stdio: ["ignore", "pipe", "pipe", "socket-fd"],
        onExit: (_process, code) => {
          setTimeout(() => exited(code))
        },
      })
    } catch (problem) {
      credit(`${String(problem)}\n`)
      become({ kind: "exited", code: null })
      return
    }

    frames = connect({ fd: child.stdio[3] } as never)
    frames.setEncoding("utf8")
    frames.on("error", () => {
      // The console process went away mid-frame. Its exit says so.
    })
    readLines(frames, (line) => {
      const frame = parsedFrame(line)
      if (frame !== null) setTimeout(() => answered(frame))
    })
    void readText(child.stdout)
    void readText(child.stderr)
  }

  function answered(frame: Frame) {
    const state = snapshot.state

    if (frame.type === "ready") {
      become({ kind: "ready", pid: frame.pid }, frame.capabilities)
      return
    }
    if (state.kind !== "busy" || state.id !== frame.id) return

    const outcome: Outcome =
      frame.type === "result"
        ? { kind: "result", text: frame.text, cut: frame.cut }
        : { kind: "error", className: frame.class, message: frame.message }
    publish({ type: "finished", id: frame.id, outcome })
    become({ kind: "ready", pid: state.pid })
  }

  function exited(code: number | null) {
    const state = snapshot.state
    if (state.kind === "busy") publish({ type: "finished", id: state.id, outcome: { kind: "lost" } })
    frames?.destroy()
    become({ kind: "exited", code })
  }

  async function readText(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()
    for await (const chunk of stream) credit(decoder.decode(chunk, { stream: true }))
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
    frames?.write(`${JSON.stringify({ type: "eval", id, input })}\n`)
    return null
  }

  return {
    attach(listener) {
      listeners.add(listener)
      listener({ type: "snapshot", snapshot })
      return { boot, submit, detach: () => listeners.delete(listener) }
    },
    close() {
      frames?.destroy()
      child?.kill()
    },
  }
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
