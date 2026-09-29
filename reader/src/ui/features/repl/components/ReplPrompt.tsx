import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"

import { cn } from "../../../lib/cn"
import type { ReplHandle } from "../hooks/repl-session"

const HINTS = "Enter to run · Shift+Enter for a new line"

/** The key hints while an evaluation runs. */
const BUSY_HINTS = "Ctrl-C to interrupt"

/** How long a refusal stands in the hint row before the key hints come back. */
const REFUSAL_SHOWN_MS = 3_000

/**
 * The *REPL*'s input: a textarea that runs what is typed on Enter and empties, and a hint row
 * under it. The row is always there at one height, holding the key hints, or for a moment why
 * an input was refused, with `actions` at its end. A refused input stays in the textarea. One
 * the server refused after the textarea emptied is put back, unless something new has been
 * typed since.
 *
 * Ctrl-C does what it does in a terminal: with a selection it copies it, while `busy` it
 * interrupts the running evaluation, and otherwise it clears the textarea.
 */
export function ReplPrompt({
  submit,
  interrupt,
  refusal,
  busy,
  actions,
}: Pick<ReplHandle, "submit" | "interrupt" | "refusal"> & { busy: boolean; actions?: ReactNode }) {
  const [input, setInput] = useState("")
  // An object, so a second refusal for the same reason shows for its own moment.
  const [refused, setRefused] = useState<{ reason: string } | null>(null)
  const seen = useRef(refusal)

  useEffect(() => {
    if (refused === null) return
    const shown = setTimeout(() => setRefused(null), REFUSAL_SHOWN_MS)
    return () => clearTimeout(shown)
  }, [refused])

  useEffect(() => {
    if (refusal === seen.current) return
    seen.current = refusal
    if (refusal === null) return

    setRefused({ reason: refusal.reason })
    setInput((typed) => (typed === "" ? refusal.input : typed))
  }, [refusal])

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isCtrlC(event)) {
      ctrlC(event)
      return
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (input.trim() === "") return

    const reason = submit(input)
    if (reason === null) setInput("")
    else setRefused({ reason })
  }

  // A selection is left to the browser's own copy as well, which the clipboard, missing outside
  // a secure context, cannot stand in for; on a Mac, Ctrl-C has no copy of its own.
  function ctrlC(event: KeyboardEvent<HTMLTextAreaElement>) {
    const { value, selectionStart, selectionEnd } = event.currentTarget
    if (selectionStart !== selectionEnd) {
      navigator.clipboard?.writeText(value.slice(selectionStart, selectionEnd)).catch(() => {})
      return
    }
    event.preventDefault()
    if (busy) interrupt()
    else setInput("")
  }

  return (
    <div className="flex flex-none flex-col border-t border-border">
      <textarea
        className="h-14 w-full resize-none bg-transparent px-3 py-1.5 font-mono text-sm text-strong outline-none"
        aria-label="Ruby"
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={keyDown}
      />
      <div className="flex h-5 flex-none items-center gap-3 px-3">
        <p className={cn("min-w-0 flex-auto truncate text-xs", refused === null ? "text-faint" : "text-error")} role="status">
          {refused?.reason ?? (busy ? BUSY_HINTS : HINTS)}
        </p>
        {actions}
      </div>
    </div>
  )
}

/** Ctrl-C alone, which is not the Mac's copy: that is ⌘C. */
function isCtrlC(event: KeyboardEvent) {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c"
}
