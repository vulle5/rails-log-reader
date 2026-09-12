import { useCallback, useState } from "react"

import type { TimelineEvent } from "../shared/activity"
import { Chip } from "./Chip"

/**
 * The *Detail column*'s one thinning — #54's fix for the axis `ConsoleFilters` does not touch.
 * A Console line is thinned by who logged it; a Detail column entry is thinned by whether
 * `development.log` would ever have shown it at all.
 *
 * `SCHEMA` and `EXPLAIN` queries are the ones it would not have:
 * `ActiveRecord::LogSubscriber::IGNORE_PAYLOAD_NAMES` drops them before a line is ever
 * written, so a request with no cache miss never sees one there. `SqlSubscriber` forwards
 * them anyway, on purpose — the rare "why was the first request after a restart the slow
 * one" question is one only the dropped ones answer. That question is now one chip away
 * instead of in the way of every ordinary request's timeline.
 *
 * Off by default, for the reason `ConsoleFilters`' `showingRails` is: `development.log` is
 * the baseline every developer already knows this column by, and SCHEMA rows are the one
 * respect in which the unfiltered timeline showed *more* than that baseline, not less.
 *
 * Nothing is dropped by this filter — a hidden query is still on `row.timeline`, still in the
 * Sidecar, and still reachable the moment the chip is turned on, the same guarantee
 * `ConsoleFilters` gives Rails' own lines.
 */

const REMEMBERED = "rails-log-reader.detail-filter"

/** The two names `IGNORE_PAYLOAD_NAMES` drops, spelled out once rather than imported: the
 * Reader has no dependency on Rails to import them from. */
const HIDDEN_NAMES: ReadonlySet<string> = new Set(["SCHEMA", "EXPLAIN"])

export type DetailFilter = {
  /** Whether SCHEMA/EXPLAIN queries show. `false` until somebody asks for them. */
  showingSchema: boolean
}

export const DETAIL_FILTER_ON_OPEN: DetailFilter = { showingSchema: false }

/**
 * What the chip currently says, as one string — fed into the Detail column's *auto-scroll*
 * `listing` alongside the selected row's id, the same way `consoleFilterKey` feeds the
 * Console's. A toggle inserts and removes rows throughout the timeline rather than only
 * appending, so a paused column must not read the ones it reveals as arrivals — but it is
 * never by itself a reason to refollow: the timeline is the same one thinned, exactly the
 * "same stream thinned" case a Console chip already is, and only a new Selection reopens at
 * the newest activity.
 */
export function detailFilterKey(filter: DetailFilter) {
  return JSON.stringify(filter)
}

/** A query this filter hides is one `development.log` would never have shown either. */
function isHidden(event: TimelineEvent, filter: DetailFilter) {
  if (filter.showingSchema || event.type !== "sql") return false
  return event.payload.name !== null && HIDDEN_NAMES.has(event.payload.name)
}

export function eventsShown(events: readonly TimelineEvent[], filter: DetailFilter) {
  return events.filter((event) => !isHidden(event, filter))
}

/**
 * The chip's state, persisted the moment it changes — for the reason `useConsoleFilter`'s is:
 * a filter re-set on every reload is one nobody uses.
 */
export function useDetailFilter() {
  const [filter, setFilter] = useState<DetailFilter>(recall)

  const toggleSchema = useCallback(() => {
    setFilter((previous) => {
      const next = { showingSchema: !previous.showingSchema }
      remember(next)
      return next
    })
  }, [])

  return { filter, toggleSchema }
}

type DetailFiltersProps = {
  filter: DetailFilter
  onToggleSchema: () => void
}

/** One chip, in its own group: there is only the one axis here, unlike the Console's two. */
export function DetailFilters({ filter, onToggleSchema }: DetailFiltersProps) {
  return (
    <div className="detail-filters">
      <div className="chips" role="group" aria-label="Filter by query kind">
        <Chip
          named="schema"
          kind="schema"
          showing={filter.showingSchema}
          title="SCHEMA and EXPLAIN queries — off by default, because development.log never shows them either"
          onToggle={onToggleSchema}
        />
      </div>
    </div>
  )
}

/**
 * Every read and write is guarded, for the reason `ConsoleFilters`' `recall`/`remember` are:
 * `localStorage` throws outright with site data blocked, and a Reader that cannot remember a
 * filter must still show the Detail column.
 */
function recall(): DetailFilter {
  try {
    const remembered = localStorage.getItem(REMEMBERED)
    if (remembered === null) return DETAIL_FILTER_ON_OPEN

    const stored: unknown = JSON.parse(remembered)
    if (stored === null || typeof stored !== "object") return DETAIL_FILTER_ON_OPEN

    const { showingSchema } = stored as { showingSchema?: unknown }
    return { showingSchema: showingSchema === true }
  } catch {
    return DETAIL_FILTER_ON_OPEN
  }
}

function remember(filter: DetailFilter) {
  try {
    localStorage.setItem(REMEMBERED, detailFilterKey(filter))
  } catch {
    // Nothing to do and nothing to say: the chip still works for this session.
  }
}
