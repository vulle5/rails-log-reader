import { useContext, useEffect, useId, useMemo, useState } from "react"

import type { EvaluationRow } from "../../../../shared/activity"
import { runningPid, type EntryRow, type ExitedState, type ReplSnapshot, type ReplState } from "../../../../shared/repl"
import { ColumnHeading } from "../../../components/Column"
import { MatchesBadge } from "../../../components/MatchesBadge"
import { Tag } from "../../../components/Tag"
import type { CompletionTrigger } from "../../../hooks/completion-trigger"
import { SearchContext } from "../../../hooks/search"
import { cn } from "../../../lib/cn"
import type { DetailTabId } from "../../detail-column/components/DetailTabs"
import { useInputHistory } from "../hooks/input-history"
import type { ReplHandle } from "../hooks/repl-session"
import { useUnseenResult, type UnseenResult } from "../hooks/unseen-result"
import { transcriptMatches } from "../lib/entry-matches"
import { ReplPrompt } from "./ReplPrompt"
import { Transcript, type Reveal } from "./Transcript"

/**
 * The *REPL* drawer: an outlined panel under the Console and the Activity table, headed "REPL"
 * the way a column is. The header is the same element open or folded, and folding drops only
 * the body. Folded, the whole header opens it; its fold button is the keyboard's way in.
 *
 * A folded header carries the *Unseen result* after the name: a `new` mark, in the error colour
 * when the latest unseen evaluation raised or lost its console process. After it, it counts the
 * *Search* matches the *Transcript* would light, the fold button's description. Nothing here
 * unfolds the drawer.
 *
 * The header's right side is the status slot, before the fold button: what the console
 * process is doing, open or folded. The body is the *Transcript* over the prompt, with how the
 * console process exited between them once it has, and Restart at the end of the prompt's hint
 * row. While the drawer is open it asks for the console process to be started. On a page that
 * may not act it says where Ruby can be run from instead, and asks for nothing.
 */
export function ReplDrawer({
  folded,
  onFold,
  onUnfold,
  repl,
  railsRoot,
  actsOnlyFrom,
  completionTrigger,
  historySuggestion,
  reveal,
  onRevealed,
  entryRows,
  onShowRow,
  className,
}: {
  folded: boolean
  onFold: () => void
  onUnfold: () => void
  repl: ReplHandle
  /** The live Run's `rails_root`, which tells the Host app's own frames of an error's backtrace from a gem's. */
  railsRoot: string | null
  /** Where acts can be made from, when this page is not there, else `null`. */
  actsOnlyFrom: string | null
  /** What opens the prompt's completion popover. */
  completionTrigger: CompletionTrigger
  /** Whether the prompt offers the *History suggestion*. */
  historySuggestion: boolean
  /** The *Transcript* entry to scroll to, once the drawer is open, and what is told once it has. */
  reveal: Reveal | null
  onRevealed: () => void
  /** Each *Transcript* evaluation's *Evaluation row*, by its entry's id, and what selects one on a Detail tab. */
  entryRows: ReadonlyMap<number, EntryRow>
  onShowRow: (row: EvaluationRow, tab: DetailTabId) => void
  className?: string
}) {
  const body = useId()
  const badge = useId()
  const label = folded ? "Open REPL" : "Fold REPL"
  const { boot } = repl
  const history = useInputHistory(railsRoot, repl.snapshot)
  const { state } = repl.snapshot
  const unseen = useUnseenResult(repl.snapshot.transcript, folded && repl.loaded)
  const search = useContext(SearchContext)
  const { transcript } = repl.snapshot
  const found = useMemo(() => (folded ? transcriptMatches(search, transcript) : 0), [folded, search, transcript])

  useEffect(() => {
    if (!folded && actsOnlyFrom === null) boot()
  }, [folded, actsOnlyFrom, boot])

  return (
    <section
      className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-outline bg-raised", className)}
      role="region"
      aria-label="REPL"
    >
      {/* The border under the header is the body's top edge, so a folded drawer has none. The
          click is the pointer's shortcut to the fold button, which is what a keyboard reaches. */}
      <header
        className={cn(
          "flex min-h-7.5 flex-none items-center justify-between gap-3 px-3 py-1",
          folded ? "cursor-pointer hover:bg-selected" : "border-b border-border",
        )}
        onClick={folded ? onUnfold : undefined}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ColumnHeading>REPL</ColumnHeading>
          {unseen !== null && <UnseenMark result={unseen} />}
          {found > 0 && <MatchesBadge id={badge} count={found} />}
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <ReplStatus snapshot={repl.snapshot} />
          <button
            type="button"
            className="flex-none cursor-pointer rounded p-0.5 text-muted hover:bg-selected hover:text-foreground"
            aria-label={label}
            title={label}
            aria-expanded={!folded}
            aria-controls={folded ? undefined : body}
            aria-describedby={found > 0 ? badge : undefined}
            onClick={(event) => {
              event.stopPropagation()
              if (folded) onUnfold()
              else onFold()
            }}
          >
            <FoldIcon folded={folded} />
          </button>
        </div>
      </header>
      {!folded && (
        // A size container, so the Input history's list is as tall as the room over the prompt allows.
        <div className="flex min-h-0 flex-auto flex-col [container-type:size]" id={body}>
          {actsOnlyFrom === null ? (
            <>
              <Transcript
                entries={repl.snapshot.transcript}
                railsRoot={railsRoot}
                entryRows={entryRows}
                onShowRow={onShowRow}
                reveal={reveal}
                onRevealed={onRevealed}
              />
              {repl.snapshot.state.kind === "exited" && <ExitNotice state={repl.snapshot.state} />}
              <ReplPrompt
                submit={repl.submit}
                check={repl.check}
                complete={repl.complete}
                interrupt={repl.interrupt}
                refusal={repl.refusal}
                busy={state.kind === "busy"}
                history={history}
                trigger={completionTrigger}
                suggesting={historySuggestion}
                pid={runningPid(state)}
                // Keyed by the session's choice, so the toggle starts from it again whenever it changes.
                actions={<RestartControls key={String(repl.snapshot.sandbox)} sandboxed={repl.snapshot.sandbox} restart={repl.restart} />}
              />
            </>
          ) : (
            <p className="m-auto p-3 text-sm text-muted">Running Ruby needs {actsOnlyFrom}</p>
          )}
        </div>
      )}
    </section>
  )
}

