import type { ReactNode } from "react"

import { cn } from "../lib/cn"
import { methodCategory } from "../lib/format"

/**
 * A request's method in the colour of its `methodCategory`, read off the `data-method` it
 * writes beside it. A *Run row*'s kind is not one — it is not a method to begin with.
 */
export function MethodText({
  method,
  className,
  children,
}: {
  method: string | null
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        "data-[method=get]:text-accent data-[method=post]:text-method-post data-[method=put-patch]:text-method-put-patch data-[method=delete]:text-method-delete data-[method=other]:text-foreground",
        className,
      )}
      data-method={methodCategory(method)}
    >
      {children}
    </span>
  )
}
