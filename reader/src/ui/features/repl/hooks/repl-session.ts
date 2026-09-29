import { useCallback, useEffect, useRef, useState } from "react"

import {
  applyReplUpdate,
  EMPTY_SNAPSHOT,
  isReplUpdate,
  submitRefusal,
  type ReplCommand,
  type ReplMessage,
  type ReplSnapshot,
} from "../../../../shared/repl"

/** What `Reader` is handed of the *REPL* session: what it holds, and what can be asked of it. */
export type ReplHandle = {
  snapshot: ReplSnapshot
  /** Starts the console process unless one has been started. Asked while the drawer is open. */
  boot: () => void
  /** Sends `input` to run, or says why it will not: `null` when it was sent. */
  submit: (input: string) => string | null
  /**
   * Whether `text` is a whole input, rather than one that needs more lines. True when the
   * console process has no multi-line check, or the page is not connected.
   */
  check: (text: string) => Promise<boolean>
  /** Interrupts the running evaluation, as Ctrl-C does. */
  interrupt: () => void
  /** Starts a fresh console process, sandboxed when `sandbox`, in place of the one there is. */
  restart: (sandbox: boolean) => void
  /** The latest input the server refused from this tab, and why. A new object for each. */
  refusal: { reason: string; input: string } | null
}

/** A session this page is not attached to: never started, and refusing every input. */
export const DETACHED_REPL: ReplHandle = {
  snapshot: EMPTY_SNAPSHOT,
  boot: () => {},
  submit: () => submitRefusal(EMPTY_SNAPSHOT.state),
  check: async () => true,
  interrupt: () => {},
  restart: () => {},
  refusal: null,
}

/** How long the page waits before opening `/repl` again once it has closed. */
const RECONNECT_MS = 1_000

/**
 * The *REPL* session, through this tab's `/repl` WebSocket: the snapshot it opens on, folded
 * forward by every update after it, the way the server folds them. A socket that closes opens
 * again, and the snapshot it opens on replaces whatever this tab held.
 *
 * Opened only when `mayAct`, since `/repl` is an act and refuses any other page. A boot that
 * has been asked for is asked again each time the socket opens, so a Reader restarted under
 * an open drawer starts its console process too.
 */
export function useReplSession(mayAct: boolean): ReplHandle {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT)
  const [refusal, setRefusal] = useState<ReplHandle["refusal"]>(null)
  const socket = useRef<WebSocket | null>(null)
  const booting = useRef(false)
  // The checks this tab has asked and not yet been answered, by id.
  const checks = useRef(new Map<number, (complete: boolean) => void>())
  const nextCheck = useRef(1)

  useEffect(() => {
    if (!mayAct) return

    let stopped = false
    let reconnect: ReturnType<typeof setTimeout> | undefined

    function open() {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws"
      const opened = new WebSocket(`${scheme}://${window.location.host}/repl`)
      socket.current = opened

      opened.onopen = () => {
        if (booting.current) send(opened, { type: "boot" })
      }
      opened.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ReplMessage
        if (message.type === "snapshot") setSnapshot(message.snapshot)
        else if (message.type === "refused") setRefusal({ reason: message.reason, input: message.input })
        else if (message.type === "checked") answered(message.id, message.complete)
        else if (isReplUpdate(message)) setSnapshot((held) => applyReplUpdate(held, message))
      }
      opened.onclose = () => {
        if (socket.current === opened) socket.current = null
        for (const id of checks.current.keys()) answered(id, true)
        if (!stopped) reconnect = setTimeout(open, RECONNECT_MS)
      }
    }

    open()
    return () => {
      stopped = true
      clearTimeout(reconnect)
      socket.current?.close()
    }
  }, [mayAct])

  const boot = useCallback(() => {
    booting.current = true
    const open = socket.current
    if (open?.readyState === WebSocket.OPEN) send(open, { type: "boot" })
  }, [])

  function submit(input: string) {
    const refused = submitRefusal(snapshot.state)
    if (refused !== null) return refused

    const open = socket.current
    if (open?.readyState !== WebSocket.OPEN) return "Not connected to the Reader."
    send(open, { type: "submit", input })
    return null
  }

  function answered(id: number, complete: boolean) {
    checks.current.get(id)?.(complete)
    checks.current.delete(id)
  }

  function check(text: string) {
    const open = socket.current
    if (open?.readyState !== WebSocket.OPEN) return Promise.resolve(true)

    const id = nextCheck.current++
    return new Promise<boolean>((resolve) => {
      checks.current.set(id, resolve)
      send(open, { type: "check", id, text })
    })
  }

  function interrupt() {
    const open = socket.current
    if (open?.readyState === WebSocket.OPEN) send(open, { type: "interrupt" })
  }

  function restart(sandbox: boolean) {
    const open = socket.current
    if (open?.readyState === WebSocket.OPEN) send(open, { type: "restart", sandbox })
  }

  return { snapshot, boot, submit, check, interrupt, restart, refusal }
}

function send(socket: WebSocket, command: ReplCommand) {
  socket.send(JSON.stringify(command))
}