/** The *Unseen result* mark. */
function UnseenMark({ result }: { result: UnseenResult }) {
  return (
    // Lowercase letters sit low in their line box, so the bottom padding is what centres them.
    <span
      className="flex-none rounded-chip bg-accent px-1 pb-[2.5px] text-2xs leading-none font-semibold text-background data-[outcome=error]:bg-error"
      data-outcome={result}
      title={result === "error" ? "An evaluation failed while this was folded" : "An evaluation finished while this was folded"}
    >
      new
    </span>
  )
}

/**
 * What the console process is doing, as text, with a dot in front that repeats it in colour,
 * and a `sandbox` tag after it while the one running is sandboxed. Nothing before one has been
 * started. A running evaluation's time climbs from when it was sent, and never turns into
 * anything else.
 */
function ReplStatus({ snapshot: { state, sandbox } }: { snapshot: ReplSnapshot }) {
  const now = useNow(state.kind === "busy")
  const text = statusText(state, now)
  if (text === null) return null

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="group flex min-w-0 items-center gap-1.5 truncate text-xs text-muted tabular-nums" data-state={state.kind}>
        <span
          className="size-2 flex-none rounded-full group-data-[state=booting]:bg-faint group-data-[state=busy]:bg-accent group-data-[state=exited]:bg-error group-data-[state=ready]:bg-ready"
          aria-hidden="true"
        />
        {text}
      </span>
      {sandbox && state.kind !== "exited" && <Tag title="Its writes roll back when it exits">sandbox</Tag>}
    </span>
  )
}

function statusText(state: ReplState, now: number) {
  switch (state.kind) {
    case "idle":
      return null
    case "booting":
      return "booting…"
    case "ready":
      return `pid ${state.pid}`
    case "busy":
      return `running ${clock(now - state.since)} · pid ${state.pid}`
    case "exited":
      return ["exited", state.code ?? state.signal].filter((part) => part !== null).join(" ")
  }
}

/** How the console process exited, or why it never started, and the latest of what it printed on stderr. */
function ExitNotice({ state }: { state: ExitedState }) {
  return (
    <div className="flex max-h-1/2 flex-none flex-col gap-1 border-t border-border px-3 py-2">
      <p className="text-sm text-error">{exitSentence(state)}</p>
      {state.stderr !== "" && (
        <pre className="min-h-0 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-muted">{state.stderr.replace(/\n$/, "")}</pre>
      )}
    </div>
  )
}

function exitSentence({ code, signal }: ExitedState) {
  if (code !== null) return `The REPL exited with status ${code}.`
  if (signal !== null) return `The REPL was ended by ${signal}.`
  return "The REPL could not start."
}

/**
 * Restart, and the sandbox toggle it applies. The toggle starts at the session's choice, and
 * changing it changes nothing until Restart.
 */
function RestartControls({ sandboxed, restart }: { sandboxed: boolean; restart: (sandbox: boolean) => void }) {
  const [sandbox, setSandbox] = useState(sandboxed)

  return (
    <div className="flex flex-none items-center gap-3 text-xs">
      <label className="flex cursor-pointer items-center gap-1 text-muted" title="Restart into bin/rails console --sandbox, whose writes roll back">
        <input type="checkbox" className="cursor-pointer accent-accent" checked={sandbox} onChange={(event) => setSandbox(event.target.checked)} />
        Sandbox
      </label>
      <button
        type="button"
        className="cursor-pointer rounded px-1 text-muted hover:bg-selected hover:text-foreground"
        title="Start a fresh console process, and clear the Transcript"
        onClick={() => restart(sandbox)}
      >
        Restart
      </button>
    </div>
  )
}

/** `ms` as minutes and seconds, `M:SS`. */
function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** The time, read again every second while `ticking`. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(tick)
  }, [ticking])

  return now
}

/**
 * The *Collapsed Console*'s icon turned on its side: the panel's edge runs along the bottom, and
 * the chevron points the way the drawer moves — down to fold, up to open.
 */
function FoldIcon({ folded }: { folded: boolean }) {
  return (
    <svg
      className="size-3.5 flex-none fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 15h18" />
      <path d={folded ? "m9 10 3-3 3 3" : "m9 8 3 3 3-3"} />
    </svg>
  )
}
