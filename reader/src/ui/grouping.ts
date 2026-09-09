/**
 * *Hover grouping*'s geometry: where the gutter rule starts, where it ends, and whether it
 * reaches the row at all.
 *
 * Everything here is arithmetic over rectangles somebody else measured, which is what makes
 * the one decision that matters testable. The rule assumes both ends are on screen, and at
 * real volume — 59 rows, 159 Console lines — the row usually is not. That case is not a
 * degradation to apologise for: it is the volume the Console exists for, so it is written
 * down as a kind of rule rather than as a rule that failed.
 *
 * What the rule deliberately does *not* do is go and find the row. Hovering never scrolls
 * the Activity table — a table that moved under the pointer would be unusable at exactly the
 * moment you are sweeping the Console — so an off-screen row is said out loud and the click
 * is what resolves it.
 */

/** The parts of a `DOMRect` this file reads. Viewport coordinates, as the DOM hands them over. */
export type Box = { top: number; bottom: number; left: number; right: number }

/** A point in the Reader's own frame: the box the rule is drawn over. */
export type Point = { x: number; y: number }

export type GroupingRule = {
  /** `connected` reaches the row; `stub` says there is nowhere on screen to reach. */
  kind: "connected" | "stub"
  from: Point
  to: Point
}

export const OFF_SCREEN_CAPTION = "row is off screen — click to jump"

/**
 * How far a stub travels into the gutter. Short enough to read as unfinished rather than as
 * a rule pointing at the wrong row — the stub's whole job is to look like it stopped.
 */
const STUB = 12

/** Where the elbow turns, as a fraction of the gutter. Halfway is the gutter's own middle. */
const ELBOW = 0.5

/**
 * `port` is the band a row has to lie inside to count as on screen — the Activity table's
 * scrollport, with the sticky heading's height already taken off the top by whoever measured
 * it, because a row slid under that heading is as unreadable as one below the fold.
 *
 * Containment is total rather than partial, and deliberately: half a row is not somewhere
 * the eye can land, so a rule ending at one would be claiming a connection the reader cannot
 * actually follow.
 */
export function ruleBetween(reader: Box, line: Box, row: Box | null, port: Box): GroupingRule {
  const from = { x: line.right - reader.left, y: middle(line) - reader.top }

  if (row === null || row.top < port.top || row.bottom > port.bottom) {
    return { kind: "stub", from, to: { x: from.x + STUB, y: from.y } }
  }

  return { kind: "connected", from, to: { x: row.left - reader.left, y: middle(row) - reader.top } }
}

/**
 * The rule as an SVG path. A connected rule elbows: out of the line, down the gutter, into
 * the row — so the vertical travel happens in the strip between the two columns rather than
 * across the rows, which would be a diagonal drawn over the data it is pointing at.
 */
export function rulePath(rule: GroupingRule) {
  const { from, to } = rule
  if (rule.kind === "stub") return `M ${round(from.x)} ${round(from.y)} H ${round(to.x)}`

  const elbow = from.x + (to.x - from.x) * ELBOW
  return `M ${round(from.x)} ${round(from.y)} H ${round(elbow)} V ${round(to.y)} H ${round(to.x)}`
}

function middle(box: Box) {
  return (box.top + box.bottom) / 2
}

/** Whole pixels: the rule is a hairline, and a subpixel one renders blurred. */
function round(value: number) {
  return Math.round(value)
}
