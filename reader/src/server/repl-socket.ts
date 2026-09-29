import type { ReplCommand } from "../shared/repl"
import type { ReplAttachment, ReplSession } from "./repl-session"

/** A tab's `/repl` WebSocket, and its hold on the session once it has opened. */
export type ReplSocket = { kind: "repl"; attachment?: ReplAttachment }

/**
 * `/repl`, one WebSocket per tab: each is an attachment to `session`, sent its snapshot and
 * then its updates as JSON, and each message it sends is a `ReplCommand`. A refusal is sent
 * back to the socket whose input was refused and to no other.
 *
 * The route is an act, and its upgrade passes the gate in the Reader's own handler before it
 * gets here: Bun would accept a foreign `Origin` on the upgrade by itself.
 */
export function replSocket(session: ReplSession) {
  function upgrade(request: Request, server: Bun.Server<ReplSocket>) {
    return server.upgrade(request, { data: { kind: "repl" } }) ? undefined : new Response(null, { status: 426 })
  }

  const websocket: Bun.WebSocketHandler<ReplSocket> = {
    open(socket) {
      socket.data.attachment = session.attach((message) => socket.send(JSON.stringify(message)))
    },
    message(socket, received) {
      const attachment = socket.data.attachment
      const command = parsed(received)
      if (attachment === undefined || command === null) return

      if (command.type === "boot") attachment.boot()
      else if (command.type === "interrupt") attachment.interrupt()
      else if (command.type === "restart") attachment.restart(command.sandbox)
      else {
        const refusal = attachment.submit(command.input)
        if (refusal !== null) socket.send(JSON.stringify({ type: "refused", reason: refusal, input: command.input }))
      }
    },
    close(socket) {
      socket.data.attachment?.detach()
    },
  }

  return { upgrade, websocket }
}

/** The command in a message, or `null` when it is not one. */
function parsed(received: string | Buffer): ReplCommand | null {
  try {
    const command = JSON.parse(String(received)) as Partial<ReplCommand> | null
    if (command?.type === "boot") return { type: "boot" }
    if (command?.type === "submit" && typeof command.input === "string") return { type: "submit", input: command.input }
    if (command?.type === "interrupt") return { type: "interrupt" }
    if (command?.type === "restart" && typeof command.sandbox === "boolean") return { type: "restart", sandbox: command.sandbox }
  } catch {
    // Not JSON, which no page of the Reader's sends.
  }
  return null
}
