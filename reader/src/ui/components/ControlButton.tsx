import type { ComponentProps } from "react"

import { cn } from "../lib/cn"

/**
 * A small worded button beside the thing it acts on, such as Pretty | Raw or Copy: muted text
 * with no fill until hovered. A caller adds to its look with `className`.
 */
export function ControlButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "cursor-pointer rounded border border-transparent px-2 py-0.5 font-ui text-xs text-muted not-aria-pressed:enabled:hover:bg-sunken not-aria-pressed:enabled:hover:text-foreground",
        className,
      )}
      {...props}
    />
  )
}
