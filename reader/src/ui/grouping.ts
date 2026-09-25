/**
 * *Hover grouping*'s geometry: where the gutter rule starts, where it ends, and whether it
 * reaches the row at all.
 *
 * Everything here is arithmetic over rectangles somebody else measured, which is what makes
 * the one decision that matters testable. The rule assumes both ends are on screen, and at
 * real volume the row usually is not. That case is not a degradation to apologise for: it is
 * the volume the Console exists for, so it is written down as a kind of rule rather than as
 * a rule that failed.
 *
 * What the rule deliberately does *not* do is go and find the row. Hovering never scrolls
 * the Activity table — a table that moved under the pointer would be unusable at exactly the
 * moment you are sweeping the Console — so a row it cannot reach is said out loud and the
 * click is what resolves it.
 */

/** The parts of a `DOMRect` this file reads. Viewport coordinates, as the DOM hands them over. */
export type Box = { top: number; bottom: number; left: number; right: number }

/** A point in the Reader's own frame: the box the rule is drawn over. */
export type Point = { x: number; y: number }

/**
 * `connected` reaches the row. The other two are the two different reasons it cannot, and
 * they are kept apart because they are two different facts about where the row *is*: one is
 * scrolled past, the other is not in the table at all. One caption for both would be saying
 * something false about half of them, which is the one thing a log reader may never do.
 */
export type RuleKind = "connected" | "off-screen" | "not-shown"

export type GroupingRule = {
  kind: RuleKind
  from: Point
  to: Point
}

/** The row is rendered, and scrolled out of the band the reader can see. */
export const OFF_SCREEN_CAPTION = "row is off screen — click to jump"

/**
 * The row is not rendered: a tab filter is hiding it, which the click clears on its way
 * there. A line's lifetime is exactly its owning row's, so a line naming a `row` this
 * caption's caller cannot find always means a tab filter — the row is still held, simply
 * not shown.
 */
export const NOT_SHOWN_CAPTION = "row is filtered out — click to jump"

export function captionFor(kind: RuleKind) {
  return kind === "off-screen" ? OFF_SCREEN_CAPTION : NOT_SHOWN_CAPTION
}

/**
 * How far a stub travels into the gutter. Short enough to read as unfinished rather than as
 * a rule pointing at the wrong row — the stub's whole job is to look like it stopped.
 */
const STUB = 12

/**
 * How far past the line's end the elbow turns: the middle of the Console's 18px gutter — its
 * `pr-4.5`. Measured from the line rather than the row, so the vertical leg stays in the gutter
 * whatever lies between it and the row: the Console's edge, the gap, the divider's grip.
 */
const ELBOW = 9

/**
 * `port` is the band a row has to lie inside to count as on screen — the Activity table's
 * scrollport, with the sticky heading's height already taken off the top by whoever measured
 * it, because a row slid under that heading is as unreadable as one below the fold.
 *
 * Containment is total rather than partial, and deliberately: half a row is not somewhere
 * the eye can land, so a rule ending at one would be claiming a connection the reader cannot
 * actually follow. It is vertical only: a row the table has scrolled sideways is still on
 * screen, and is connected at the scrollport's left edge, where it starts on screen.
 */
export function ruleBetween(reader: Box, line: Box, row: Box | null, port: Box): GroupingRule {
  const from = { x: line.right - reader.left, y: middle(line) - reader.top }
  const stub = { x: from.x + STUB, y: from.y }

  if (row === null) return { kind: "not-shown", from, to: stub }
  if (row.top < port.top || row.bottom > port.bottom) return { kind: "off-screen", from, to: stub }

  // A table scrolled sideways carries the row's own left edge past the scrollport's, under
  // the Console.
  const visibleLeft = Math.max(row.left, port.left)
  return { kind: "connected", from, to: { x: visibleLeft - reader.left, y: middle(row) - reader.top } }
}

/**
 * The rule as an SVG path. A connected rule elbows: out of the line, down the gutter, into
 * the row — so the vertical travel happens in the Console's gutter rather than across the
 * rows, which would be a diagonal drawn over the data it is pointing at.
 */
export function rulePath(rule: GroupingRule) {
  const { from, to } = rule
  if (rule.kind !== "connected") return `M ${round(from.x)} ${round(from.y)} H ${round(to.x)}`

  const elbow = from.x + ELBOW
  return `M ${round(from.x)} ${round(from.y)} H ${round(elbow)} V ${round(to.y)} H ${round(to.x)}`
}

function middle(box: Box) {
  return (box.top + box.bottom) / 2
}

/** Whole pixels: the rule is a hairline, and a subpixel one renders blurred. */
function round(value: number) {
  return Math.round(value)
}

/**
 * *Hover grouping*'s two marks, as the `data-grouping` a Console line and its Activity table
 * row both wear — one list the stylesheet reads each mark out of with `~=`, and `undefined`
 * where there is no mark rather than an empty attribute. Neither is a *Selection*, which is
 * `aria-current` and says so.
 */
export function groupingMarks(pinned: boolean, lit: boolean) {
  const marks = [pinned ? "pinned" : "", lit ? "lit" : ""].filter((mark) => mark !== "")
  return marks.length === 0 ? undefined : marks.join(" ")
}
