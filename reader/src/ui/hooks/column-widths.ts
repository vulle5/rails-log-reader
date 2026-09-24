import { useLayoutEffect, useState, type RefObject } from "react"

import { recallPreference, rememberPreference } from "../lib/preference"

/**
 * The widths the two *Column dividers* set: the Console's and the Detail column's. The
 * Activity table is never sized — it takes whatever the other two leave.
 *
 * A width the developer set is a *request*, remembered across reloads; what is drawn is that
 * request fitted to the width the Reader has. Only a gesture on a divider changes a request,
 * never the window changing size. A column with no request is at its default: the Console at
 * `CONSOLE_DEFAULT`, the Detail column at `DETAIL_DEFAULT_SHARE` of the available width, so it
 * keeps that share as the window resizes.
 *
 * The Console can also be folded into a *Collapsed Console*: a `COLLAPSED` strip, which hands
 * the rest of its width to the Activity table. The developer's fold is remembered across
 * reloads, and keeps the Console's request, so unfolding reopens it at the width it had.
 *
 * A window narrower than the three columns' minimums folds the Console too, for only as long
 * as it stays that narrow: that fold is never remembered, and unfolding the Console inside it
 * opens it at its minimum until the window next widens past them. Narrower still than the
 * strip and the other two minimums, the grid keeps `minWidth` and the Reader scrolls sideways.
 *
 * Requests are read synchronously on mount and the available width is measured before paint,
 * so the first frame is already the remembered layout.
 */

export const MINIMUM = { console: 240, activity: 360, detail: 380 } as const

/** The width of the *Collapsed Console*'s strip. */
export const COLLAPSED = 32

const CONSOLE_DEFAULT = 360
const DETAIL_DEFAULT_SHARE = 0.4

export type SizedColumn = "console" | "detail"

const SETTING = { console: "console-width", detail: "detail-width" } as const

type Requests = Record<SizedColumn, number | null>

/** One sized column as drawn: its width, and how far its divider can move it. */
export type DrawnColumn = {
  width: number
  min: number
  max: number
  /** Requests `width`, held between the column's minimum and `max`. */
  resize: (width: number) => void
  /** Drops the request, so the column returns to its default. */
  reset: () => void
}

/** The Console as drawn: `width` is what it opens at, and is kept while it is folded. */
export type DrawnConsole = DrawnColumn & {
  collapsed: boolean
  collapse: () => void
  expand: () => void
}

export type ColumnWidths = {
  console: DrawnConsole
  detail: DrawnColumn
  /** The grid's `grid-template-columns`: the Console's track, the Activity table's, the Detail column's. */
  template: string
  /** The narrowest the grid is drawn: every column at its drawn width, the Activity table at its minimum. */
  minWidth: number
}

const ALL_MINIMUMS = MINIMUM.console + MINIMUM.activity + MINIMUM.detail

/** `viewport` is the element whose width the three columns share. */
export function useColumnWidths(viewport: RefObject<HTMLElement | null>): ColumnWidths {
  const [available, setAvailable] = useState(() => window.innerWidth)
  const [requests, setRequests] = useState<Requests>(() => ({ console: recall("console"), detail: recall("detail") }))
  const [folded, setFolded] = useState(recallCollapsed)
  // Unfolded by the developer while the window was folding it.
  const [openedWhileNarrow, setOpenedWhileNarrow] = useState(false)

  useLayoutEffect(() => {
    // `innerWidth` while there is no grid to measure — the refusal screen — or it measures as
    // nothing, the way it does in a DOM with no layout.
    const measure = () => setAvailable(viewport.current?.clientWidth || window.innerWidth)
    measure()

    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [viewport])

  const narrow = available < ALL_MINIMUMS
  if (openedWhileNarrow && !narrow) setOpenedWhileNarrow(false)
  const collapsed = folded || (narrow && !openedWhileNarrow)

  const drawn = fit(available, requests, collapsed)

  function request(column: SizedColumn, width: number | null) {
    rememberPreference(SETTING[column], width === null ? null : String(width))
    setRequests((previous) => ({ ...previous, [column]: width }))
  }

  function sized(column: SizedColumn): DrawnColumn {
    const { width, max } = drawn[column]
    const min = MINIMUM[column]
    return {
      width,
      min,
      max,
      resize: (to) => request(column, clamp(Math.round(to), min, max)),
      reset: () => request(column, null),
    }
  }

  function fold(to: boolean) {
    rememberPreference("console-collapsed", to ? "true" : null)
    setFolded(to)
    setOpenedWhileNarrow(!to && narrow)
  }

  const console = sized("console")
  const detail = sized("detail")
  const consoleTrack = collapsed ? COLLAPSED : console.width
  return {
    console: { ...console, collapsed, collapse: () => fold(true), expand: () => fold(false) },
    detail,
    template: `${consoleTrack}px minmax(0,1fr) ${detail.width}px`,
    minWidth: consoleTrack + MINIMUM.activity + detail.width,
  }
}

/**
 * Each request held between its column's minimum and the room left once the other columns
 * have theirs. The Console gives way before the Detail column: the Detail column's room
 * assumes the Console at its minimum — the strip, while it is folded — and the Console's room
 * is what the drawn Detail column leaves.
 */
function fit(available: number, requests: Requests, collapsed: boolean) {
  const detailRoom = Math.max(MINIMUM.detail, available - (collapsed ? COLLAPSED : MINIMUM.console) - MINIMUM.activity)
  const detail = clamp(requests.detail ?? Math.round(available * DETAIL_DEFAULT_SHARE), MINIMUM.detail, detailRoom)

  const consoleRoom = Math.max(MINIMUM.console, available - detail - MINIMUM.activity)
  const console = clamp(requests.console ?? CONSOLE_DEFAULT, MINIMUM.console, consoleRoom)

  // A divider moves only its own column, so the Detail column's maximum leaves the drawn
  // Console where it is rather than pushing it narrower.
  return {
    console: { width: console, max: consoleRoom },
    detail: {
      width: detail,
      max: Math.max(MINIMUM.detail, available - (collapsed ? COLLAPSED : console) - MINIMUM.activity),
    },
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function recall(column: SizedColumn) {
  return recallPreference<number | null>(SETTING[column], null, (stored) => {
    const width = Number(stored)
    if (!Number.isFinite(width)) throw new Error(`not a width: ${stored}`)
    return width
  })
}

function recallCollapsed() {
  return recallPreference("console-collapsed", false, (stored) => stored === "true")
}
