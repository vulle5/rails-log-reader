import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { connect } from "node:net"

import { stubComplete } from "./repl.fixtures"

/**
 * A stand-in for `bin/rails console` running the eval loop: it speaks the loop's fd 3 frames
 * and never boots Rails. Installed as a Rails root's `bin/rails` by `stubConsoleRoot`.
 *
 * It notes each start in `log/stub-console.log`, as its arguments, then prints a boot line and
 * says it is ready. When `log/stub-console.fails` is there, it prints that file on fd 2 instead
 * and exits 1, as a failed boot does. It notes its stdin closing and a SIGTERM in the same log,
 * and dies of the SIGTERM. It notes a SIGINT too, which interrupts a running `sleep`. An input
 * is a canned command:
 *
 * - `puts TEXT` prints TEXT on fd 1, `warn TEXT` on fd 2, and each answers `nil`.
 * - `raise CLASS: MESSAGE` answers with that error, raised at `(repl):1`.
 * - `wrap CLASS: MESSAGE` answers with that error, raised at `(repl):2` over a `KeyError: root` cause.
 * - `sleep MS` answers `1` after MS milliseconds, or raises `Interrupt` on a SIGINT before then.
 * - `nap MS` prints `napping` on fd 1, then sleeps as `sleep` does.
 * - `later TEXT` answers `nil`, then prints TEXT on fd 1 after the answer.
 * - `exit CODE` exits with CODE without answering.
 * - `signal NAME` sends itself signal NAME without answering.
 * - `broken` answers `#<Broken>`, noting that its `inspect` raised.
 * - Anything else answers with itself as the result's text, and as its tree's one leaf.
 *
 * It answers a check at once, even while an evaluation runs, by `stubComplete`. When
 * `log/stub-console.uncheckable` is there, it says it has no multi-line check, and answers none.
 */

type Frame = { type: "eval"; id: number; input: string } | { type: "check"; id: number; text: string }

const note = (entry: object) => appendFileSync("log/stub-console.log", `${JSON.stringify(entry)}\n`)

note({ started: process.argv.slice(2) })
process.stdout.write("Loading development environment (stub)\n")

if (existsSync("log/stub-console.fails")) {
  process.stderr.write(readFileSync("log/stub-console.fails"))
  process.exit(1)
}

const stdinClosed = new Promise<void>((resolve) => {
  process.stdin.on("end", () => {
    note({ heard: "stdin closed" })
    resolve()
  })
})
process.stdin.resume()
process.once("SIGTERM", async () => {
  // A stdin closed just before the signal can be read after it.
  await Promise.race([stdinClosed, Bun.sleep(100)])
  note({ heard: "SIGTERM" })
  process.kill(process.pid, "SIGTERM")
})

/** Wakes the running `sleep`, if any, to raise `Interrupt`. */
let interrupt = () => {}
process.on("SIGINT", () => {
  note({ heard: "SIGINT" })
  interrupt()
})

const channel = connect({ fd: 3 } as never)
const send = (frame: object) => channel.write(`${JSON.stringify(frame)}\n`)
const answer = (id: number, text: string, extra: object = {}) =>
  send({ type: "result", id, text, cut: false, tree: { type: "object", inspect: text }, ...extra })

const checkable = !existsSync("log/stub-console.uncheckable")
send({ type: "ready", pid: process.pid, capabilities: checkable ? ["check"] : [] })

let received = ""
channel.setEncoding("utf8")
channel.on("data", (chunk: string) => {
  received += chunk
  const lines = received.split("\n")
  received = lines.pop() ?? ""
  for (const line of lines) {
    const frame = JSON.parse(line) as Frame
    if (frame.type === "eval") void evaluate(frame)
    else if (checkable) send({ type: "checked", id: frame.id, complete: stubComplete(frame.text) })
  }
})
// A moment late, so a signal the Reader sent before it went away is heard first.
channel.on("end", () => setTimeout(() => process.exit(0), 100))

async function evaluate({ id, input }: { id: number; input: string }) {
  const [command = "", ...rest] = input.split(" ")
  const argument = rest.join(" ")

  switch (command) {
    case "puts":
      process.stdout.write(`${argument}\n`)
      return answer(id, "nil")
    case "warn":
      process.stderr.write(`${argument}\n`)
      return answer(id, "nil")
    case "raise": {
      const [className, message] = argument.split(": ")
      return send({ type: "error", id, class: className, message, backtrace: ["(repl):1:in '<main>'"], causes: [] })
    }
    case "wrap": {
      const [className, message] = argument.split(": ")
      const cause = { class: "KeyError", message: "root", backtrace: ["(repl):1:in 'fetch'", "(repl):1:in '<main>'"] }
      return send({ type: "error", id, class: className, message, backtrace: ["(repl):2:in '<main>'"], causes: [cause] })
    }
    case "nap":
      process.stdout.write("napping\n")
      return sleep(id, Number(argument))
    case "sleep":
      return sleep(id, Number(argument))
    case "later":
      answer(id, "nil")
      await Bun.sleep(50)
      process.stdout.write(`${argument}\n`)
      return
    case "exit":
      process.exit(Number(argument))
    case "signal":
      process.kill(process.pid, argument)
      return
    case "broken":
      return answer(id, "#<Broken>", { inspect_error: "RuntimeError: nope" })
    default:
      return answer(id, input)
  }
}

async function sleep(id: number, ms: number) {
  const interrupted = new Promise<true>((resolve) => (interrupt = () => resolve(true)))
  const woken = await Promise.race([interrupted, Bun.sleep(ms)])
  interrupt = () => {}
  if (woken) return send({ type: "error", id, class: "Interrupt", message: "", backtrace: ["(repl):1:in 'sleep'"], causes: [] })
  return answer(id, "1")
}
