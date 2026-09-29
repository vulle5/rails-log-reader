import { useId } from "react"

import { ColumnHeading } from "../../../components/Column"
import { cn } from "../../../lib/cn"

/**
 * The *REPL* drawer: an outlined panel under the Console and the Activity table, headed "REPL"
 * the way a column is. The header is the same element open or folded, and folding drops only
 * the body. Folded, the whole header opens it; its fold button is the keyboard's way in.
 *
 * The header's right side is the status slot, before the fold button.
 */
export function ReplDrawer({
  folded,
  onFold,
  onUnfold,
  className,
}: {
  folded: boolean
  onFold: () => void
  onUnfold: () => void
  className?: string
}) {
  const body = useId()
  const label = folded ? "Open REPL" : "Fold REPL"

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
        <div className="flex min-h-0 flex-auto items-center justify-center p-3 text-sm text-muted" id={body}>
          The REPL's prompt and transcript go here.
        </div>
      )}
    </section>
  )
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
