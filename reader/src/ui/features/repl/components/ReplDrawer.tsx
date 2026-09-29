import { useEffect, useId, useState } from "react"

import type { ExitedState, ReplSnapshot, ReplState } from "../../../../shared/repl"
import { ColumnHeading } from "../../../components/Column"
import { Tag } from "../../../components/Tag"
import { cn } from "../../../lib/cn"
import type { ReplHandle } from "../hooks/repl-session"
import { ReplPrompt } from "./ReplPrompt"
import { Transcript } from "./Transcript"

/**
 * The *REPL* drawer: an outlined panel under the Console and the Activity table, headed "REPL"
 * the way a column is. The header is the same element open or folded, and folding drops only
 * the body. Folded, the whole header opens it; its fold button is the keyboard's way in.
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
  actsOnlyFrom,
  className,
}: {
  folded: boolean
  onFold: () => void
  onUnfold: () => void
  repl: ReplHandle
  /** Where acts can be made from, when this page is not there, else `null`. */
  actsOnlyFrom: string | null
  className?: string
}) {
  const body = useId()
  const label = folded ? "Open REPL" : "Fold REPL"
  const { boot } = repl

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
          folded ? "cursor-pointer hover:bg-sunken" : "border-b border-border",
        )}
        onClick={folded ? onUnfold : undefined}
      >
        <ColumnHeading>REPL</ColumnHeading>
        <div className="flex min-w-0 items-center gap-3">
          <ReplStatus snapshot={repl.snapshot} />
          <button
            type="button"
            className="flex-none cursor-pointer rounded p-0.5 text-muted hover:bg-selected hover:text-foreground"
            aria-label={label}
            title={label}
            aria-expanded={!folded}
            aria-controls={folded ? undefined : body}
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
        <div className="flex min-h-0 flex-auto flex-col" id={body}>
          {actsOnlyFrom === null ? (
            <>
              <Transcript entries={repl.snapshot.transcript} />
              {repl.snapshot.state.kind === "exited" && <ExitNotice state={repl.snapshot.state} />}
              <ReplPrompt
                submit={repl.submit}
                interrupt={repl.interrupt}
                refusal={repl.refusal}
                busy={repl.snapshot.state.kind === "busy"}
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
