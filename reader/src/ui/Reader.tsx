import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

import type { ActivityRow } from "../shared/activity"
import type { ConsoleLine } from "../shared/console"
import type { EmptyState, Mismatch } from "../shared/initializer-status"
import { WIRE_VERSION } from "../shared/wire"
import { isWireVersionUnderstood } from "../shared/wire-compatibility"
import { ActivityTable, rowSelector } from "./features/activity-table/components/ActivityTable"
import { useAutoScroll, type ColumnAutoScroll } from "./hooks/auto-scroll"
import {
  ConsoleFilters,
  consoleFilterKey,
  linesShown,
  useConsoleFilter,
} from "./features/console/components/ConsoleFilters"
import { ConsoleRail } from "./features/console/components/ConsoleRail"
import { detailItems, DetailColumn } from "./features/detail-column/components/DetailColumn"
import { DetailFilters, detailFilterKey, useDetailFilter } from "./features/detail-column/components/DetailFilters"
import { EmptyReader } from "./features/setup-status/components/EmptyReader"
import { HoverGrouping } from "./HoverGrouping"
import { InitializerBanner, UnsupportedWireScreen } from "./features/setup-status/components/InitializerMismatch"
import type { RepairState } from "./features/setup-status/lib/initializer-repair"
import type { EarlierState } from "./hooks/live"
import { LoadEarlier } from "./features/activity-table/components/LoadEarlier"
import { RowKindTabs, rowsOfKind, showsRow, type RowKindFilter } from "./features/activity-table/components/RowKindTabs"
import { SearchBox, SearchContext, useSearch } from "./hooks/search"
import { ThemeSwitch, useTheme } from "./hooks/theme"

/**
 * The Reader's three persistent columns. All three are present from the first paint and
 * are sized by the grid rather than by their contents, so filling one never reflows the
 * others — including the Detail column, which holds a placeholder until something is
 * selected rather than appearing when it is.
 *
 * The Activity table is present with no rows in it rather than absent until there are some,
 * for the same reason: the first request of the session must not be the thing that
 * introduces a header row and pushes the layout around.
 *
 * Selection lives here, between the columns it joins — a row clicked in the Activity table
 * or a line clicked in the Console is what the detail column shows. Selecting deliberately
 * does *not* touch the Activity table beyond marking the row and, for a Console click,
 * jumping to it: you have to scroll up to click a moving row anyway, and that scroll has
 * already paused it.
 *
 * Each column follows new activity on its own — three *auto-scrolls*, one rule, no shared
 * state — which is why the three hooks are here rather than inside the three columns: what
 * each of them is following is what this component decided to show, thinned by this
 * component's filters. Everything they may not do is in `auto-scroll.ts`.
 *
 * Rows and Console lines are passed in rather than subscribed to here: the live Sidecar is
 * `main.tsx`'s business, which keeps this component mountable over a seeded fold. The
 * version-mismatch props below (#29) are the same idea applied to the Initializer's own
 * status: `main.tsx` owns the fetch and the `EventSource`, and everything here is a pure
 * render of whatever it was handed, defaulting to "nothing wrong" so a seeded fold with no
 * opinion about the Initializer renders exactly as it always has.
 */
type ReaderProps = {
  rows?: readonly ActivityRow[]
  /** Every App log event, in append order: the *Console*'s own fold, not this one's rows. */
  lines?: readonly ConsoleLine[]
  /**
   * How many rows the *Memory bound* has evicted, ever. Fed to the Activity table's and the
   * Console's auto-scrolls, and to neither of the other two — see `AutoScrollOptions.evicted`.
   */
  evictedRows?: number
  /** File-on-disk vs. process-still-running, from `detectMismatch`. */
  mismatch?: Mismatch
  /** `v` off the most recently observed envelope, whichever process wrote it. */
  liveWireVersion?: number | null
  repairState?: RepairState
  onRepair?: () => void
  onDismissRepair?: () => void
  /** Whether there is anything before the history the fold holds, and whether it is coming. */
  earlier?: EarlierState
  onLoadEarlier?: () => void
  /** Why there is nothing to show, from `detectEmptyState` — `null` while that is not known. */
  emptyState?: EmptyState | null
}

