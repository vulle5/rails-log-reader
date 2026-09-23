import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * The theme's own names that tailwind-merge cannot place by their shape alone, and so would
 * keep beside the class that overrides them. Kept in step with `@theme` in `reader.css`, whose
 * sizes set no line height — so a size never drops a `leading-*` beside it.
 */
const twMerge = extendTailwindMerge({
  override: {
    conflictingClassGroups: { "font-size": [] },
  },
  extend: {
    theme: {
      radius: ["chip"],
      leading: ["sql"],
      shadow: ["pill", "dialog", "pinned", "pinned-row", "interrupted"],
    },
  },
})

/**
 * The classes given, joined, with the falsy ones skipped and any a later class overrides
 * dropped — so a component's caller can add to its classes or replace one of them.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
