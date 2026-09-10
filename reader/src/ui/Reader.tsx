import { useState, type ReactNode } from "react"

import type { ActivityRow } from "../shared/activity"
import type { Mismatch } from "../shared/initializer-status"
import { WIRE_VERSION } from "../shared/wire"
import { isWireVersionUnderstood } from "../shared/wire-compatibility"
import { ActivityTable } from "./ActivityTable"
import { DetailColumn } from "./DetailColumn"
import { InitializerBanner, UnsupportedWireScreen } from "./InitializerMismatch"
import type { RepairState } from "./initializer-repair"
import { LoadEarlier, type EarlierState } from "./LoadEarlier"
import { RowKindTabs, rowsOfKind, type RowKindFilter } from "./RowKindTabs"

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
 * Selection lives here, between the two columns it joins — clicking a row in the Activity
 * table is what the detail column shows. Selecting deliberately does *not* touch the
 * Activity table beyond marking the row: you have to scroll up to click a moving row anyway,
 * and that scroll has already paused it.
 *
 * Rows are passed in rather than subscribed to here: the live Sidecar is `main.tsx`'s
 * business, which keeps this component mountable over a seeded fold. The version-mismatch
 * props below (#29) are the same idea applied to the Initializer's own status: `main.tsx`
 * owns the fetch and the `EventSource`, and everything here is a pure render of whatever it
 * was handed, defaulting to "nothing wrong" so a seeded fold with no opinion about the
 * Initializer renders exactly as it always has.
 */
type ReaderProps = {
  rows?: readonly ActivityRow[]
  /** File-on-disk vs. process-still-running, from `detectMismatch`. */
  mismatch?: Mismatch
  /** `v` off the most recently observed envelope, whichever process wrote it. */
  liveWireVersion?: number | null
  repairState?: RepairState
  onRepair?: () => void
  onDismissRepair?: () => void
  /** Whether there is anything before the window the fold holds, and whether it is on its way. */
  earlier?: EarlierState
  onLoadEarlier?: () => void
}

export function Reader({
  rows = [],
  mismatch = { kind: "none" },
  liveWireVersion = null,
  repairState = { phase: "idle" },
  onRepair = () => {},
  onDismissRepair = () => {},
  earlier = { available: false, loading: false },
  onLoadEarlier = () => {},
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
      <div className="reader">
        <Column place="console" name="Console" />
        <Column
          place="activity"
          name="Activity table"
          controls={<RowKindTabs rows={rows} showing={showingKind} onShow={setShowingKind} />}
        >
          <LoadEarlier state={earlier} onLoad={onLoadEarlier} />
          <ActivityTable rows={rowsOfKind(rows, showingKind)} selected={selected} onSelect={setSelected} />
        </Column>
        <Column place="detail" name="Detail column">
          <DetailColumn row={showing} />
        </Column>
      </div>
    </div>
  )
}

type ColumnProps = {
  place: "console" | "activity" | "detail"
  /** The glossary's name for the column: what it is headed with, and what a screen reader announces. */
  name: string
  /**
   * What sits in the heading beside the name — the Activity table's row-kind tabs, today.
   * In the heading and not in the body, because the body is the scrollport: a filter that
   * scrolled away with the rows it was filtering would be gone exactly when it is wanted.
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
