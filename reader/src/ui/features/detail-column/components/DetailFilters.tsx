import { useCallback, useContext, useState } from "react"

import type { ActivityRow, TimelineEvent } from "../../../../shared/activity"
import type { SqlEvent } from "../../../../shared/wire"
import { Chip } from "../../../components/Chip"
import { SearchContext, type Search } from "../../../hooks/search"
import { recallPreference, rememberPreference } from "../../../lib/preference"
import { queryMatches } from "../lib/timeline-matches"

/**
 * Everything that thins the *Detail column*, on the axis `ConsoleFilters` does not touch. A
 * Console line is thinned by who logged it; a Detail column entry by what kind of query it is.
 * One setting applies to every row kind's timeline and trailing section alike.
 *
 * - **`cache`** hides queries the query cache answered. `development.log` shows them, prefixed
 *   `CACHE`, but none of them reached the database.
 * - **`schema`** hides `SCHEMA` and `EXPLAIN` queries, which
 *   `ActiveRecord::LogSubscriber::IGNORE_PAYLOAD_NAMES` drops before `development.log` is
 *   written to, while `SqlSubscriber` forwards them anyway.
 *
 * Neither starts off: the column opens on everything it holds. A chip turned off hides; it
 * never drops — a hidden query is still on `row.timeline`, still in the Sidecar, and back the
 * moment its chip is turned on.
 *
 * Remembered as what is **off**, as the Console's chips are, so a kind of query this Reader
 * learns later arrives shown.
 *
 * Each chip counts the queries of its kind the selected row holds, its trailing section
 * included, on or off. Off, it also counts the *Search* matches inside the queries it hides,
 * by the rule their entries light by — so the number is what lights when it is turned on. A
 * match never turns a chip back on.
 */

export const QUERY_KINDS = ["cache", "schema"] as const

export type QueryKind = (typeof QUERY_KINDS)[number]

/** The two names `IGNORE_PAYLOAD_NAMES` drops, spelled out once rather than imported: the
 * Reader has no dependency on Rails to import them from. */
const SCHEMA_NAMES: ReadonlySet<string> = new Set(["SCHEMA", "EXPLAIN"])

export type DetailFilter = {
  /** Kinds of query turned off by hand. Empty on a Reader nobody has told otherwise. */
  hiddenKinds: ReadonlySet<QueryKind>
}

export const DETAIL_FILTER_ON_OPEN: DetailFilter = { hiddenKinds: new Set() }

/**
 * What the chips currently say, as one string — the same string `remember` writes — fed into
 * the Detail column's *auto-scroll* `listing` alongside the selected row's id, the way
 * `consoleFilterKey` feeds the Console's. A toggle inserts and removes entries throughout the
 * timeline rather than only appending, so a paused column must not read the ones it reveals as
 * arrivals — but it is never by itself a reason to refollow: the timeline is the same one
 * thinned, exactly the "same stream thinned" case a Console chip already is, and only a new
 * Selection reopens at the newest activity.
 */
export function detailFilterKey(filter: DetailFilter) {
  return JSON.stringify(stored(filter))
}

/** A query can be of both kinds — a cached SCHEMA query — and either chip off hides it. */
function isOfKind(event: TimelineEvent, kind: QueryKind): event is SqlEvent {
  if (event.type !== "sql") return false
  if (kind === "cache") return event.payload.cached
  return event.payload.name !== null && SCHEMA_NAMES.has(event.payload.name)
}

export function eventsShown(events: readonly TimelineEvent[], filter: DetailFilter) {
  const hidden = [...filter.hiddenKinds]
  if (hidden.length === 0) return events
  return events.filter((event) => !hidden.some((kind) => isOfKind(event, kind)))
}

/**
 * The chips' state, persisted the moment it changes — for the reason `useConsoleFilter`'s is:
 * a filter re-set on every reload is one nobody uses.
 */
