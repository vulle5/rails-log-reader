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
 * The folded Console: a region still named "Console", so it is found where the Console was,
 * holding nothing but the strip. None of the Console's lines are rendered while it is folded.
 */
export function CollapsedConsole({ onExpand }: { onExpand: () => void }) {
  return (
    <section className="min-h-0 min-w-0 border-r border-border bg-sunken" role="region" aria-label="Console" data-column="console">
      <button
        type="button"
        className="flex size-full cursor-pointer flex-col items-center gap-2 py-2 text-muted hover:bg-selected hover:text-foreground"
        aria-label="Expand Console"
        title="Expand Console"
        onClick={onExpand}
      >
        {/* Mirrored, so its chevron points out of the strip: the way the Console opens. */}
        <CollapseIcon className="-scale-x-100" />
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
