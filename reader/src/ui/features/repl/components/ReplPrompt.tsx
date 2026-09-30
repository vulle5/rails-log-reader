import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"

import { cn } from "../../../lib/cn"
import type { InputHistory } from "../hooks/input-history"
import type { ReplHandle } from "../hooks/repl-session"
import type { HistoryEntry } from "../lib/input-history"
import { InputHistoryList, rowId } from "./InputHistoryList"
import { RubyCode } from "./RubyCode"

const HINTS = "Enter to run · Shift+Enter for a new line"

/** The key hints while an evaluation runs. */
const BUSY_HINTS = "Ctrl-C to interrupt"

/** How long a refusal stands in the hint row before the key hints come back. */
const REFUSAL_SHOWN_MS = 3_000

/** The open *Input history*: what the developer has typed to narrow it, and how many entries back from the newest is chosen. */
type Browsing = { filter: string; back: number }

/**
 * The *REPL*'s input: a textarea that runs what is typed on Enter and empties, drawn over its
 * own text highlighted as Ruby, and a hint row under it. Enter on an input `check` says is
 * incomplete, such as an open `do`, takes a new line at the caret instead, and Shift+Enter always
 * does. An Enter whose check answers after the input has changed, or after a later Enter, does
 * nothing.
 *
 * The row is always there at one height, holding the key hints, or for a moment why an input
 * was refused, with `actions` at its end. A refused input stays in the textarea. One the server
 * refused after the textarea emptied is put back, unless something new has been typed since.
 *
 * Ctrl-C does what it does in a terminal: with a selection it copies it, while `busy` it
 * interrupts the running evaluation, and otherwise it clears the textarea.
 *
 * ↑ on the input's first line opens the *Input history* over the *Transcript*. While it is open
 * what is typed narrows it and never reaches the textarea, ↑ and ↓ choose, Enter or Tab puts the
 * chosen entry in the textarea without running it, and Esc, ↓ past the newest, or leaving the
 * textarea closes it. Each input that runs is recorded in `history`.
 */
export function ReplPrompt({
  submit,
  check,
  interrupt,
  refusal,
  busy,
  history,
  pid,
  actions,
}: Pick<ReplHandle, "submit" | "check" | "interrupt" | "refusal"> & {
  busy: boolean
  history: InputHistory
  /** The console process running now, `null` when none is. */
  pid: number | null
  actions?: ReactNode
}) {
  const [input, setInput] = useState("")
  const [browsing, setBrowsing] = useState<Browsing | null>(null)
  const listId = useId()
  // An object, so a second refusal for the same reason shows for its own moment.
  const [refused, setRefused] = useState<{ reason: string } | null>(null)
  const seen = useRef(refusal)
  const typed = useRef(input)
  typed.current = input
  const box = useRef<HTMLTextAreaElement>(null)
  const highlighted = useRef<HTMLPreElement>(null)
  const enters = useRef(0)
  // Where the caret goes once a new line Enter took is in the textarea.
  const caret = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (caret.current === null) return
    box.current?.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [input])

  // A value that shrinks can clamp the textarea's scroll without a scroll event.
  useLayoutEffect(() => {
    if (highlighted.current !== null && box.current !== null) highlighted.current.scrollTop = box.current.scrollTop
  }, [input])

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

  // Oldest first, as the list draws them.
  const matches = browsing === null ? [] : history.entries.filter((entry) => entry.input.toLowerCase().includes(browsing.filter.toLowerCase()))
  const chosen = browsing === null || matches.length === 0 ? -1 : matches.length - 1 - Math.min(browsing.back, matches.length - 1)

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isCtrlC(event)) {
      setBrowsing(null)
      ctrlC(event)
      return
    }
    if (browsing !== null) {
      browse(event, browsing)
      if (event.defaultPrevented) return
    } else if (opensHistory(event)) {
      event.preventDefault()
      setBrowsing({ filter: "", back: 0 })
      return
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (input.trim() === "") return

    const { selectionStart, selectionEnd } = event.currentTarget
    const enter = ++enters.current
    void check(input).then((complete) => {
      if (enter !== enters.current || typed.current !== input) return
      if (complete) run()
      else newLine(selectionStart, selectionEnd)
    })
  }

  function opensHistory(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "ArrowUp" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false
    if (event.nativeEvent.isComposing || history.entries.length === 0) return false
    const { value, selectionStart } = event.currentTarget
    return !value.slice(0, selectionStart).includes("\n")
  }

  function browse(event: KeyboardEvent<HTMLTextAreaElement>, { filter, back }: Browsing) {
    if (event.nativeEvent.isComposing) return

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setBrowsing({ filter, back: Math.max(0, Math.min(back + 1, matches.length - 1)) })
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      setBrowsing(chosen === matches.length - 1 || matches.length === 0 ? null : { filter, back: back - 1 })
    } else if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault()
      const entry = matches[chosen]
      if (entry !== undefined) pick(entry)
      else setBrowsing(null)
    } else if (event.key === "Escape") {
      event.preventDefault()
      setBrowsing(null)
    } else if (event.key === "Backspace") {
      event.preventDefault()
      setBrowsing({ filter: filter.slice(0, -1), back: 0 })
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      setBrowsing({ filter: filter + event.key, back: 0 })
    }
  }

  function pick(entry: HistoryEntry) {
    setBrowsing(null)
    if (entry.input === input) {
      box.current?.setSelectionRange(input.length, input.length)
    } else {
      caret.current = entry.input.length
      setInput(entry.input)
    }
    box.current?.focus()
  }

  function run() {
    const reason = submit(input)
    if (reason === null) {
      history.record(input)
      setInput("")
    } else setRefused({ reason })
  }

  function newLine(start: number, end: number) {
    caret.current = start + 1
    setInput(`${input.slice(0, start)}\n${input.slice(end)}`)
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
    <div className="relative flex flex-none flex-col border-t border-border">
      {browsing !== null && <InputHistoryList id={listId} entries={matches} filter={browsing.filter} selected={chosen} pid={pid} onPick={pick} />}
      <div className="relative h-14">
        {/* The input's highlighting, under a textarea whose own text is transparent. The two share
            their box, font and wrapping, so each glyph drawn here sits under the one it colours.
            The trailing space gives a final empty line a height, as the textarea gives it one, and
            the stable gutter keeps the wrap width the same whether or not the textarea scrolls. */}
        <pre
          className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-1.5 font-mono text-sm break-words whitespace-pre-wrap text-strong [scrollbar-gutter:stable]"
          ref={highlighted}
          aria-hidden="true"
        >
          <RubyCode source={input} />{" "}
        </pre>
        <textarea
          className={cn(
            "absolute inset-0 resize-none overflow-y-auto bg-transparent px-3 py-1.5 font-mono text-sm break-words whitespace-pre-wrap outline-none [scrollbar-gutter:stable]",
            // The caret and a selection's text are the textarea's own; the rest of its text is drawn under it.
            "text-transparent caret-strong selection:text-strong",
          )}
          ref={box}
          aria-label="Ruby"
          aria-controls={browsing === null ? undefined : listId}
          aria-activedescendant={chosen === -1 ? undefined : rowId(listId, chosen)}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={keyDown}
          onBlur={() => setBrowsing(null)}
          onScroll={(event) => {
            if (highlighted.current !== null) highlighted.current.scrollTop = event.currentTarget.scrollTop
          }}
        />
      </div>
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
