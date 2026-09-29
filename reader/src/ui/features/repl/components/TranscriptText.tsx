import type { ReactNode } from "react"

import { cn } from "../../../lib/cn"

/** Text as it was written, its line breaks kept and its long lines wrapped. */
export function Text({ className, children }: { className?: string; children: ReactNode }) {
  return <pre className={cn("break-words whitespace-pre-wrap", className)}>{children}</pre>
}

/** What marks an input or a result, left out of what a screen reader reads and a copy takes. */
export function Marker({ children }: { children: string }) {
  return (
    <span className="text-faint select-none" aria-hidden="true">
      {children}
    </span>
  )
}

/** A line saying what was cut. */
export function Cut({ children }: { children: string }) {
  return <p className="font-ui text-xs text-faint">{children}</p>
}

/** A line saying what went wrong, in the error colour. */
export function ErrorNote({ children }: { children: string }) {
  return <p className="font-ui text-error">{children}</p>
}
