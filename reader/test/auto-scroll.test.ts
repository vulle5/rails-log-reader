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
    expect(scrolled(FOLLOWING, false)).toEqual({ following: false, unseen: 0, floor: false })
  })

  test("resumes silently when it comes back to the bottom, dropping the count with it", () => {
    expect(scrolled({ following: false, unseen: 12, floor: false }, true)).toEqual(FOLLOWING)
  })

  test("resuming drops a floor too, exactly as it drops an exact count", () => {
    expect(scrolled({ following: false, unseen: 5_012, floor: true }, true)).toEqual(FOLLOWING)
  })

  test("leaves a paused column exactly as it was while it is still away from the bottom", () => {
    const paused = { following: false, unseen: 12, floor: false }

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
    expect(arrived({ following: false, unseen: 2, floor: false }, 3)).toEqual({
      following: false,
      unseen: 5,
      floor: false,
    })
  })

  test("never resume a paused column, whatever arrived — a Run boundary included", () => {
    // There is no event in the Sidecar the rule reads: a `run_header` arriving is one more
    // thing that arrived, and a restart may not yank a reader away from what they were
    // reading.
    expect(arrived({ following: false, unseen: 0, floor: false }, 1).following).toBe(false)
  })

  test("stays exact while nothing is being evicted", () => {
    expect(arrived({ following: false, unseen: 2, floor: false }, 3, 0)).toEqual({
      following: false,
      unseen: 5,
      floor: false,
    })
  })

  test("becomes a floor once the Memory bound starts evicting, even where the rendered count stalled", () => {
    // The Activity table's own case: a row taken for every row admitted holds `howMany` at
    // zero, so the eviction count is the only thing left saying anything arrived.
    expect(arrived({ following: false, unseen: 0, floor: false }, 0, 1)).toEqual({
      following: false,
      unseen: 1,
      floor: true,
    })
  })

  test("adds an eviction on top of what still arrived, for a Console whose own count can run either way", () => {
    expect(arrived({ following: false, unseen: 4, floor: false }, 2, 3)).toEqual({
      following: false,
      unseen: 9,
      floor: true,
    })
  })

  test("never lets a negative rendered count subtract from what a floor already holds", () => {
    // The Console's own rendered length can fall at the cap — an evicted row can take more
    // lines than a quiet batch adds — and that fall is not the pill giving anything back.
    expect(arrived({ following: false, unseen: 4, floor: false }, -6, 2)).toEqual({
      following: false,
      unseen: 6,
      floor: true,
    })
  })

  test("stays a floor once it has become one, even through a batch with nothing evicted", () => {
    expect(arrived({ following: false, unseen: 5, floor: true }, 1, 0)).toEqual({
      following: false,
      unseen: 6,
      floor: true,
    })
  })

  test("does nothing for a batch with neither an arrival nor an eviction", () => {
    const paused = { following: false, unseen: 5, floor: true }
    expect(arrived(paused, 0, 0)).toBe(paused)
  })
})
