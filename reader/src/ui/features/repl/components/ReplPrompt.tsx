import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react"

import type { Candidate } from "../../../../shared/repl"
import type { CompletionTrigger } from "../../../hooks/completion-trigger"
import { cn } from "../../../lib/cn"
import type { InputHistory } from "../hooks/input-history"
import type { ReplHandle } from "../hooks/repl-session"
import type { HistoryEntry } from "../lib/input-history"
import { CompletionList } from "./CompletionList"
import { InputHistoryList, rowId } from "./InputHistoryList"
import { RubyCode } from "./RubyCode"

/** How long a refusal, or why nothing completed, stands in the hint row before the key hints come back. */
const NOTICE_SHOWN_MS = 3_000

/** The open *Input history*: what the developer has typed to narrow it, and how many entries back from the newest is chosen. */
type Browsing = { filter: string; back: number }

/**
 * The open completion popover. Its candidates replace the text from `from` to `caret`, and it
 * holds only while the text before `from` is still `prefix`. `selected` is an index into the
 * candidates that still match what is typed. It is the first when the popover opens and again
 * whenever something is typed.
 */
type Completing = { from: number; prefix: string; caret: number; receiver: string | null; candidates: readonly Candidate[]; selected: number }

/** The grey text after the caret: `rest` is what it adds, and `owner` is what it is the suggestion of. */
type Suggested = { owner: "history" | "completion"; rest: string }

/** What is in the hint row for a moment: why an input was refused, or why nothing completed. */
type Notice = { reason: string; error: boolean }

/** Keys that move the caret off the word being completed. */
const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"])

/**
 * The *REPL*'s input: a textarea that runs what is typed on Enter and empties, drawn over its
 * own text highlighted as Ruby, and a hint row under it. Enter on an input `check` says is
 * incomplete, such as an open `do`, takes a new line at the caret instead, and Shift+Enter always
 * does. An Enter whose check answers after the input has changed, or after a later Enter, does
 * nothing.
 *
 * The row is always there at one line and one height, holding the keys that work in the input's
 * current state, or for a moment why an input was refused, with `actions` at its end. The keys
 * are ordered most important first and clip on a narrow drawer, and the wording that is not a
 * key drops before any key does. `completes` is whether the console process has a completor,
 * and without one there is no Tab hint. A refused input stays in the textarea. One the server
 * refused after the textarea emptied is put back, unless something new has been typed since.
 *
 * The textarea is as tall as its text, from one line up to the smaller of 12 lines and half the
 * drawer's body, and scrolls past that. Its height follows the text and nothing else.
 *
 * Ctrl-C does what it does in a terminal: with a selection it copies it, while `busy` it
 * interrupts the running evaluation, and otherwise it clears the textarea.
 *
 * ↑ on the input's first line opens the *Input history* over the *Transcript*. While it is open
 * what is typed narrows it and never reaches the textarea, ↑ and ↓ choose, Enter or Tab puts the
 * chosen entry in the textarea without running it, and Esc, ↓ past the newest, or leaving the
 * textarea closes it. Each input that runs is recorded in `history`.
 *
 * Tab asks `complete` what the word before the caret could be: one candidate is inserted, several
 * open a popover at the word, and none says why in the hint row, as does an evaluation running.
 * An answer that arrives after a newer request, or after the input or the caret has moved, is
 * dropped. The popover narrows to the candidates that start with what is typed of the word, and
 * closes when none do, which is when the word ends. ↑ and ↓ choose, Enter or Tab inserts the
 * chosen candidate without running the input, and Esc, the caret moving off the word, editing
 * before it, or leaving the textarea closes it. With `trigger` `typing`, each thing typed asks
 * for itself: the popover opens for a single candidate too, and says
 * nothing when it cannot. Either way the first candidate is chosen when the popover opens, and
 * again whenever something is typed, so Enter inserts it.
 *
 * Grey text follows the caret while the caret is at the end of the text. With `suggesting` it is
 * the *History suggestion*: the rest of the newest entry that starts with the input. It
 * is found from a deferred copy of the input and drawn only while it still matches the input,
 * and not while the textarea is unfocused or an input method is composing. → or End takes it. The text has one owner: while the popover is open it previews the chosen
 * candidate instead, and → or End takes that, whether or not `suggesting`. The *Input history*
 * list open hides it.
 */
