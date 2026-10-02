import type { ComponentProps } from "react"

import { cn } from "../lib/cn"

/**
 * A small worded button that takes you somewhere in the Reader, such as Show in REPL: accent
 * text, underlined while hovered, as a link reads. A caller adds to its look with `className`.
 */
export function LinkButton({ className, ...props }: ComponentProps<"button">) {
  return <button type="button" className={cn("cursor-pointer font-ui text-xs text-accent hover:underline", className)} {...props} />
}
