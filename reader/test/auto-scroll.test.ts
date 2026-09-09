import { describe, expect, test } from "bun:test"

import { arrived, atBottom, FOLLOWING, scrolled, type Port } from "../src/ui/auto-scroll"

/**
 * The *auto-scroll* rule, taken apart from the three scrollports that obey it. Three columns
 * follow independently, and this is the one rule all three are: it is worth a seam of its
 * own precisely because there is only one, and because a browserless DOM has no layout to
 * measure — every rectangle happy-dom reports is zero, so "is this port at the bottom" is a
 * question only arithmetic over numbers somebody else measured can answer here.
 *
 * The whole of the rule: scrolling up is the only gesture that pauses, and getting back to
 * the bottom is the only thing that resumes. Nothing else in the Reader may pause a column —
 * not selecting a row, not a Run boundary, not a filter — which is what "no second, hidden
 * pause state" means, and is testable here as the absence of any other transition.
 */

/** A port that has been scrolled `up` pixels off its bottom. */
function port(up: number): Port {
  return { scrollTop: 900 - up, scrollHeight: 1500, clientHeight: 600 }
}

describe("where the port is", () => {
  test("counts a port scrolled to its last pixel as at the bottom", () => {
    expect(atBottom(port(0))).toBe(true)
  })

  test("counts a port a hair off the bottom as at the bottom, because layout is fractional", () => {
    // A scrollport's own numbers are rounded to whole pixels while its real scroll maximum
    // is not, so a port the browser considers scrolled to the end can still report a pixel
    // of distance. Without the slack, following would stop on its own the moment a row of
    // fractional height arrived.
    expect(atBottom(port(1))).toBe(true)
  })

  test("counts a port scrolled up by a row as away from the bottom", () => {
    expect(atBottom(port(24))).toBe(false)
  })

  test("counts a port with nothing to scroll as at the bottom, because it is", () => {
    expect(atBottom({ scrollTop: 0, scrollHeight: 600, clientHeight: 600 })).toBe(true)
  })
})

describe("scrolling", () => {
  test("pauses a following column when it leaves the bottom", () => {
    expect(scrolled(FOLLOWING, false)).toEqual({ following: false, unseen: 0 })
  })

  test("resumes silently when it comes back to the bottom, dropping the count with it", () => {
    expect(scrolled({ following: false, unseen: 12 }, true)).toEqual(FOLLOWING)
  })

  test("leaves a paused column exactly as it was while it is still away from the bottom", () => {
    const paused = { following: false, unseen: 12 }

    // Identity, not just equality: a scroll that changes nothing must not re-render the
    // column it is scrolling — this fires on every frame of a drag.
    expect(scrolled(paused, false)).toBe(paused)
  })

  test("leaves a following column alone while it stays at the bottom", () => {
    expect(scrolled(FOLLOWING, true)).toBe(FOLLOWING)
  })
})

describe("things arriving", () => {
  test("are shown as they arrive while the column is following, and counted nowhere", () => {
    expect(arrived(FOLLOWING, 3)).toEqual(FOLLOWING)
  })

  test("are counted for a paused column, which is the whole of what the pill says", () => {
    expect(arrived({ following: false, unseen: 2 }, 3)).toEqual({ following: false, unseen: 5 })
  })

  test("never resume a paused column, whatever arrived — a Run boundary included", () => {
    // There is no event in the Sidecar the rule reads: a `run_header` arriving is one more
    // thing that arrived, and a restart may not yank a reader away from what they were
    // reading.
    expect(arrived({ following: false, unseen: 0 }, 1).following).toBe(false)
  })
})