export function ReplPrompt({
  submit,
  check,
  complete,
  interrupt,
  refusal,
  busy,
  history,
  trigger,
  suggesting,
  completes,
  pid,
  actions,
}: Pick<ReplHandle, "submit" | "check" | "complete" | "interrupt" | "refusal"> & {
  busy: boolean
  history: InputHistory
  /** What opens the completion popover. */
  trigger: CompletionTrigger
  /** Whether the *History suggestion* is offered; the popover's preview of its chosen candidate is not part of it. */
  suggesting: boolean
  /** Whether the console process has a completor, which is what Tab asks. */
  completes: boolean
  /** The console process running now, `null` when none is. */
  pid: number | null
  actions?: ReactNode
}) {
  const [input, setInput] = useState("")
  const [browsing, setBrowsing] = useState<Browsing | null>(null)
  const [completing, setCompleting] = useState<Completing | null>(null)
  const [place, setPlace] = useState({ left: 0, top: 0 })
  // Whether the caret is at the end of the text with nothing selected, which is the only place grey text can follow it.
  const [atEnd, setAtEnd] = useState(true)
  // Whether the caret is on the input's first line, which is the only place ↑ opens the *Input history*.
  const [onFirstLine, setOnFirstLine] = useState(true)
  // An input method is composing, whose text the textarea has yet to settle.
  const [composing, setComposing] = useState(false)
  const listId = useId()
  const completionId = useId()
  // An object, so a second notice with the same words shows for its own moment.
  const [notice, setNotice] = useState<Notice | null>(null)
  const seen = useRef(refusal)
  const typed = useRef(input)
  typed.current = input
  const box = useRef<HTMLTextAreaElement>(null)
  const highlighted = useRef<HTMLPreElement>(null)
  const wordStart = useRef<HTMLSpanElement>(null)
  const enters = useRef(0)
  // The completions asked for, so an answer to any but the latest is dropped.
  const asks = useRef(0)
  // Where the caret goes once a new line Enter took is in the textarea.
  const caret = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (box.current === null) return
    if (caret.current !== null) {
      box.current.setSelectionRange(caret.current, caret.current)
      caret.current = null
    }
    markCaret(box.current)
  }, [input])

  // A value that shrinks can clamp the textarea's scroll without a scroll event.
  useLayoutEffect(() => {
    if (highlighted.current !== null && box.current !== null) highlighted.current.scrollTop = box.current.scrollTop
  }, [input])

  useEffect(() => {
    if (notice === null) return
    const shown = setTimeout(() => setNotice(null), NOTICE_SHOWN_MS)
    return () => clearTimeout(shown)
  }, [notice])

  useEffect(() => {
    if (refusal === seen.current) return
    seen.current = refusal
    if (refusal === null) return

    setNotice({ reason: refusal.reason, error: true })
    setInput((typed) => (typed === "" ? refusal.input : typed))
  }, [refusal])

  // Oldest first, as the list draws them.
  const matches = browsing === null ? [] : history.entries.filter((entry) => entry.input.toLowerCase().includes(browsing.filter.toLowerCase()))
  const chosen = browsing === null || matches.length === 0 ? -1 : matches.length - 1 - Math.min(browsing.back, matches.length - 1)

  // What of the popover's candidates matches what is typed of the word, and the popover itself
  // once it has any, still holds, and has not been left behind by the caret.
  const word = completing === null ? "" : input.slice(completing.from, completing.caret)
  const shown = completing === null ? [] : completing.candidates.filter((candidate) => candidate.text.startsWith(word))
  const holds = completing !== null && shown.length > 0 && input.startsWith(completing.prefix) && completing.caret >= completing.from
  const open = holds ? completing : null
  const picked = open === null || open.selected < 0 ? -1 : Math.min(open.selected, shown.length - 1)

  useEffect(() => {
    if (completing !== null && !holds) setCompleting(null)
  }, [completing, holds])

  // The newest entry starting with a deferred copy of the input, so typing never waits on the search.
  const deferred = useDeferredValue(input)
  const remembered = useMemo(
    () => (suggesting && deferred !== "" ? history.entries.findLast((entry) => entry.input.length > deferred.length && entry.input.startsWith(deferred)) : undefined),
    [suggesting, deferred, history.entries],
  )
  const suggested = suggest()

  // Where the word starts on the page, read off an invisible copy of the text before it that wraps as the textarea does.
  useLayoutEffect(() => {
    if (open === null || wordStart.current === null) return
    setPlace({ left: wordStart.current.offsetLeft, top: wordStart.current.offsetTop - (box.current?.scrollTop ?? 0) })
  }, [open?.from, open?.prefix, input])

  function markCaret(textarea: HTMLTextAreaElement) {
    setAtEnd(caretAtEnd(textarea))
    setOnFirstLine(caretOnFirstLine(textarea))
  }

  /** The grey text to draw: the chosen candidate's rest while the popover is open, else the newest matching history entry's. */
  function suggest(): Suggested | null {
    if (!atEnd || composing || browsing !== null) return null
    if (open !== null) {
      const candidate = picked === -1 ? undefined : shown[picked]
      return candidate === undefined || candidate.text.length === word.length ? null : { owner: "completion", rest: candidate.text.slice(word.length) }
    }
    return remembered !== undefined && remembered.input.startsWith(input) && remembered.input.length > input.length
      ? { owner: "history", rest: remembered.input.slice(input.length) }
      : null
  }

  /** Puts what the grey text offers in the input, as if it had been typed. */
  function take(offered: Suggested) {
    if (offered.owner === "completion" && open !== null) {
      insert(open.from, open.caret, shown[picked]!)
      return
    }
    caret.current = input.length + offered.rest.length
    setInput(input + offered.rest)
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isCtrlC(event)) {
      setBrowsing(null)
      setCompleting(null)
      ctrlC(event)
      return
    }
    if (suggested !== null && takesSuggestion(event)) {
      if (caretAtEnd(event.currentTarget)) {
        event.preventDefault()
        take(suggested)
        return
      }
    }
    if (browsing !== null) {
      browse(event, browsing)
      if (event.defaultPrevented) return
    } else if (open !== null) {
      choose(event, open)
      if (event.defaultPrevented) return
    } else if (opensHistory(event)) {
      event.preventDefault()
      setBrowsing({ filter: "", back: 0 })
      return
    } else if (asksForCompletion(event)) {
      event.preventDefault()
      const { selectionStart, selectionEnd } = event.currentTarget
      if (selectionStart === selectionEnd) ask(input, selectionStart, true)
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

  function asksForCompletion(event: KeyboardEvent<HTMLTextAreaElement>) {
    return event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing
  }

  /**
   * Asks what the word before `caret` in `text` could be, and acts on the answer unless it is
   * stale. `explicit` is a Tab: it inserts a single candidate, and says why when there is none.
   */
  function ask(text: string, caret: number, explicit: boolean) {
    const request = ++asks.current
    void complete(text, caret).then((completion) => {
      if (request !== asks.current || typed.current !== text || box.current?.selectionStart !== caret) return

      if (completion.kind === "none" || completion.candidates.length === 0) {
        setCompleting(null)
        if (explicit) setNotice({ reason: completion.kind === "none" ? completion.reason : "Nothing completes here.", error: false })
      } else if (explicit && completion.candidates.length === 1) {
        setCompleting(null)
        insert(completion.from, caret, completion.candidates[0]!)
      } else {
        const { from, receiver, candidates } = completion
        setCompleting({ from, prefix: text.slice(0, from), caret, receiver, candidates, selected: 0 })
      }
    })
  }

  function choose(event: KeyboardEvent<HTMLTextAreaElement>, popover: Completing) {
    if (event.nativeEvent.isComposing) return

    const move = (to: number) => {
      event.preventDefault()
      setCompleting({ ...popover, selected: (to + shown.length) % shown.length })
    }
    if (event.key === "ArrowDown") move(picked + 1)
    else if (event.key === "ArrowUp") move(picked < 0 ? shown.length - 1 : picked - 1)
    else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      insert(popover.from, popover.caret, shown[Math.max(picked, 0)]!)
    } else if (event.key === "Enter" && !event.shiftKey && picked >= 0) {
      event.preventDefault()
      insert(popover.from, popover.caret, shown[picked]!)
    } else if (event.key === "Escape") {
      event.preventDefault()
      setCompleting(null)
    } else if (CARET_KEYS.has(event.key)) setCompleting(null)
  }

  /** Puts `candidate` in place of the text from `from` to `caret`, the caret after it. */
  function insert(from: number, caretAt: number, candidate: Candidate) {
    setCompleting(null)
    caret.current = from + candidate.text.length
    setInput(`${input.slice(0, from)}${candidate.text}${input.slice(caretAt)}`)
    box.current?.focus()
  }

  function typedInto(event: ChangeEvent<HTMLTextAreaElement>) {
    const { value, selectionStart } = event.target
    setInput(value)
    setCompleting((held) => (held === null ? null : { ...held, caret: selectionStart, selected: 0 }))
    if (value === "") {
      asks.current++
      setCompleting(null)
    } else if (trigger === "typing" && browsing === null) ask(value, selectionStart, false)
  }

  function opensHistory(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "ArrowUp" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false
    if (event.nativeEvent.isComposing || history.entries.length === 0) return false
    return caretOnFirstLine(event.currentTarget)
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
    setCompleting(null)
    if (entry.input === input) {
      box.current?.setSelectionRange(input.length, input.length)
    } else {
      caret.current = entry.input.length
      setInput(entry.input)
    }
    box.current?.focus()
  }

  function run() {
    setCompleting(null)
    const reason = submit(input)
    if (reason === null) {
      history.record(input)
      setInput("")
    } else setNotice({ reason, error: true })
  }

  function newLine(start: number, end: number) {
    setCompleting(null)
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

  /** The keys that work now, most important first. */
  function keyHints() {
    const opensHistoryHere = history.entries.length > 0 && onFirstLine
    if (browsing !== null) {
      return (
        <>
          <Hint keys="↑↓">choose</Hint>
          <Hint keys="↵">put in input</Hint>
          <Hint keys="esc">close</Hint>
        </>
      )
    }
    if (open !== null) {
      return (
        <>
          <Hint keys="⇥">
            take <span className="font-mono">{shown[Math.max(picked, 0)]!.text}</span>
          </Hint>
          <Hint keys="↑↓">choose</Hint>
          <Hint keys="esc">close</Hint>
        </>
      )
    }
    if (busy) {
      return (
        <>
          <Hint keys="^C">interrupt</Hint>
          <Hint keys="⇧↵">newline</Hint>
          {opensHistoryHere && <Hint keys="↑">history</Hint>}
        </>
      )
    }
    return (
      <>
        <Hint keys="↵">
          run
          {/* The first wording to go: it shows only where the whole row fits with it. */}
          <span className="hidden @min-[44rem]:inline"> (newline if unfinished)</span>
        </Hint>
        <Hint keys="⇧↵">newline</Hint>
        {completes && <Hint keys="⇥">complete</Hint>}
        {suggested !== null && <Hint keys="→">take the grey text</Hint>}
        {opensHistoryHere && <Hint keys="↑">history</Hint>}
        <Hint keys="^C">clear</Hint>
      </>
    )
  }

  return (
    <div className="relative flex flex-none flex-col border-t border-border">
      {browsing !== null && <InputHistoryList id={listId} entries={matches} filter={browsing.filter} selected={chosen} pid={pid} onPick={pick} />}
      <div className="relative">
        {open !== null && (
          <CompletionList
            id={completionId}
            receiver={open.receiver}
            candidates={shown}
            selected={picked}
            place={place}
            onPick={(candidate) => insert(open.from, open.caret, candidate)}
          />
        )}
        {open !== null && (
          // An invisible copy of the text up to the word, wrapped as the textarea wraps it, whose
          // last span is where the word starts.
          <div
            className="pointer-events-none invisible absolute inset-0 overflow-hidden px-3 py-1.5 font-mono text-sm break-words whitespace-pre-wrap [scrollbar-gutter:stable]"
            aria-hidden="true"
          >
            {input.slice(0, open.from)}
            <span ref={wordStart} />
          </div>
        )}
        {/* The input's highlighting, under a textarea whose own text is transparent. The two share
            their box, font and wrapping, so each glyph drawn here sits under the one it colours.
            The trailing space gives a final empty line a height, as the textarea gives it one, and
            the stable gutter keeps the wrap width the same whether or not the textarea scrolls.
            This is the one of the two that is in the flow, so the input is as tall as its text,
            up to the cap: the smaller of 12 lines and half the drawer's body, which is its
            container less the hint row's `h-5`, in whole lines, and never less than one. */}
        <pre
          className="pointer-events-none max-h-[calc(max(1lh,min(12lh,round(down,(100cqh-1.25rem)/2-0.75rem,1lh)))+0.75rem)] overflow-hidden px-3 py-1.5 font-mono text-sm break-words whitespace-pre-wrap text-strong [scrollbar-gutter:stable]"
          ref={highlighted}
          aria-hidden="true"
        >
          <RubyCode source={input} />
          {suggested !== null && (
            <>
              {/* A break opportunity, so the typed text wraps as the textarea wraps it and the grey text after it does not carry its last word onto the next line. */}
              {"\u200b"}
              <span className="text-faint" data-suggestion={suggested.owner}>
                {suggested.rest}
              </span>
            </>
          )}{" "}
        </pre>
        <textarea
          className={cn(
            "absolute inset-0 resize-none overflow-y-auto bg-transparent px-3 py-1.5 font-mono text-sm break-words whitespace-pre-wrap outline-none [scrollbar-gutter:stable]",
            // The caret and a selection's tint are the textarea's own; all of its text is drawn under it, a selection's too.
            "text-transparent caret-strong selection:bg-selection selection:text-transparent",
          )}
          ref={box}
          aria-label="Ruby"
          aria-controls={browsing !== null ? listId : open !== null ? completionId : undefined}
          aria-activedescendant={
            browsing !== null ? (chosen === -1 ? undefined : rowId(listId, chosen)) : picked === -1 ? undefined : rowId(completionId, picked)
          }
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          value={input}
          onChange={typedInto}
          onKeyDown={keyDown}
          onBlur={() => {
            setBrowsing(null)
            setCompleting(null)
            setAtEnd(false)
          }}
          onFocus={(event) => markCaret(event.currentTarget)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          // A click puts the caret somewhere else, which may be off the word.
          onClick={(event) => {
            setCompleting(null)
            markCaret(event.currentTarget)
          }}
          onKeyUp={(event) => markCaret(event.currentTarget)}
          onSelect={(event) => markCaret(event.currentTarget)}
          onScroll={(event) => {
            if (highlighted.current !== null) highlighted.current.scrollTop = event.currentTarget.scrollTop
          }}
        />
      </div>
      <div className="flex h-5 flex-none items-center gap-3 px-3">
        <div
          className={cn("min-w-0 flex-auto truncate text-xs @container", notice === null ? "text-faint" : notice.error ? "text-error" : "text-muted")}
          role="status"
        >
          {notice?.reason ?? (
            // The hints do not wrap: a drawer too narrow for them clips the last ones.
            <ul className="flex gap-3 overflow-hidden whitespace-nowrap" aria-live="off">{keyHints()}</ul>
          )}
        </div>
        {actions}
      </div>
    </div>
  )
}

/** One key hint: the key drawn as a chip, and what it does. */
function Hint({ keys, children }: { keys: string; children: ReactNode }) {
  return (
    <li className="flex-none">
      <kbd className="rounded border border-border px-1 font-mono text-muted">{keys}</kbd> {children}
    </li>
  )
}

/** Whether nothing before the caret is a line break. */
function caretOnFirstLine({ value, selectionStart }: HTMLTextAreaElement) {
  return !value.slice(0, selectionStart).includes("\n")
}

/** Whether the caret is at the end of the text with nothing selected. */
function caretAtEnd({ selectionStart, selectionEnd, value }: HTMLTextAreaElement) {
  return selectionStart === selectionEnd && selectionEnd === value.length
}

/** → or End alone. */
function takesSuggestion(event: KeyboardEvent) {
  return (event.key === "ArrowRight" || event.key === "End") && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing
}

/** Ctrl-C alone, which is not the Mac's copy: that is ⌘C. */
function isCtrlC(event: KeyboardEvent) {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c"
}