export function Reader({
  rows = [],
  lines = [],
  evictedRows = 0,
  mismatch = { kind: "none" },
  liveWireVersion = null,
  repairState = { phase: "idle" },
  onRepair = () => {},
  onDismissRepair = () => {},
  earlier = { available: false, loading: false },
  onLoadEarlier = () => {},
  emptyState = null,
}: ReaderProps) {
  // *Selection* is a row's `id` rather than the row, because rows mutate in place and are
  // replaced wholesale on eviction: holding the id means the detail column follows the row
  // it named, and shows the placeholder again if that row is ever no longer there.
  const [selected, setSelected] = useState<string | null>(null)
  const showing = rows.find((row) => row.id === selected) ?? null

  // The tab filter lives here rather than inside the table for the same reason Selection
  // does: #25's Console click has to be able to clear a filter that is hiding the row it is
  // jumping to, and "take me there" is a promise neither a filter nor a scroll position may
  // break. Nothing filters by Run — previous Runs stay visible on open.
  const [showingKind, setShowingKind] = useState<RowKindFilter>("all")
  const { filter, toggleLevel, toggleRails } = useConsoleFilter()
  const { filter: detailFilter, toggleSchema } = useDetailFilter()

  // The search is here for the reason the filters are, and is the one thing here that is not
  // one: it reaches every column through context and changes what they *mark*, never what
  // they show — so it is handed to none of the auto-scrolls below, which follow what is shown.
  const [term, setTerm] = useState("")
  const search = useSearch(term)
  // Up here with the other hooks, and not only where its switch is drawn: the refusal screen
  // below returns before the bar exists, and the theme still has to follow the OS behind it.
  const theme = useTheme()

  // *Hover grouping*'s two states, and the reason they are two. `hovered` is lost the moment
  // the mouse moves — which is exactly what happens next — so a click leaves `pinned` behind
  // it, and the pinned group stays lit through every line the pointer crosses afterwards. A
  // pin a passing hover could put out would not be a pin.
  //
  // The *rule*, unlike the lighting, is one line's: it is drawn from whichever line the eye
  // is on, which is the hovered one while there is one and the pinned one the rest of the
  // time.
  const [hovered, setHovered] = useState<ConsoleLine | null>(null)
  const [pinned, setPinned] = useState<ConsoleLine | null>(null)
  const drawnFrom = hovered ?? pinned

  // What each column is actually showing, which is what each column is actually following.
  const showingRows = rowsOfKind(rows, showingKind)
  const showingLines = linesShown(lines, filter)

  // The three auto-scrolls. Each is handed how much its column is rendering and what it is
  // listing — a Console filter, a row-kind tab, a Selection and a Detail filter — and nothing
  // else: there is no event and no state anywhere else in the Reader that may pause or resume
  // one of them.
  //
  // Only the Detail column ever refollows on its own, and only on a new *Selection*
  // (`refollowsWhen`) — another row's timeline is a different thing entirely to be at the
  // bottom of. Its schema chip is folded into `listing` alongside `selected`, so toggling it
  // is still a relist and not a pile of "arrived" queries, but is never by itself a
  // `refollowsWhen` change: the chip thins the same timeline, the same "same stream thinned"
  // case a Console chip already is, and a reader who scrolled up in it is still reading where
  // they were.
  const consoleScroll = useAutoScroll({
    items: showingLines.length,
    listing: consoleFilterKey(filter),
    evicted: evictedRows,
  })
  // The Activity table's listing is its tab *and* the row it starts at, because it is the one
  // column whose list can change at the top rather than only at the bottom: a *load-earlier*
  // prepends history above the oldest row, and the *Memory bound* takes rows off the same end.
  // Neither is something that arrived below, which is the only thing the pill may count — a
  // pull that said "↓ 3 new" would be sending the reader down to find history that went up.
  const activityScroll = useAutoScroll({
    items: showingRows.length,
    listing: `${showingKind} ${showingRows[0]?.id ?? ""}`,
    evicted: evictedRows,
  })
  const detailScroll = useAutoScroll({
    items: detailItems(showing, detailFilter),
    listing: `${selected ?? ""} ${detailFilterKey(detailFilter)}`,
    refollowsWhen: selected ?? "",
  })

  // A jump is asked for rather than done on the spot: the same click can clear a tab filter,
  // and the row it is jumping to does not exist in the DOM until that render has happened.
  // An object, so clicking the same line twice jumps twice.
  const [jumpTo, setJumpTo] = useState<{ row: string } | null>(null)
  const reader = useRef<HTMLDivElement>(null)

  // After the auto-scrolls above, and deliberately: the same click can clear a tab filter,
  // which is a change of what the Activity table is showing, and a column that was following
  // sticks to its bottom on one. Landing last is what makes "take me there" win — and the
  // scroll it causes is then read like any other, so a jump to an old row pauses the table
  // exactly as scrolling to it by hand would. No second pause state, no special case.
  useLayoutEffect(() => {
    if (jumpTo === null) return

    reader.current?.querySelector(rowSelector(jumpTo.row))?.scrollIntoView({ block: "center" })
    setJumpTo(null)
  }, [jumpTo])

  /**
   * Clicking a Console line: it selects the row that printed it — its request's, or, for an
   * unattributed line, its *Run*'s — pins the group lit, and takes you to the row. If a tab
   * filter is what is hiding that row, the filter goes first: clicking means "take me
   * there", and taking you to a row you cannot see is a broken promise.
   */
  function pick(line: ConsoleLine) {
    const row = rows.find((each) => each.id === line.owner)

    setPinned(line)
    setSelected(line.owner)
    if (row !== undefined && !showsRow(showingKind, row)) setShowingKind("all")
    setJumpTo({ row: line.owner })
  }

  /** Clicking a row says nothing about the Console, so it takes the pin down rather than moving it. */
  function selectRow(id: string) {
    setSelected(id)
    setPinned(null)
  }

  // #29's one hard stop: a `v` newer than this Reader understands is a shape it has never
  // read a line from, so it declines to render any of the three columns rather than guess
  // through an unread part of that shape. Everything else — including a `v` *older* than
  // this Reader's own, which is the ordinary shape of a stale process — renders as usual.
  if (liveWireVersion !== null && !isWireVersionUnderstood(liveWireVersion)) {
    return (
      <UnsupportedWireScreen
        liveWireVersion={liveWireVersion}
        understoodVersion={WIRE_VERSION}
        repairState={repairState}
        onRepair={onRepair}
      />
    )
  }

  return (
    <div className="reader-shell">
      <InitializerBanner
        mismatch={mismatch}
        repairState={repairState}
        onRepair={onRepair}
        onDismiss={onDismissRepair}
      />
      {/* Above the three columns rather than in any one of them, because neither belongs to
          one: a term lights every column at once, and a theme paints them. */}
      <header className="reader-bar">
        <SearchBox term={term} onChange={setTerm} />
        <ThemeSwitch choice={theme.choice} onChoose={theme.choose} />
      </header>
      <SearchContext value={search}>
        <div className="reader" ref={reader}>
          <Column
            place="console"
            name="Console"
            scroll={consoleScroll}
            controls={
              <ConsoleFilters filter={filter} onToggleLevel={toggleLevel} onToggleRails={toggleRails} />
            }
          >
            <ConsoleRail
              lines={showingLines}
              pinned={pinned?.owner ?? null}
              hovered={hovered?.owner ?? null}
              onHover={setHovered}
              onPick={pick}
            />
          </Column>
          <Column
            place="activity"
            name="Activity table"
            scroll={activityScroll}
            controls={<RowKindTabs rows={rows} showing={showingKind} onShow={setShowingKind} />}
          >
            <LoadEarlier state={earlier} onLoad={onLoadEarlier} />
            <ActivityTable
              rows={showingRows}
              selected={selected}
              pinned={pinned?.owner ?? null}
              lit={hovered?.owner ?? null}
              onSelect={selectRow}
            />
            {/* Under the headings rather than in place of the table, so the first row of the
                session replaces this and moves nothing else. Empty means the Reader holds no
                rows — not that a tab is showing none of the ones it holds. */}
            {rows.length === 0 && emptyState !== null && <EmptyReader state={emptyState} />}
          </Column>
          <Column
            place="detail"
            name="Detail column"
            scroll={detailScroll}
            controls={<DetailFilters filter={detailFilter} onToggleSchema={toggleSchema} />}
          >
            <DetailColumn row={showing} filter={detailFilter} />
          </Column>
          {/* Over all three, because the rule belongs to none of them: it leaves the Console's
              gutter and lands on a row in the table beside it. `layoutKey` is everything that
              could have moved an end without changing which two ends they are. */}
          <HoverGrouping
            reader={reader}
            line={drawnFrom?.id ?? null}
            row={drawnFrom?.owner ?? null}
            layoutKey={`${showingKind} ${showingRows.length} ${showingLines.length}`}
          />
        </div>
      </SearchContext>
    </div>
  )
}

