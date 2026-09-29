import { useEffect, useState, type ReactNode } from "react"

import { cn } from "../lib/cn"
import { ControlButton } from "./ControlButton"

/**
 * A copy-to-clipboard control for a block whose whole point is "paste this somewhere else",
 * drawn as the controls beside it are. A click never copies silently: the label swaps to a
 * brief confirmation, because clicking something and seeing no reaction reads as "did that
 * work?" Anchored to the top right of the nearest positioned block; a caller moves it with
 * `className`.
 */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, copy] = useCopy()

  return (
    // Wide enough for "Copied" as well as "Copy", so the confirmation never nudges anything
    // beside it. Bordered, so it reads as a button beside toggles that are not pressed.
    <ControlButton className={cn("absolute top-1.5 right-2 min-w-13 border-border", className)} title={label} aria-label={label} onClick={() => copy(text)}>
      {copied ? "Copied" : "Copy"}
    </ControlButton>
  )
}

/**
 * A copy control belonging to one line of a list or tree: a small word, `idle`, drawn only while
 * its line is hovered or it is focused, and for as long as its confirmation lasts. The line is
 * the nearest `group/line`. `line` is the id of the line's own text, which describes the control
 * so a screen reader says which line it copies. The text is asked for on the click, so a copy is
 * never written until it is wanted.
 */
export function LineCopy({ label, idle, text, line }: { label: string; idle: string; text: () => string; line?: string }) {
  const [copied, copy] = useCopy()
  return (
    <button
      className={cn(
        "ml-2 cursor-pointer font-ui text-2xs text-faint hover:text-foreground hover:underline",
        // A confirmation stays drawn for as long as it lasts, hovered or not.
        "opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 data-copied:opacity-100",
      )}
      type="button"
      aria-label={label}
      aria-describedby={line}
      data-copied={copied || undefined}
      onClick={() => copy(text())}
    >
      {copied ? "Copied" : idle}
    </button>
  )
}

/**
 * Whether a copy just succeeded, and the copy itself. `copied` holds for a moment after the
 * clipboard took the text, and never after a copy that failed.
 */
export function useCopy() {
  const [copied, setCopied] = useState(false)

  // The confirmation is a fact about time passing since the last successful copy, not about
  // the click itself — so it is this effect, and not the click handler, that owns clearing it.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Nothing to confirm — the confirmation would itself be the lie the copy button
      // exists to avoid.
    }
  }

  return [copied, copy] as const
}

/**
 * A block with one copy control for the whole of it, on its first line at its right edge, with
 * `controls` before it. The block's first lines wrap short of them, and the lines under them
 * run the block's whole width. No text, no copy control.
 */
export function Copyable({
  text,
  label,
  controls,
  children,
}: {
  text: string | null
  label: string
  controls?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flow-root">
      {(text !== null || controls !== undefined) && (
        // Centred on the block's first line.
        <div className="float-right -mt-0.5 ml-3 flex gap-4">
          {controls}
          {text !== null && <CopyButton className="static" text={text} label={label} />}
        </div>
      )}
      {children}
    </div>
  )
}
