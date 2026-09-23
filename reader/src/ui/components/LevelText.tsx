import type { ReactNode } from "react"

import { cn } from "../lib/cn"

/**
 * Text in the colour of its line's level, read off the `data-level` on the nearest `group`
 * around it — a Console line, or a log line in the Detail column.
 */
export function LevelText({
  className,
  title,
  children,
}: {
  className?: string
  title?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        "group-data-[level=warn]:text-warn group-data-[level=error]:text-error group-data-[level=fatal]:text-error",
        className,
      )}
      title={title}
    >
      {children}
    </span>
  )
}
