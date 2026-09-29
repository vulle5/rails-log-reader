import type { ReactNode } from "react"

import { ControlButton } from "./ControlButton"

/**
 * One of a row of buttons that each show the same thing a different way, such as Pretty | Raw:
 * the one showing is pressed. A disabled one is struck through.
 */
export function ToggleButton({
  pressed,
  disabled = false,
  onClick,
  children,
}: {
  pressed: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <ControlButton
      className="disabled:cursor-default disabled:text-faint disabled:line-through aria-pressed:border-border aria-pressed:bg-selected aria-pressed:text-foreground"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </ControlButton>
  )
}

/** A row of `ToggleButton`s, named by `label`: what they each show a different way. */
export function ToggleGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-0.5" role="group" aria-label={label}>
      {children}
    </div>
  )
}
