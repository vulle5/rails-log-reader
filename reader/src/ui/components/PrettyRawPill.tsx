import type { ReactNode } from "react"

import { cn } from "../lib/cn"
import type { ControlSize } from "./CopyButton"

/**
 * Pretty | Raw as a pill, named by `label`: what they each show a different way. The pressed
 * half is filled and the other faint. Pretty is disabled, and struck through, when `prettyDisabled`.
 */
export function PrettyRawPill({
  label,
  raw,
  onRaw,
  size,
  prettyDisabled = false,
}: {
  label: string
  raw: boolean
  onRaw: (raw: boolean) => void
  size: ControlSize
  prettyDisabled?: boolean
}) {
  return (
    <div
      className={cn("inline-flex flex-none rounded-full bg-sunken font-ui", size === "sm" ? "p-px text-2xs" : "p-0.5 text-xs")}
      role="group"
      aria-label={label}
    >
      <PillHalf size={size} pressed={!raw} disabled={prettyDisabled} onClick={() => onRaw(false)}>
        Pretty
      </PillHalf>
      <PillHalf size={size} pressed={raw} onClick={() => onRaw(true)}>
        Raw
      </PillHalf>
    </div>
  )
}

function PillHalf({
  size,
  pressed,
  disabled = false,
  onClick,
  children,
}: {
  size: ControlSize
  pressed: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={cn(
        "cursor-pointer rounded-full text-faint enabled:hover:text-foreground aria-pressed:bg-selected aria-pressed:text-foreground",
        "disabled:cursor-default disabled:line-through",
        size === "sm" ? "px-2 leading-4" : "px-3 py-0.5",
      )}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
