import { useEffect, useState } from "react"

/**
 * A copy-to-clipboard control for a block whose whole point is "paste this somewhere else" —
 * always present, at reduced opacity, so it never competes with the text it copies, and
 * solidifying on hover or focus the way it is reached. A click never copies silently: the
 * label swaps to a brief confirmation, because clicking something and seeing no reaction
 * reads as "did that work?"
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  // The confirmation is a fact about time passing since the last successful copy, not about
  // the click itself — so it is this effect, and not the click handler, that owns clearing it.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  async function onClick() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Nothing to confirm — the confirmation would itself be the lie the copy button
      // exists to avoid.
    }
  }

  return (
    // Wide enough for "Copied" as well as "Copy", so the confirmation never nudges anything
    // beside it. The opacity dims the border and background along with the label, and goes no
    // lower than this, or "reduced" starts reading as "gone" rather than as "not yet what you're
    // looking at".
    <button
      type="button"
      className="absolute top-1.5 right-2 min-w-13 cursor-pointer rounded border border-border bg-raised px-2 py-0.5 font-ui text-xs text-foreground opacity-70 hover:opacity-100 focus-visible:opacity-100"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  )
}
