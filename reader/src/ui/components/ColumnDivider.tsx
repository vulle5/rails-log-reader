import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"

import { cn } from "../lib/cn"

/**
 * A *Column divider*: the gap between two of the Reader's columns, sizing the outer one. It is
 * the grid track between them, and the whole of what can be grabbed: nothing of it reaches
 * into either column, their scrollbars or the Console's *Gutter*. It wears a three-dot grip
 * at its middle. The *REPL* drawer's top edge is one too, turned on its side: the gap between
 * the drawer and the columns above it, sizing the drawer's height.
 *
 * It lights — `data-lit` — once the pointer has rested on it `REST` milliseconds, so a pointer
 * sweeping across it does not flicker it, and at once for a drag; keyboard focus lights it at
 * once too. It goes off the moment the pointer leaves. Lighting and going off both fade.
 *
 * A separator in the ARIA sense, named for the column it sizes, whose value is that column's
 * drawn size in pixels. Arrow keys along its axis move it `STEP` pixels; Enter and a
 * double-click reset the column to its default.
 *
 * A divider whose column `folds` snaps it shut: a drag that takes it under half its minimum
 * folds it, and one taking the folded strip back out past that unfolds it. By keyboard, an
 * arrow press that would take it under its minimum stops it there, the next folds it, and
 * arrowing the folded strip outward unfolds it. Folding never touches the column's request, so it always reopens at
 * the last size it had at or above its minimum. A fold or an unfold mid-drag restarts the
 * drag from the size the column now has, so the pointer moves on from there.
 */

const STEP = 16
const REST = 300

/** How far a divider can move its column, and what moving it asks for. */
export type Resizable = {
  min: number
  max: number
  /** Requests a size, held between the column's minimum and `max`. */
  resize: (size: number) => void
  /** Drops the request, so the column returns to its default. */
  reset: () => void
}

/** A column that folds: whether it is, the two ways to change that, and the size it folds to. */
export type Foldable = {
  folded: boolean
  fold: () => void
  unfold: () => void
  foldedSize: number
}

type ColumnDividerProps = {
  /** The name of the column it sizes. */
  name: string
  /**
   * Which edge of that column the divider is: the Console's right edge, the Detail column's
   * left one, or the REPL drawer's top one. Moving the divider outward, away from the
   * Activity table, grows it.
   */
  edge: "right" | "left" | "top"
  /** The column's drawn size while it is open, which it keeps while it is folded. */
  size: number
  column: Resizable
  folds?: Foldable
  className?: string
}

export function ColumnDivider({ name, edge, size, column, folds, className }: ColumnDividerProps) {
  const drag = useRef<{ from: number; size: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [rested, setRested] = useState(false)
  const resting = useRef<ReturnType<typeof setTimeout>>(undefined)
  const across = edge === "top" ? "y" : "x"
  // How much a move of `by` pixels rightwards, or downwards, grows the column.
  const growing = (by: number) => (edge === "right" ? by : -by)
  const pointerAt = (event: PointerEvent) => (across === "x" ? event.clientX : event.clientY)
  const folded = folds?.folded ?? false
  const drawn = folds !== undefined && folded ? folds.foldedSize : size
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
    drag.current = { from: pointerAt(event), size: drawn }
    setDragging(true)
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    if (drag.current === null) return
    const at = pointerAt(event)
    const to = drag.current.size + growing(at - drag.current.from)

    if (folds === undefined) column.resize(to)
    else if (folded) {
      if (to < foldsBelow) return
      folds.unfold()
      drag.current = { from: at, size }
    } else if (to < foldsBelow) {
      folds.fold()
      drag.current = { from: at, size: folds.foldedSize }
    } else column.resize(to)
  }

  function end() {
    drag.current = null
    setDragging(false)
  }

  function press(event: KeyboardEvent<HTMLDivElement>) {
    const [back, forward] = across === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"]
    if (event.key === back || event.key === forward) {
      event.preventDefault()
      const by = growing(event.key === forward ? STEP : -STEP)

      if (folds === undefined) column.resize(size + by)
      else if (folded) {
        if (by > 0) folds.unfold()
      } else if (size === column.min && by < 0) folds.fold()
      else column.resize(size + by)
    } else if (event.key === "Enter") {
      event.preventDefault()
      column.reset()
    }
  }

  return (
    // `select-none` and the cancelled `mousedown` keep a drag from selecting the text it passes
    // over.
    <div
      className={cn(
        "group flex touch-none items-center justify-center rounded-full outline-none transition-colors select-none focus-visible:bg-accent data-lit:bg-accent motion-reduce:transition-none",
        across === "x" ? "cursor-col-resize" : "cursor-row-resize",
        className,
      )}
      role="separator"
      aria-orientation={across === "x" ? "vertical" : "horizontal"}
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
      <span className={cn("flex gap-0.75", across === "x" && "flex-col")} aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-0.5 rounded-full bg-muted transition-colors group-focus-visible:bg-accent group-data-lit:bg-accent motion-reduce:transition-none"
          />
        ))}
      </span>
    </div>
  )
}
