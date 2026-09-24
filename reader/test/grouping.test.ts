import { describe, expect, test } from "bun:test"

import { NOT_SHOWN_CAPTION, OFF_SCREEN_CAPTION, captionFor, rulePath, ruleBetween, type Box } from "../src/ui/grouping"

/**
 * *Hover grouping*'s one arithmetic decision, taken apart from the DOM that measures it:
 * given where the Console line is, where its row is, and how much of the Activity table is
 * on screen — does the rule connect, or does it end in a stub?
 *
 * A seam of its own because the answer is the whole feature. At real volume the row usually
 * *is* off screen, which is the case the Console exists for, and it is the one a test in a
 * browserless DOM could otherwise never reach: every rectangle happy-dom measures is zero.
 *
 * The two ways of *not* reaching a row are kept apart here, because they are two different
 * facts about where it is — scrolled past, or not in the table at all — and one caption for
 * both would be saying something false about half of them.
 */

function box(top: number, bottom: number, left = 0, right = 0): Box {
  return { top, bottom, left, right }
}

/** The Reader's own frame, offset from the viewport so a test can tell the two apart. */
const READER = box(40, 800, 100, 1500)
/** The Activity table's scrollport: what "on screen" means, and nothing wider. */
const PORT = box(100, 700, 440, 1100)

describe("the gutter rule", () => {
  test("connects a Console line to a row that is fully inside the Activity table's scrollport", () => {
    const rule = ruleBetween(READER, box(200, 220, 100, 422), box(300, 324, 440, 1100), PORT)

    expect(rule.kind).toBe("connected")
    // Relative to the Reader, because that is the box the rule is drawn over — never to the
    // viewport, which the Reader does not fill.
    expect(rule.from).toEqual({ x: 322, y: 170 })
    expect(rule.to).toEqual({ x: 340, y: 272 })
  })

  test("lands on the table's visible left edge when the table is scrolled sideways", () => {
    // Scrolled 160px: the row's own left edge sits under the Console.
    const rule = ruleBetween(READER, box(200, 220, 100, 422), box(300, 324, 280, 1260), PORT)

    expect(rule.kind).toBe("connected")
    expect(rule.to).toEqual({ x: 340, y: 272 })
    expect(rulePath(rule)).toBe("M 322 170 H 331 V 272 H 340")
  })

  test("ends in a stub when the row is below the fold, and never scrolls to fetch it", () => {
    const rule = ruleBetween(READER, box(200, 220, 100, 422), box(720, 744, 440, 1100), PORT)

    expect(rule.kind).toBe("off-screen")
    // Horizontal, level with the line it came from: the rule is not pointing anywhere, it
    // is saying there is nowhere on screen to point.
    expect(rule.to.y).toBe(rule.from.y)
    expect(rule.to.x).toBeGreaterThan(rule.from.x)
  })

  test("ends in a stub when the row is scrolled off the top, or under the sticky heading", () => {
    const rule = ruleBetween(READER, box(200, 220, 100, 422), box(60, 84, 440, 1100), PORT)

    expect(rule.kind).toBe("off-screen")
  })

  test("ends in a stub for a row only half on screen, because half a row is not somewhere to land", () => {
    const rule = ruleBetween(READER, box(200, 220, 100, 422), box(688, 712, 440, 1100), PORT)

    expect(rule.kind).toBe("off-screen")
  })

  test("says a row that is not rendered at all is filtered out, and never that it is off screen", () => {
    // A tab filter is hiding it. Calling that "off screen" would be the Reader asserting
    // something false about where the row is, which is the one thing it may never do — and
    // the click resolves the two cases differently, clearing the filter before it jumps.
    const rule = ruleBetween(READER, box(200, 220, 100, 422), null, PORT)

    expect(rule.kind).toBe("not-shown")
    expect(captionFor(rule.kind)).toBe(NOT_SHOWN_CAPTION)
  })

  test("captions each stub with what it means and what to do about it", () => {
    expect(OFF_SCREEN_CAPTION).toBe("row is off screen — click to jump")
    expect(captionFor("off-screen")).toBe(OFF_SCREEN_CAPTION)
    expect(NOT_SHOWN_CAPTION).not.toBe(OFF_SCREEN_CAPTION)
    expect(NOT_SHOWN_CAPTION).toContain("click to jump")
  })
})

describe("the path the rule is drawn along", () => {
  test("elbows through the gutter, so the two ends are joined without crossing the rows", () => {
    const rule = ruleBetween(READER, box(200, 220, 100, 422), box(300, 324, 440, 1100), PORT)

    // Out of the line, down the gutter, into the row: the vertical travel happens in the
    // strip between the two columns and nowhere else.
    expect(rulePath(rule)).toBe("M 322 170 H 331 V 272 H 340")
  })

  test("draws a stub as the one horizontal segment it is", () => {
    const rule = ruleBetween(READER, box(200, 220, 100, 422), null, PORT)

    expect(rulePath(rule)).toBe(`M 322 170 H ${rule.to.x}`)
  })
})
