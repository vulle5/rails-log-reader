import { useLayoutEffect, useState, type RefObject } from "react"

import { GAP } from "../../../hooks/column-widths"
import { recallPreference, rememberPreference } from "../../../lib/preference"

/**
 * The *REPL* drawer's height and fold, under the Console and the Activity table.
 *
 * Sized the way a *Column divider* sizes a column: a height the developer set is a *request*,
 * remembered across reloads, and what is drawn is that request fitted to the height the Reader
 * has, leaving the columns above at least `ABOVE_MINIMUM`. Only a gesture on the drawer's top
 * edge changes the request, never the window changing size. With no request the drawer is at
 * `DEFAULT`. A window too short for even the drawer's minimum beside the columns' keeps
 * `minHeight`, and the Reader scrolls.
 *
 * Folded, the drawer is its header alone, `FOLDED` tall, and keeps its request, so opening it
 * reopens it at the height it had. The fold is remembered across reloads, and a first visit
 * starts folded. Nothing but the developer folds or opens it.
 *
 * Read synchronously on mount and measured before paint, so the first frame is already the
 * remembered layout.
 */

export const MINIMUM = 120

/** The height of the folded drawer: its header, and the border around it. */
export const FOLDED = 32

/** The least the Console and the Activity table are drawn above an open drawer. */
const ABOVE_MINIMUM = 160

const DEFAULT = 288

/** The grid's padding above and under the rows, and the drawer's top edge between them. */
const GAPS_HEIGHT = 3 * GAP

export type ReplDrawer = {
  /** The drawer's height while it is open, which it keeps while it is folded. */
  height: number
  min: number
  max: number
  /** Requests `height`, held between the minimum and `max`. */
  resize: (height: number) => void
  /** Drops the request, so the drawer returns to its default height. */
  reset: () => void
  folded: boolean
  fold: () => void
  unfold: () => void
  /** The grid's `grid-template-rows`: the columns' row, the top edge's, the drawer's. */
  template: string
  /** The shortest the grid is drawn: the columns at their minimum, the drawer as drawn, and the gaps. */
  minHeight: number
}

/** `viewport` is the element whose height the columns, the drawer and their gaps share. */
export function useReplDrawer(viewport: RefObject<HTMLElement | null>): ReplDrawer {
  const [available, setAvailable] = useState(() => window.innerHeight - GAPS_HEIGHT)
  const [request, setRequest] = useState(recallHeight)
  const [folded, setFolded] = useState(recallFolded)

  useLayoutEffect(() => {
    // `innerHeight` while there is no grid to measure, or it measures as nothing, the way it
    // does in a DOM with no layout.
    const measure = () => setAvailable((viewport.current?.clientHeight || window.innerHeight) - GAPS_HEIGHT)
    measure()

    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [viewport])

  const max = Math.max(MINIMUM, available - ABOVE_MINIMUM)
  const height = clamp(request ?? DEFAULT, MINIMUM, max)
  const track = folded ? FOLDED : height

  function requestHeight(to: number | null) {
    rememberPreference("repl-height", to === null ? null : String(to))
    setRequest(to)
  }

  function foldTo(to: boolean) {
    rememberPreference("repl-open", to ? null : "true")
    setFolded(to)
  }

  return {
    height,
    min: MINIMUM,
    max,
    resize: (to) => requestHeight(clamp(Math.round(to), MINIMUM, max)),
    reset: () => requestHeight(null),
    folded,
    fold: () => foldTo(true),
    unfold: () => foldTo(false),
    template: `minmax(0,1fr) ${GAP}px ${track}px`,
    minHeight: ABOVE_MINIMUM + track + GAPS_HEIGHT,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function recallHeight() {
  return recallPreference<number | null>("repl-height", null, (stored) => {
    const height = Number(stored)
    if (!Number.isFinite(height)) throw new Error(`not a height: ${stored}`)
    return height
  })
}

function recallFolded() {
  return recallPreference("repl-open", true, (stored) => stored !== "true")
}
