import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

import type { ActivityRow } from "../shared/activity"
import type { ConsoleLine } from "../shared/console"
import type { Mismatch } from "../shared/initializer-status"
import { WIRE_VERSION } from "../shared/wire"
import { isWireVersionUnderstood } from "../shared/wire-compatibility"
import { ActivityTable, rowSelector } from "./ActivityTable"
import { ConsoleFilters, linesShown, useConsoleFilter } from "./ConsoleFilters"
import { ConsoleRail } from "./ConsoleRail"
import { DetailColumn } from "./DetailColumn"
import { HoverGrouping } from "./HoverGrouping"
import { InitializerBanner, UnsupportedWireScreen } from "./InitializerMismatch"
import type { RepairState } from "./initializer-repair"
import { RowKindTabs, rowsOfKind, showsRow, type RowKindFilter } from "./RowKindTabs"

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
  /** File-on-disk vs. process-still-running, from `detectMismatch`. */
  mismatch?: Mismatch
  /** `v` off the most recently observed envelope, whichever process wrote it. */
  liveWireVersion?: number | null
  repairState?: RepairState
  onRepair?: () => void
  onDismissRepair?: () => void
}

export function Reader({
  rows = [],
  lines = [],
  mismatch = { kind: "none" },
  liveWireVersion = null,
  repairState = { phase: "idle" },
  onRepair = () => {},
  onDismissRepair = () => {},
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

  // A jump is asked for rather than done on the spot: the same click can clear a tab filter,
  // and the row it is jumping to does not exist in the DOM until that render has happened.
  // An object, so clicking the same line twice jumps twice.
  const [jumpTo, setJumpTo] = useState<{ row: string } | null>(null)
  const reader = useRef<HTMLDivElement>(null)

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

  const showingRows = rowsOfKind(rows, showingKind)
  const showingLines = linesShown(lines, filter)

  return (
    <div className="reader-shell">
      <InitializerBanner
        mismatch={mismatch}
        repairState={repairState}
        onRepair={onRepair}
        onDismiss={onDismissRepair}
      />
      <div className="reader" ref={reader}>
        <Column
          place="console"
          name="Console"
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
          controls={<RowKindTabs rows={rows} showing={showingKind} onShow={setShowingKind} />}
        >
          <ActivityTable
            rows={showingRows}
            selected={selected}
            pinned={pinned?.owner ?? null}
            lit={hovered?.owner ?? null}
            onSelect={selectRow}
          />
        </Column>
        <Column place="detail" name="Detail column">
          <DetailColumn row={showing} />
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
  children?: ReactNode
}

function Column({ place, name, controls, children }: ColumnProps) {
  return (
    <section className={`column column-${place}`} role="region" aria-label={name}>
      <header className="column-heading">
        <h2>{name}</h2>
        {controls}
      </header>
      <div className="column-body">{children}</div>
    </section>
  )
}
