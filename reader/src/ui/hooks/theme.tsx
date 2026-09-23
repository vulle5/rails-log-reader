import { useEffect, useLayoutEffect, useState } from "react"

/**
 * Light and dark are both required — standing constraint 5 — and the Reader follows the OS
 * unless told otherwise, because it is read beside a terminal and an editor that already do.
 * The override is remembered, for the reason the Console's chips are: the Reader is reopened
 * once per restart of whatever it is watching, and a choice re-made on every reload is one
 * nobody makes.
 *
 * What the stylesheet reads is `data-theme` on `<html>`, always `light` or `dark` — never
 * `system`, which is a choice and not a theme. The first one is set by the inline script in
 * `index.html`, before the stylesheet applies and long before this module loads, so the first
 * paint is already the right one. That script makes the same decision as `paintedTheme`
 * below, from the same key; this module takes over once React is up, and is what keeps
 * following the OS as it changes.
 */

export type ThemeChoice = "light" | "dark" | "system"

const CHOICES: readonly { choice: ThemeChoice; named: string; title: string }[] = [
  { choice: "light", named: "Light", title: "Always light" },
  { choice: "dark", named: "Dark", title: "Always dark" },
  { choice: "system", named: "System", title: "Follow the OS" },
]

/** The same key `index.html`'s inline script reads — the two are one decision, made twice. */
const REMEMBERED = "rails-log-reader.theme"

const OS_PREFERS_DARK = "(prefers-color-scheme: dark)"

function paintedTheme(choice: ThemeChoice, osPrefersDark: boolean) {
  if (choice !== "system") return choice
  return osPrefersDark ? "dark" : "light"
}

/**
 * The choice, what the OS currently prefers, and the theme the two make — kept on `<html>`.
 * The OS is listened to whatever the choice is, rather than only while it is `system`, so
 * going back to following it lands on what the OS says *now* and not on what it said when the
 * Reader opened.
 */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(recall)
  const [osPrefersDark, setOsPrefersDark] = useState(() => window.matchMedia(OS_PREFERS_DARK).matches)

  useEffect(() => {
    const os = window.matchMedia(OS_PREFERS_DARK)
    const follow = (change: { matches: boolean }) => setOsPrefersDark(change.matches)

    os.addEventListener("change", follow)
    return () => os.removeEventListener("change", follow)
  }, [])

  const theme = paintedTheme(choice, osPrefersDark)

  // Before the browser paints, so a change of theme is never a frame of the old one.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  function choose(next: ThemeChoice) {
    setChoice(next)
    remember(next)
  }

  return { choice, choose }
}

type ThemeSwitchProps = {
  choice: ThemeChoice
  onChoose: (choice: ThemeChoice) => void
}

/**
 * Three buttons and not a toggle: following the OS is a choice of its own, not an absence of one.
 * Styled as the Activity table's row-kind tabs are, because it is the same kind of control: one
 * of a few, exactly one of them in force.
 */
export function ThemeSwitch({ choice, onChoose }: ThemeSwitchProps) {
  return (
    <div className="flex flex-none gap-0.5" role="group" aria-label="Theme">
      {CHOICES.map((each) => (
        <button
          key={each.choice}
          type="button"
          className="cursor-pointer rounded border border-transparent bg-transparent px-2 py-0.5 text-xs text-muted hover:bg-raised aria-pressed:border-border aria-pressed:bg-selected aria-pressed:text-foreground aria-pressed:hover:bg-raised"
          aria-pressed={each.choice === choice}
          title={each.title}
          onClick={() => onChoose(each.choice)}
        >
          {each.named}
        </button>
      ))}
    </div>
  )
}

/**
 * Guarded as the Console's filter is: `localStorage` throws outright in a browser with site
 * data blocked. Anything unreadable — absent, blocked, or a theme this Reader has never heard
 * of — is following the OS, which is what the inline script will have painted for it too.
 */
function recall(): ThemeChoice {
  try {
    const remembered = window.localStorage.getItem(REMEMBERED)
    return remembered === "light" || remembered === "dark" ? remembered : "system"
  } catch {
    return "system"
  }
}

function remember(choice: ThemeChoice) {
  try {
    window.localStorage.setItem(REMEMBERED, choice)
  } catch {
    // Nothing to do and nothing to say: the theme still changes for this session.
  }
}
