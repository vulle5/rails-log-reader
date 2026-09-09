import { useCallback, useState } from "react"

import type { ConsoleLine } from "../shared/console"
import type { Severity } from "../shared/wire"

/**
 * The Console's only thinning: one chip per level, every one of them on.
 *
 * Volume in the Console is a **level** problem and never an attribution one. A floor above
 * `debug` — the obvious default, and the one every log viewer ships — would hide the
 * developer's own `Rails.logger.debug` calls, which is the exact failure the Console exists
 * to prevent. So nothing starts off, and what is turned off is turned off by hand and
 * remembered.
 *
 * Remembered as the levels that are **off**, not the ones that are on: a level this Reader
 * has never heard of is then shown by whatever it is upgraded into, rather than silently
 * missing from a list written before it existed.
 */

/** Every level the wire can carry, quietest first. Fixed, so the chips never move. */
const LEVELS: readonly Severity[] = ["debug", "info", "warn", "error", "fatal", "unknown"]

const REMEMBERED = "rails-log-reader.console-levels-off"

export function linesOfLevel(lines: readonly ConsoleLine[], hidden: ReadonlySet<Severity>) {
  if (hidden.size === 0) return lines
  return lines.filter((line) => !hidden.has(line.event.payload.severity))
}

/**
 * The chips' state, persisted the moment it changes. A filter re-set on every reload is one
 * nobody uses — the Reader is reopened constantly, once per restart of whatever it is
 * watching.
 */
export function useHiddenLevels() {
  const [hidden, setHidden] = useState<ReadonlySet<Severity>>(recall)

  const toggle = useCallback((level: Severity) => {
    setHidden((previous) => {
      const next = new Set(previous)
      if (!next.delete(level)) next.add(level)
      remember(next)
      return next
    })
  }, [])

  return { hidden, toggle }
}

type LevelChipsProps = {
  hidden: ReadonlySet<Severity>
  onToggle: (level: Severity) => void
}

export function LevelChips({ hidden, onToggle }: LevelChipsProps) {
  return (
    <div className="level-chips" role="group" aria-label="Filter by level">
      {LEVELS.map((level) => {
        const showing = !hidden.has(level)
        return (
          <button
            key={level}
            type="button"
            // A toggle rather than a tab: the levels are not alternatives, and any
            // combination of them is a reading somebody wants.
            aria-pressed={showing}
            className={showing ? `level-chip level-chip-${level}` : `level-chip level-chip-${level} level-chip-off`}
            onClick={() => onToggle(level)}
          >
            {level}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Every read and write is guarded: `localStorage` throws outright in a browser with site
 * data blocked, and a Reader that cannot remember a filter must still show the log.
 */
function recall(): ReadonlySet<Severity> {
  try {
    const remembered = localStorage.getItem(REMEMBERED)
    if (remembered === null) return new Set()

    const levels: unknown = JSON.parse(remembered)
    if (!Array.isArray(levels)) return new Set()
    return new Set(levels.filter((level): level is Severity => LEVELS.includes(level as Severity)))
  } catch {
    return new Set()
  }
}

function remember(hidden: ReadonlySet<Severity>) {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify([...hidden]))
  } catch {
    // Nothing to do and nothing to say: the chips still work for this session.
  }
}