export function useDetailFilter() {
  const [filter, setFilter] = useState<DetailFilter>(recall)

  const toggleKind = useCallback((kind: QueryKind) => {
    setFilter((previous) => {
      const hiddenKinds = new Set(previous.hiddenKinds)
      if (!hiddenKinds.delete(kind)) hiddenKinds.add(kind)
      const next = { hiddenKinds }
      remember(next)
      return next
    })
  }, [])

  return { filter, toggleKind }
}

const CHIP_TITLES: Record<QueryKind, string> = {
  cache: "Cached queries — answered by the query cache, without reaching the database",
  schema: "SCHEMA and EXPLAIN queries — the ones development.log never shows",
}

type Tally = { count: number; matches: number }

/** Everything `row`'s Detail column holds: its timeline, then its trailing section, which a Run row has none of. */
export function eventsHeld(row: ActivityRow): readonly TimelineEvent[] {
  return row.kind === "run" ? row.timeline : [...row.timeline, ...row.trailing]
}

/**
 * Each kind's count in everything `row`'s Detail column holds, and the matches inside it while
 * its chip is off. A query of both kinds is counted on both chips, its matches included while
 * both are off, so a match neither chip alone would reveal is still said on each.
 */
function tallies(row: ActivityRow, filter: DetailFilter, search: Search) {
  const held = eventsHeld(row)
  return Object.fromEntries(
    QUERY_KINDS.map((kind): [QueryKind, Tally] => {
      const ofKind = held.filter((event) => isOfKind(event, kind))
      const matches = filter.hiddenKinds.has(kind) ? ofKind.reduce((count, query) => count + queryMatches(search, query), 0) : 0
      return [kind, { count: ofKind.length, matches }]
    }),
  ) as Record<QueryKind, Tally>
}

type DetailFiltersProps = {
  /** The selected row, whose queries the chips count. No count while nothing is selected. */
  row: ActivityRow | null
  filter: DetailFilter
  onToggleKind: (kind: QueryKind) => void
}

/**
 * One group: there is only the one axis here, unlike the Console's two. Counted on every
 * render: the fold grows a row in place, so a count memoised on the row would go stale.
 */
export function DetailFilters({ row, filter, onToggleKind }: DetailFiltersProps) {
  const search = useContext(SearchContext)
  const tally = row === null ? null : tallies(row, filter, search)

  return (
    <div className="flex flex-none items-center">
      <div className="flex flex-wrap gap-0.5" role="group" aria-label="Filter by query kind">
        {QUERY_KINDS.map((kind) => (
          <Chip
            key={kind}
            named={kind}
            kind={kind}
            showing={!filter.hiddenKinds.has(kind)}
            title={CHIP_TITLES[kind]}
            count={tally?.[kind].count}
            matches={tally?.[kind].matches}
            onToggle={() => onToggleKind(kind)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Anything unreadable — absent, blocked, or corrupt — is the opening filter. Without a
 * `kindsOff`, a stored `showingSchema` is read instead: `false` is `schema` off, and anything
 * else is shown.
 */
function recall(): DetailFilter {
  return recallPreference("detail-filter", DETAIL_FILTER_ON_OPEN, (remembered) => {
    const stored: unknown = JSON.parse(remembered)
    if (stored === null || typeof stored !== "object") return DETAIL_FILTER_ON_OPEN

    const { kindsOff, showingSchema } = stored as { kindsOff?: unknown; showingSchema?: unknown }
    if (Array.isArray(kindsOff)) {
      return { hiddenKinds: new Set(kindsOff.filter((kind): kind is QueryKind => QUERY_KINDS.includes(kind))) }
    }
    return { hiddenKinds: new Set<QueryKind>(showingSchema === false ? ["schema"] : []) }
  })
}

/**
 * The remembered shape, sorted — so one filter is one string whatever order the chips were
 * clicked in, which is what lets `detailFilterKey` be an identity rather than a history.
 */
function stored(filter: DetailFilter) {
  return { kindsOff: [...filter.hiddenKinds].sort() }
}

function remember(filter: DetailFilter) {
  rememberPreference("detail-filter", detailFilterKey(filter))
}
