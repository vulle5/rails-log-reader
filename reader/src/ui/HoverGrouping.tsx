import { useLayoutEffect, useState, type RefObject } from "react"

import { OFF_SCREEN_CAPTION, ruleBetween, rulePath, type Box, type GroupingRule } from "./grouping"

/**
 * *Hover grouping*'s DOM half: measure the two ends, hand them to `grouping.ts`, draw what it
 * decides.
 *
 * An overlay across the whole Reader rather than something inside either column, because the
 * rule is the one thing in the layout that belongs to neither: it starts in the Console's
 * gutter and lands on a row in the table beside it. It is inert — `pointer-events: none` —
 * so the line under the pointer stays under the pointer and the rule cannot come between the
 * hover and the click that follows it.
 *
 * Measurement is redone on either column's scroll and on a resize, and whenever `version`
 * changes — the caller's word for "something moved that is not which two ends these are": a
 * tab filter switching, a level chip going off, rows arriving.
 */

type HoverGroupingProps = {
  /** The Reader's grid: the box the rule is drawn over, and the frame its points are in. */
  reader: RefObject<HTMLDivElement | null>
  /** The Console line the rule starts at — hovered, else pinned. `null` draws nothing. */
  line: string | null
  /** The `id` of the Activity table row it is drawn to. */
  row: string | null
  version: string
}

export function HoverGrouping({ reader, line, row, version }: HoverGroupingProps) {
  const [rule, setRule] = useState<GroupingRule | null>(null)

  useLayoutEffect(() => {
    const host = reader.current
    if (host === null || line === null) {
      setRule(null)
      return
    }

    const measure = () => setRule(measureRule(host, line, row))
    measure()

    // Both scrollports, because either end moving is the rule going stale — and passively,
    // since nothing here ever prevents a scroll.
    const ports = [...host.querySelectorAll(".column-body")]
    for (const port of ports) port.addEventListener("scroll", measure, { passive: true })
    window.addEventListener("resize", measure)

    return () => {
      for (const port of ports) port.removeEventListener("scroll", measure)
      window.removeEventListener("resize", measure)
    }
  }, [reader, line, row, version])

  if (rule === null) return null

  return (
    <div className="grouping">
      <svg className="grouping-canvas" aria-hidden="true">
        <path className={`grouping-rule grouping-rule-${rule.kind}`} d={rulePath(rule)} />
        {rule.kind === "connected" && <circle className="grouping-landing" cx={rule.to.x} cy={rule.to.y} r={3} />}
      </svg>
      {/* Where the stub stops, saying what the stub means. Not left to the shape of a line
          that goes nowhere: "it stopped" and "there is nothing to stop at" look identical. */}
      {rule.kind === "stub" && (
        <p className="grouping-caption" style={{ left: `${rule.to.x}px`, top: `${rule.to.y}px` }}>
          {OFF_SCREEN_CAPTION}
        </p>
      )}
    </div>
  )
}

function measureRule(host: HTMLElement, line: string, row: string | null): GroupingRule | null {
  const from = host.querySelector(byData("line", line))
  const port = host.querySelector(".column-activity .column-body")
  if (from === null || port === null) return null

  // `null` is a row that is not rendered at all — hidden by a tab filter, or evicted under
  // the *Memory bound* — which is the same answer to the reader as one below the fold.
  const to = row === null ? null : host.querySelector(byData("row", row))

  return ruleBetween(host.getBoundingClientRect(), from.getBoundingClientRect(), to?.getBoundingClientRect() ?? null, visibleBand(port))
}

/**
 * The band a row has to lie inside to count as on screen: the Activity table's scrollport
 * with its sticky heading's height taken off the top, because a row slid under that heading
 * is as unreadable as one below the fold.
 */
function visibleBand(port: Element): Box {
  const box = port.getBoundingClientRect()
  const sticky = port.querySelector("thead")?.getBoundingClientRect().height ?? 0
  return { top: box.top + sticky, bottom: box.bottom, left: box.left, right: box.right }
}

/**
 * Ids are the Reader's own — `run srv-1 41`, `request a1b2c3d4` — so they carry spaces and
 * whatever a Rails app put in a `request_id`. `CSS.escape` makes one into an identifier the
 * selector can hold unquoted, which is the escaping that actually exists for this.
 */
function byData(attribute: string, value: string) {
  return `[data-${attribute}=${CSS.escape(value)}]`
}
