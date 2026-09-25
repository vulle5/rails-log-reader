import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"

import { COLLAPSED, type DrawnColumn, type DrawnConsole } from "../hooks/column-widths"

/**
 * A *Column divider*: the gap between two of the Reader's columns, sizing the outer one. It is
 * the grid track between them, and the whole of what can be grabbed: nothing of it reaches
 * into either column, their scrollbars or the Console's *Gutter*. It wears a three-dot grip
 * at its middle.
 *
 * It lights — `data-lit` — once the pointer has rested on it `REST` milliseconds, so a pointer
 * sweeping across it does not flicker it, and at once for a drag; keyboard focus lights it at
 * once too. It goes off the moment the pointer leaves.
 *
 * A separator in the ARIA sense, named for the column it sizes, whose value is that column's
 * drawn width in pixels. Arrow keys move it `STEP` pixels; Enter and a double-click reset
 * the column to its default.
 *
 * A divider whose column `folds` snaps it shut: a drag that takes it under half its minimum
 * folds it, and one taking the folded strip back out past that unfolds it. By keyboard, an
 * arrow press that would take it under its minimum stops it there, the next folds it, and
 * arrowing the folded strip outward unfolds it. Folding never touches the column's request, so it always reopens at
 * the last width it had at or above its minimum. A fold or an unfold mid-drag restarts the
 * drag from the width the column now has, so the pointer moves on from there.
 */

const STEP = 16
const REST = 300

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
  const [rested, setRested] = useState(false)
  const resting = useRef<ReturnType<typeof setTimeout>>(undefined)
  // How much a move of `by` pixels rightwards widens the column.
  const widening = (by: number) => (edge === "right" ? by : -by)
  const collapsed = folds?.collapsed ?? false
  const drawn = collapsed ? COLLAPSED : column.width
  const foldsBelow = column.min / 2

  useEffect(() => () => clearTimeout(resting.current), [])

  function enter() {
    clearTimeout(resting.current)
    resting.current = setTimeout(() => setRested(true), REST)
  }

  function leave() {
    clearTimeout(resting.current)
    setRested(false)
  }

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
      if (to < foldsBelow) return
      folds.expand()
      drag.current = { from: event.clientX, width: column.width }
    } else if (to < foldsBelow) {
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
      } else if (column.width === column.min && by < 0) folds.collapse()
      else column.resize(column.width + by)
    } else if (event.key === "Enter") {
      event.preventDefault()
      column.reset()
    }
  }

  return (
    // `select-none` and the cancelled `mousedown` keep a drag from selecting the text it passes
    // over.
    <div
      className="group flex cursor-col-resize touch-none items-center justify-center rounded-full outline-none select-none focus-visible:bg-accent data-lit:bg-accent"
      role="separator"
      aria-orientation="vertical"
      aria-label={name}
      aria-valuenow={drawn}
      aria-valuemin={Math.min(column.min, drawn)}
      aria-valuemax={column.max}
      tabIndex={0}
      data-lit={rested || dragging || undefined}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onMouseDown={(event) => event.preventDefault()}
      onDoubleClick={column.reset}
      onKeyDown={press}
    >
      <span className="flex flex-col gap-0.75" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-0.75 rounded-full bg-muted group-focus-visible:bg-accent group-data-lit:bg-accent"
          />
        ))}
      </span>
    </div>
  )
}
