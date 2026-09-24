import { useState } from "react"

import type { ConsoleLine } from "../../../../shared/console"
import { cn } from "../../../lib/cn"

/**
 * The two controls of the *Collapsed Console*: the button in the Console's header that folds
 * it, and the strip it folds into, which is one button that reopens it.
 */

export function CollapseConsoleButton({ onCollapse }: { onCollapse: () => void }) {
  return (
    <button
      type="button"
      className="flex-none cursor-pointer rounded p-0.5 text-muted hover:bg-selected hover:text-foreground"
      aria-label="Collapse Console"
      title="Collapse Console"
      onClick={onCollapse}
    >
      <CollapseIcon />
    </button>
  )
}

/**
 * The *Unseen count*: how many of `showing` — the lines the Console's chips show — were not
 * held when `counting` last turned on: when the Console folded, or, for a Console that opens
 * folded, when the load-on-open history is all here. Zero while it is not counting, and
 * turning it off forgets what it had seen, so the next fold counts afresh.
 *
 * Counted against the lines still held, so a line the *Memory bound* evicts comes off it.
 */
export function useUnseenCount(
  held: readonly ConsoleLine[],
  showing: readonly ConsoleLine[],
  counting: boolean,
) {
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null)

  // Adjusted while rendering, so the render that folds the Console is the one that starts the count.
  if (counting && seen === null) setSeen(new Set(held.map((line) => line.id)))
  if (!counting && seen !== null) setSeen(null)

  if (!counting || seen === null) return 0
  return showing.filter((line) => !seen.has(line.id)).length
}

/**
 * The folded Console: a region still named "Console", so it is found where the Console was,
 * holding nothing but the strip. None of the Console's lines are rendered while it is folded.
 * The strip carries the *Unseen count*, uncoloured by level, and capped at "99+" where it is drawn.
 */
export function CollapsedConsole({ unseen, onExpand }: { unseen: number; onExpand: () => void }) {
  const label = unseen === 0 ? "Expand Console" : `Expand Console, ${unseen} unseen ${unseen === 1 ? "line" : "lines"}`

  return (
    <section className="min-h-0 min-w-0 border-r border-border bg-sunken" role="region" aria-label="Console" data-column="console">
      <button
        type="button"
        className="flex size-full cursor-pointer flex-col items-center gap-2 py-2 text-muted hover:bg-selected hover:text-foreground"
        aria-label={label}
        title={label}
        onClick={onExpand}
      >
        {/* Mirrored, so its chevron points out of the strip: the way the Console opens. */}
        <CollapseIcon className="-scale-x-100" />
        {unseen > 0 && (
          <span className="rounded-full bg-border px-1 text-[0.625rem] leading-4 font-semibold text-foreground tabular-nums">
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
        <span className="text-xs font-semibold tracking-wider uppercase [writing-mode:vertical-rl]">Console</span>
      </button>
    </section>
  )
}

function CollapseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn(
        "size-3.5 flex-none fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]",
        className,
      )}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </svg>
  )
}
