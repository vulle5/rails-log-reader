import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"

import { cn } from "../../../lib/cn"
import type { ReplHandle } from "../hooks/repl-session"

const HINTS = "Enter to run · Shift+Enter for a new line"

/** How long a refusal stands in the hint row before the key hints come back. */
const REFUSAL_SHOWN_MS = 3_000

/**
 * The *REPL*'s input: a textarea that runs what is typed on Enter and empties, and a hint row
 * under it. The row is always there at one height, holding the key hints, or for a moment why
 * an input was refused, with `actions` at its end. A refused input stays in the textarea. One
 * the server refused after the textarea emptied is put back, unless something new has been
 * typed since.
 */
export function ReplPrompt({ submit, refusal, actions }: Pick<ReplHandle, "submit" | "refusal"> & { actions?: ReactNode }) {
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
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (input.trim() === "") return

    const reason = submit(input)
    if (reason === null) setInput("")
    else setRefused({ reason })
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
          {refused?.reason ?? HINTS}
        </p>
        {actions}
      </div>
    </div>
  )
}
