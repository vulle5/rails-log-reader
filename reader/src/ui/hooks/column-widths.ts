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
 * Requests are read synchronously on mount and the available width is measured before paint,
 * so the first frame is already the remembered layout.
 */

export const MINIMUM = { console: 240, activity: 360, detail: 380 } as const

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

export type ColumnWidths = Record<SizedColumn, DrawnColumn>

/** `reader` is the element whose width the three columns share. */
export function useColumnWidths(reader: RefObject<HTMLElement | null>): ColumnWidths {
  const [available, setAvailable] = useState(() => window.innerWidth)
  const [requests, setRequests] = useState<Requests>(() => ({ console: recall("console"), detail: recall("detail") }))

  useLayoutEffect(() => {
    // `innerWidth` while there is no grid to measure — the refusal screen — or it measures as
    // nothing, the way it does in a DOM with no layout.
    const measure = () => setAvailable(reader.current?.clientWidth || window.innerWidth)
    measure()

    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [reader])

  const drawn = fit(available, requests)

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

  return { console: sized("console"), detail: sized("detail") }
}

/**
 * Each request held between its column's minimum and the room left once the other columns
 * have theirs. The Detail column gives way before the Console: the Console's room assumes the
 * Detail column at its minimum, the Detail column's room is what the drawn Console leaves.
 */
function fit(available: number, requests: Requests) {
  const consoleRoom = Math.max(MINIMUM.console, available - MINIMUM.activity - MINIMUM.detail)
  const console = clamp(requests.console ?? CONSOLE_DEFAULT, MINIMUM.console, consoleRoom)

  const detailRoom = Math.max(MINIMUM.detail, available - console - MINIMUM.activity)
  const detail = clamp(requests.detail ?? Math.round(available * DETAIL_DEFAULT_SHARE), MINIMUM.detail, detailRoom)

  // A divider moves only its own column, so the Console's maximum leaves the drawn Detail
  // column where it is rather than pushing it narrower.
  return {
    console: { width: console, max: Math.max(MINIMUM.console, available - detail - MINIMUM.activity) },
    detail: { width: detail, max: detailRoom },
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
