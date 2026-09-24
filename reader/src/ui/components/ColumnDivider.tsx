import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react"

import { COLLAPSED, type DrawnColumn, type DrawnConsole } from "../hooks/column-widths"

/**
 * A *Column divider*: the handle on the border between two of the Reader's columns, sizing
 * the outer one. Positioned over the Reader's grid at that border rather than inside either
 * column, so it sits outside the Console's *Gutter*.
 *
 * A separator in the ARIA sense, named for the column it sizes, whose value is that column's
 * drawn width in pixels. Arrow keys move it `STEP` pixels; Enter and a double-click reset
 * the column to its default.
 *
 * A divider whose column `folds` snaps it shut the way VS Code's sidebar does: a drag that
 * takes it under half its minimum folds it, and one taking the folded strip back out past
 * that unfolds it; by keyboard, arrowing it under its minimum folds it and arrowing it
 * outward unfolds it. Folding never touches the column's request, so it always reopens at
 * the last width it had at or above its minimum. A fold or an unfold mid-drag restarts the
 * drag from the width the column now has, so the pointer moves on from there.
 */

const STEP = 16

type ColumnDividerProps = {
  /** The name of the column it sizes. */
  name: string
  /**
   * Which edge of that column the divider is: the Console's right edge, or the Detail
   * column's left one. Moving the divider outward, away from the Activity table, widens it.
   */
  edge: "right" | "left"
  column: DrawnColumn
  folds?: Pick<DrawnConsole, "collapsed" | "collapse" | "expand">
}

export function ColumnDivider({ name, edge, column, folds }: ColumnDividerProps) {
  const drag = useRef<{ from: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // How much a move of `by` pixels rightwards widens the column.
  const widening = (by: number) => (edge === "right" ? by : -by)
  const collapsed = folds?.collapsed ?? false
  const drawn = collapsed ? COLLAPSED : column.width
  const snap = column.min / 2

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { from: event.clientX, width: drawn }
    setDragging(true)
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    if (drag.current === null) return
    const to = drag.current.width + widening(event.clientX - drag.current.from)

    if (folds === undefined) column.resize(to)
    else if (collapsed) {
      if (to < snap) return
      folds.expand()
      drag.current = { from: event.clientX, width: column.width }
    } else if (to < snap) {
      folds.collapse()
      drag.current = { from: event.clientX, width: COLLAPSED }
    } else column.resize(to)
  }

  function end() {
    drag.current = null
    setDragging(false)
  }

  function press(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault()
      const by = widening(event.key === "ArrowRight" ? STEP : -STEP)

      if (folds === undefined) column.resize(column.width + by)
      else if (collapsed) {
        if (by > 0) folds.expand()
      } else if (column.width + by < column.min) folds.collapse()
      else column.resize(column.width + by)
    } else if (event.key === "Enter") {
      event.preventDefault()
      column.reset()
    }
  }

  return (
    // Centred on the border, wider than it so there is something to grab. `select-none` and
    // the cancelled `mousedown` keep a drag from selecting the text it passes over.
    <div
      className="absolute inset-y-0 z-3 w-1.5 cursor-col-resize touch-none outline-none select-none hover:bg-accent focus-visible:bg-accent data-dragging:bg-accent"
      style={edge === "right" ? { left: `${drawn - 3}px` } : { right: `${drawn - 3}px` }}
      role="separator"
      aria-orientation="vertical"
      aria-label={name}
      aria-valuenow={drawn}
      aria-valuemin={Math.min(column.min, drawn)}
      aria-valuemax={column.max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onMouseDown={(event) => event.preventDefault()}
      onDoubleClick={column.reset}
      onKeyDown={press}
    />
  )
}
