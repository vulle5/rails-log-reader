import type { ReactNode } from "react"

/**
 * A mark set into a log line beside its message: one of the app's own `log_tags`, or the
 * Console's `rails` on a line Rails wrote.
 */
export function Tag({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <span className="flex-none rounded-chip border border-border bg-raised px-1 font-mono text-2xs text-muted" title={title}>
      {children}
    </span>
  )
}
