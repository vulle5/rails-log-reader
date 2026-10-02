import { useEffect, useState, type ReactNode } from "react"

import { cn } from "../lib/cn"

/** A control's size: `sm` in a *Transcript* evaluation's status strip, `md` in the *Detail column*. */
export type ControlSize = "sm" | "md"

/**
 * A copy-to-clipboard control for a block whose whole point is "paste this somewhere else": a
 * copy icon and the word. A click never copies silently: the icon turns to a check and the word to
 * "Copied" for a moment, because clicking something and seeing no reaction reads as "did that
 * work?" The text is asked for on the click. A caller places it with `className`.
 */
export function CopyButton({
  text,
  label,
  size,
  className,
}: {
  text: () => string
  label: string
  size: ControlSize
  className?: string
}) {
  const [copied, copy] = useCopy()

  return (
    <button
      type="button"
      className={cn(
        "flex flex-none cursor-pointer items-center rounded font-ui text-faint hover:bg-selected hover:text-foreground",
        size === "sm" ? "gap-1 px-1 py-0.5 text-2xs" : "gap-1.5 px-2 py-1 text-xs",
        className,
      )}
      title={label}
      aria-label={label}
      onClick={() => copy(text())}
    >
      {copied ? <CheckIcon size={size} /> : <CopyIcon size={size} />}
      {/* As wide as "Copied" whichever it says, so the confirmation never nudges anything beside it. */}
      <span className="grid text-left after:invisible after:col-start-1 after:row-start-1 after:content-['Copied']">
        <span className="col-start-1 row-start-1">{copied ? "Copied" : "Copy"}</span>
      </span>
    </button>
  )
}

function CopyIcon({ size }: { size: ControlSize }) {
  return (
    <Icon size={size}>
      <rect width="13" height="13" x="9" y="9" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  )
}

function CheckIcon({ size }: { size: ControlSize }) {
  return (
    <Icon size={size}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  )
}

/** A stroked icon the height of its button's text. */
function Icon({ size, children }: { size: ControlSize; children: ReactNode }) {
  return (
    <svg
      className={cn("flex-none fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]", size === "sm" ? "size-3" : "size-3.5")}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {children}
    </svg>
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
        <div className="float-right -mt-0.5 ml-3 flex items-center gap-3">
          {controls}
          {text !== null && <CopyButton size="md" text={() => text} label={label} />}
        </div>
      )}
      {children}
    </div>
  )
}
