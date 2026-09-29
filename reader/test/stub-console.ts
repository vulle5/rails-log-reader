import { appendFileSync } from "node:fs"
import { connect } from "node:net"

/**
 * A stand-in for `bin/rails console` running the eval loop: it speaks the loop's fd 3 frames
 * and never boots Rails. Installed as a Rails root's `bin/rails` by `stubConsoleRoot`.
 *
 * It notes each start in `log/stub-console.log`, as its arguments, then prints a boot line and
 * says it is ready. An input is a canned command:
 *
 * - `puts TEXT` prints TEXT on fd 1, `warn TEXT` on fd 2, and each answers `nil`.
 * - `raise CLASS: MESSAGE` answers with that error.
 * - `sleep MS` answers `1` after MS milliseconds.
 * - `later TEXT` answers `nil`, then prints TEXT on fd 1 after the answer.
 * - `exit CODE` exits with CODE without answering.
 * - Anything else answers with itself as the result's text.
 */

type Frame = { type: string; id: number; input: string }

appendFileSync("log/stub-console.log", `${JSON.stringify(process.argv.slice(2))}\n`)
process.stdout.write("Loading development environment (stub)\n")

const channel = connect({ fd: 3 } as never)
const send = (frame: object) => channel.write(`${JSON.stringify(frame)}\n`)
const answer = (id: number, text: string) => send({ type: "result", id, text, cut: false })

send({ type: "ready", pid: process.pid, capabilities: [] })

let received = ""
channel.setEncoding("utf8")
channel.on("data", (chunk: string) => {
  received += chunk
  const lines = received.split("\n")
  received = lines.pop() ?? ""
  for (const line of lines) void evaluate(JSON.parse(line) as Frame)
})
channel.on("end", () => process.exit(0))

async function evaluate({ id, input }: Frame) {
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
      return send({ type: "error", id, class: className, message })
    }
    case "sleep":
      await Bun.sleep(Number(argument))
      return answer(id, "1")
    case "later":
      answer(id, "nil")
      await Bun.sleep(50)
      process.stdout.write(`${argument}\n`)
      return
    case "exit":
      process.exit(Number(argument))
    default:
      return answer(id, input)
  }
}
