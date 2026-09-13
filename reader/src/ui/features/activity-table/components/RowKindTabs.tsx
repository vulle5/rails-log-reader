import type { ActivityRow } from "../../../../shared/activity"

/**
 * The Activity table's tabs, which filter by **row kind and nothing else**: Requests, Runs,
 * All. Never by method, status or controller — v1 rules those out, and a tab that grew one
 * of them would be that exclusion returning by drift rather than by decision.
 *
 * Each carries a count of everything of its kind the Reader holds, whichever tab is showing,
 * so switching tabs never changes a number and the counts read as "what is here" rather than
 * "what is on screen".
 *
 * Nothing here filters by Run: previous Runs stay visible on open, because the file is a
 * record of what happened and the Run before the restart is usually the one you are looking
 * for.
 */

/**
 * What a tab filters to: a row's own `kind`, or the way out of both. Taken from `ActivityRow`
 * rather than spelled again, so the tabs and the rows cannot drift into two vocabularies for
 * one thing — and so a third kind of row would be a tab that fails to compile rather than one
 * that quietly filters nothing.
 */
export type RowKindFilter = ActivityRow["kind"] | "all"

/** The order they are read in: the two kinds, then the way out of both. */
const TABS: readonly [RowKindFilter, string][] = [
  ["request", "Requests"],
  ["run", "Runs"],
  ["all", "All"],
]

export function rowsOfKind(rows: readonly ActivityRow[], filter: RowKindFilter) {
  if (filter === "all") return rows
  return rows.filter((row) => showsRow(filter, row))
}

/**
 * Whether a filter is showing one particular row. Read by the *Console*, whose click has to
 * clear a filter that is hiding the row it is jumping to — and asked of the filter rather
 * than of the DOM, because "is it on screen" and "is it rendered at all" are two questions
 * and this is the second one.
 */
export function showsRow(filter: RowKindFilter, row: ActivityRow) {
  return filter === "all" || filter === row.kind
}

type RowKindTabsProps = {
  /** Every row the Reader holds, unfiltered: the counts are of these and not of what shows. */
  rows: readonly ActivityRow[]
  showing: RowKindFilter
  onShow: (filter: RowKindFilter) => void
}

export function RowKindTabs({ rows, showing, onShow }: RowKindTabsProps) {
  // One pass for all three, rather than one filter per tab: at the Memory bound's rows this
  // is read on every fold, and three of the four passes were counting the same array again.
  const counted = { request: 0, run: 0, all: rows.length }
  for (const row of rows) counted[row.kind] += 1

  return (
    <div className="row-kind-tabs" role="tablist" aria-label="Filter by row kind">
      {TABS.map(([kind, name]) => (
        <button
          key={kind}
          type="button"
          role="tab"
          aria-selected={kind === showing}
          className={kind === showing ? "row-kind-tab row-kind-tab-showing" : "row-kind-tab"}
          onClick={() => onShow(kind)}
        >
          {name}
          <span className="tab-count">{counted[kind]}</span>
        </button>
      ))}
    </div>
  )
}
