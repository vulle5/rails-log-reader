import { useEffect, useId, useState } from "react"

import type { ReplState } from "../../../../shared/repl"
import { ColumnHeading } from "../../../components/Column"
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
 * process is doing, open or folded. The body is the *Transcript* over the prompt. While the
 * drawer is open it asks for the console process to be started. On a page that may not act it
 * says where Ruby can be run from instead, and asks for nothing.
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
          <ReplStatus state={repl.snapshot.state} />
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
              <ReplPrompt submit={repl.submit} refusal={repl.refusal} />
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
 * What the console process is doing, as text, with a dot in front that repeats it in colour.
 * Nothing before one has been started. A running evaluation's time climbs from when it was
 * sent, and never turns into anything else.
 */
function ReplStatus({ state }: { state: ReplState }) {
  const now = useNow(state.kind === "busy")
  const text = statusText(state, now)
  if (text === null) return null

  return (
    <span className="group flex min-w-0 items-center gap-1.5 truncate text-xs text-muted tabular-nums" data-state={state.kind}>
      <span
        className="size-2 flex-none rounded-full group-data-[state=booting]:bg-faint group-data-[state=busy]:bg-accent group-data-[state=exited]:bg-error group-data-[state=ready]:bg-ready"
        aria-hidden="true"
      />
      {text}
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
      return state.code === null ? "exited" : `exited ${state.code}`
  }
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
