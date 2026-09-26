import type { ComponentProps } from "react"

import { cn } from "../../../lib/cn"

/**
 * The quiet badge for a fact that is never an alarm: a *Partial request*, a reopened Run row,
 * the *last row standing*, how many *Table columns* are hidden. Unlike the *Run marker*'s bold
 * accent line, which is a boundary rather than an absence or an overage.
 */
export function Badge({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn("rounded-chip border border-border px-1 font-ui text-2xs tracking-wider text-faint uppercase", className)}
      {...props}
    />
  )
}