type ColumnProps = {
  place: "console" | "activity" | "detail"
  /** The glossary's name for the column: what it is headed with, and what a screen reader announces. */
  name: string
  /**
   * What sits in the heading beside the name — the Activity table's row-kind tabs and the
   * Console's level chips. In the heading and not in the body, because the body is the
   * scrollport: a filter that scrolled away with the rows it was filtering would be gone
   * exactly when it is wanted.
   */
  controls?: ReactNode
  /** This column's own *auto-scroll*: the scrollport it follows, and what the pill says. */
  scroll: ColumnAutoScroll
  children?: ReactNode
}

function Column({ place, name, controls, scroll, children }: ColumnProps) {
  return (
    <section className={`column column-${place}`} role="region" aria-label={name}>
      <header className="column-heading">
        <h2>{name}</h2>
        {controls}
      </header>
      <div className="column-body" ref={scroll.port} onScroll={scroll.onScroll}>
        {children}
      </div>
      {/* Only where there is something to go and see. A pill on a paused column with nothing
          below it would read "0 new" — sending the reader to look at nothing, and covering
          the lines they scrolled up to read while it did. Scrolling back down is the way out
          of a pause either way; the pill is what the count is for. */}
      {!scroll.following && scroll.unseen > 0 && (
        <button type="button" className="new-pill" onClick={scroll.resume} title="Follow new activity again">
          {/* `floor`: the Memory bound is evicting one row for every row it takes, so the
              count below has stalled rather than stopped — "+" says so rather than reading
              like a number that quietly froze. */}
          <span aria-hidden="true">↓</span> {scroll.unseen}
          {scroll.floor ? "+" : ""} new
        </button>
      )}
    </section>
  )
}
