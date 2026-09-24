import { useCallback, useState } from "react"

import type { ConsoleLine } from "../../../../shared/console"
import { SEVERITIES, type Severity } from "../../../../shared/wire"
import { Chip } from "../../../components/Chip"
import { recallPreference, rememberPreference } from "../../../lib/preference"

/**
 * Everything that thins the *Console*, in one place — so "what is the rail showing?" has one
 * answer rather than one per axis, and adding a third would not be a third piece of state in
 * the Reader.
 *
 * There are two axes, and they start from opposite ends for the same reason.
 *
 * **Level.** Nothing is off. A floor above `debug` — the obvious default, and the one every
 * log viewer ships — would hide the developer's own `Rails.logger.debug` calls, which is the
 * exact failure the Console exists to prevent.
 *
 * **Source.** Rails' own lines are off. In a real dev app they *are* the log — `Started
 * GET`, `Processing by`, `Rendering`, `Completed 200 OK`, and an *Echo* under every query —
 * and a rail that opens on them buries the handful of lines you wrote, which is the same
 * failure arriving from the other direction. Hidden is never dropped: the fold still holds
 * every one, the *Detail column* still shows them inline with the request's queries, and one
 * chip brings them back. `Started GET` is still all a request that died before reaching a
 * controller ever says about itself — it is one click away rather than in your way.
 *
 * Both are remembered as what is **off**, never as what is on: a level — or a source — this
 * Reader has never heard of is then shown by whatever it is upgraded into, rather than
 * silently missing from a list written before it existed.
 */

export type ConsoleFilter = {
  /** Levels turned off by hand. Empty on a Reader nobody has told otherwise. */
  hiddenLevels: ReadonlySet<Severity>
  /** Whether Rails' own lines show. `false` until somebody asks for them. */
  showingRails: boolean
}

export const CONSOLE_FILTER_ON_OPEN: ConsoleFilter = { hiddenLevels: new Set(), showingRails: false }

/**
 * What the chips currently say, as one string — the same string `remember` writes, because
 * one encoding with two readers is one fewer thing to keep in step.
 *
 * The second reader is the Console's *auto-scroll*, and it wants one thing only: a chip going
 * off or on re-derives the whole rail rather than appending to it, so the lines that appear
 * are old ones and counting them as arrivals would be the pill saying something false.
 */
export function consoleFilterKey(filter: ConsoleFilter) {
  return JSON.stringify(stored(filter))
}

export function linesShown(lines: readonly ConsoleLine[], filter: ConsoleFilter) {
  return lines.filter((line) => {
    const { severity, source } = line.event.payload
    if (source === "rails" && !filter.showingRails) return false
    return !filter.hiddenLevels.has(severity)
  })
}

/**
 * The chips' state, persisted the moment it changes. A filter re-set on every reload is one
 * nobody uses — the Reader is reopened constantly, once per restart of whatever it is
 * watching.
 */
export function useConsoleFilter() {
  const [filter, setFilter] = useState<ConsoleFilter>(recall)

  const change = useCallback((how: (filter: ConsoleFilter) => ConsoleFilter) => {
    setFilter((previous) => {
      const next = how(previous)
      remember(next)
      return next
    })
  }, [])

  const toggleLevel = useCallback(
    (level: Severity) =>
      change((previous) => {
        const hiddenLevels = new Set(previous.hiddenLevels)
        if (!hiddenLevels.delete(level)) hiddenLevels.add(level)
        return { ...previous, hiddenLevels }
      }),
    [change],
  )

  const toggleRails = useCallback(
    () => change((previous) => ({ ...previous, showingRails: !previous.showingRails })),
    [change],
  )

  return { filter, toggleLevel, toggleRails }
}

type ConsoleFiltersProps = {
  filter: ConsoleFilter
  onToggleLevel: (level: Severity) => void
  onToggleRails: () => void
}

/**
 * Two groups and not one row of seven chips: a level and a source are different questions
 * about a line, and a control that read as one list would invite `warn` and `rails` to be
 * compared. The rule between them is what says they are two. Each is a toggle rather than a
 * tab, because they are not alternatives — every combination of them is a reading somebody
 * wants.
 */
export function ConsoleFilters({ filter, onToggleLevel, onToggleRails }: ConsoleFiltersProps) {
  return (
    <div className="flex flex-none flex-wrap items-center gap-x-2 gap-y-0.5">
      <div className="flex flex-wrap gap-0.5" role="group" aria-label="Filter by level">
        {SEVERITIES.map((level) => (
          <Chip
            key={level}
            named={level}
            kind={`level-${level}`}
            showing={!filter.hiddenLevels.has(level)}
            title={`Lines logged at ${level}`}
            onToggle={() => onToggleLevel(level)}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-0.5 border-l border-border pl-2" role="group" aria-label="Filter by source">
        <Chip
          named="rails"
          kind="source-rails"
          showing={filter.showingRails}
          title="Lines Rails wrote, rather than the app — off by default, because there are far more of them"
          onToggle={onToggleRails}
        />
      </div>
    </div>
  )
}

/**
 * Anything unreadable — absent, blocked, corrupt, or written by a Reader that filtered on
 * something this one has never heard of — falls back to the opening filter rather than to
 * nothing, so a bad key costs the reader their chips and never their Console.
 */
function recall(): ConsoleFilter {
  return recallPreference("console-filter", CONSOLE_FILTER_ON_OPEN, (remembered) => {
    const stored: unknown = JSON.parse(remembered)
    if (stored === null || typeof stored !== "object") return CONSOLE_FILTER_ON_OPEN

    const { levelsOff, rails } = stored as { levelsOff?: unknown; rails?: unknown }
    return {
      hiddenLevels: new Set(
        (Array.isArray(levelsOff) ? levelsOff : []).filter((level): level is Severity =>
          SEVERITIES.includes(level as Severity),
        ),
      ),
      showingRails: rails === true,
    }
  })
}

/**
 * The remembered shape, sorted — so one filter is one string whatever order the chips were
 * clicked in, which is what lets `consoleFilterKey` be an identity rather than a history.
 */
function stored(filter: ConsoleFilter) {
  return { levelsOff: [...filter.hiddenLevels].sort(), rails: filter.showingRails }
}

function remember(filter: ConsoleFilter) {
  rememberPreference("console-filter", consoleFilterKey(filter))
}
