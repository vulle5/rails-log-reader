import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import { recallPreference, rememberPreference } from "../../../lib/preference"
import { Badge } from "./Badge"
import { TABLE_COLUMNS } from "./ActivityTable"

/**
 * The *Table columns* the developer hid, one set for every tab, remembered as what is hidden so
 * a table column the Reader gains later arrives shown. A stored key naming one of the fixed
 * three, or no table column at all, hides nothing.
 */
export function useHiddenTableColumns() {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(recall)

  const toggle = useCallback((key: string) => {
    setHidden((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      remember(next)
      return next
    })
  }, [])

  return { hidden, toggle }
}

const HIDEABLE = new Set(TABLE_COLUMNS.filter((column) => !column.fixed).map((column) => column.key))

function recall(): ReadonlySet<string> {
  return recallPreference("hidden-table-columns", new Set<string>(), (stored) => {
    const keys: unknown = JSON.parse(stored)
    if (!Array.isArray(keys)) throw new Error(`not a list of table columns: ${stored}`)
    return new Set(keys.filter((key): key is string => HIDEABLE.has(key)))
  })
}

/** In table order, and forgotten once nothing is hidden. */
function remember(hidden: ReadonlySet<string>) {
  const keys = TABLE_COLUMNS.map((column) => column.key).filter((key) => hidden.has(key))
  rememberPreference("hidden-table-columns", keys.length === 0 ? null : JSON.stringify(keys))
}

type TableColumnSelectProps = {
  hidden: ReadonlySet<string>
  onToggle: (key: string) => void
}

/**
 * The trigger that hides and shows *Table columns*, and the popover of checkboxes it opens: one
 * per table column, in table order, each described under its label. It stays open while they are
 * toggled, and closes on Escape, on a click outside it, or on its trigger again; Escape hands
 * focus back to the trigger when it was inside the popover.
 *
 * The popover is a native `manual` one, shown while it is rendered, so it lies in the top layer
 * over the column that would otherwise clip it; closing on Escape and on an outside click is
 * done here. It is placed under the trigger, right edges aligned, when it opens, whenever the
 * window resizes, and whenever the badge changes what the trigger holds.
 *
 * The fixed three are checked and `aria-disabled` rather than disabled, so they can still be
 * focused and answer: a click or a Space on one says "Always shown" beside it, until the next
 * click or keypress in the popover.
 */
export function TableColumnSelect({ hidden, onToggle }: TableColumnSelectProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // Where the popover's top right corner sits, in viewport pixels; open while it has one.
  const [corner, setCorner] = useState<{ top: number; right: number } | null>(null)
  const [noted, setNoted] = useState<string | null>(null)
  const open = corner !== null
  const badge = useId()
  const popover = useId()
  const count = hidden.size

  function measure() {
    const bounds = trigger.current!.getBoundingClientRect()
    return { top: bounds.bottom + 4, right: document.documentElement.clientWidth - bounds.right }
  }

  function close() {
    setCorner(null)
    setNoted(null)
  }

  // In the top layer before it paints, where the DOM has popovers at all.
  useLayoutEffect(() => {
    const element = panel.current
    if (open && element !== null && "showPopover" in element) element.showPopover()
  }, [open])

  // The badge coming or going can move the trigger, and the heading can wrap around it.
  useLayoutEffect(() => {
    if (open) setCorner(measure())
  }, [count])

  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (panel.current?.contains(document.activeElement)) trigger.current?.focus()
      close()
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close()
    }
    const onResize = () => setCorner(measure())

    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("resize", onResize)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("resize", onResize)
    }
  }, [open])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="inline-flex flex-none cursor-pointer items-center gap-1.5 rounded p-0.5 text-muted hover:bg-selected hover:text-foreground aria-expanded:bg-selected aria-expanded:text-foreground"
        aria-label="Table columns"
        aria-expanded={open}
        aria-controls={open ? popover : undefined}
        aria-describedby={count > 0 ? badge : undefined}
        title="Table columns"
        onClick={() => (open ? close() : setCorner(measure()))}
      >
        <ColumnsIcon />
        {count > 0 && <Badge id={badge}>{count} hidden</Badge>}
      </button>
      {open && (
        <div
          ref={panel}
          id={popover}
          popover="manual"
          className="inset-auto m-0 w-72 rounded-md border border-border bg-raised p-0 text-foreground shadow-dialog"
          style={{ top: corner.top, right: corner.right }}
          onClickCapture={() => setNoted(null)}
          onKeyDownCapture={() => setNoted(null)}
        >
          <fieldset className="flex flex-col py-1">
            <legend className="px-3 pt-1.5 pb-1 text-2xs font-semibold tracking-wider text-faint uppercase">
              Table columns
            </legend>
            {TABLE_COLUMNS.map((column) => (
              <TableColumnOption
                key={column.key}
                heading={column.heading}
                description={column.description}
                fixed={column.fixed === true}
                shown={!hidden.has(column.key)}
                noted={noted === column.key}
                onChange={() => (column.fixed ? setNoted(column.key) : onToggle(column.key))}
              />
            ))}
          </fieldset>
        </div>
      )}
    </>
  )
}

type TableColumnOptionProps = {
  heading: string
  description: string
  fixed: boolean
  shown: boolean
  noted: boolean
  onChange: () => void
}

/** Named by its heading alone and described by its description, which sits faint under it. */
function TableColumnOption({ heading, description, fixed, shown, noted, onChange }: TableColumnOptionProps) {
  const id = useId()
  return (
    <label className="flex cursor-pointer items-start gap-2 px-3 py-1 hover:bg-sunken">
      <input
        type="checkbox"
        className="mt-0.5 flex-none cursor-pointer accent-accent aria-disabled:cursor-default aria-disabled:opacity-50"
        checked={shown}
        aria-disabled={fixed || undefined}
        aria-labelledby={`${id}-heading`}
        aria-describedby={`${id}-description`}
        onChange={onChange}
      />
      <span className="flex min-w-0 flex-col">
        <span className="flex items-baseline gap-2 text-sm">
          <span id={`${id}-heading`}>{heading}</span>
          {/* Always there on a fixed one, so a screen reader hears the note arrive. */}
          {fixed && (
            <span className="text-xs text-muted" role="status">
              {noted && "Always shown"}
            </span>
          )}
        </span>
        <span id={`${id}-description`} className="text-xs text-faint">
          {description}
        </span>
      </span>
    </label>
  )
}

function ColumnsIcon() {
  return (
    <svg
      className="size-3.5 flex-none fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </svg>
  )
}
