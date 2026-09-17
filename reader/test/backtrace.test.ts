import { describe, expect, test } from "bun:test"

import { isHostFrame, segmentBacktrace } from "../src/ui/features/detail-column/lib/backtrace"

describe("classifying a backtrace frame against rails_root", () => {
  test("is a Host frame when the path sits under rails_root", () => {
    expect(isHostFrame("/home/dev/example-app/app/models/order.rb:44:in `each'", "/home/dev/example-app")).toBe(true)
  })

  test("is not a Host frame for a gem outside rails_root", () => {
    expect(
      isHostFrame("puma (6.6.0) lib/puma/server.rb:443:in `process_client'", "/home/dev/example-app"),
    ).toBe(false)
  })

  test("is not a Host frame for a sibling directory that merely shares the prefix", () => {
    expect(isHostFrame("/home/dev/example-app-worker/job.rb:9", "/home/dev/example-app")).toBe(false)
  })

  test("is not a Host frame for rails_root itself with nothing after it", () => {
    expect(isHostFrame("/home/dev/example-app", "/home/dev/example-app")).toBe(false)
  })

  test("is never a Host frame when rails_root is unknown", () => {
    expect(isHostFrame("/home/dev/example-app/app/models/order.rb:44", null)).toBe(false)
  })
})

describe("segmenting a backtrace for collapse", () => {
  const RAILS_ROOT = "/home/dev/example-app"
  const RAISED = "puma (6.6.0) lib/puma/server.rb:443:in `process_client'"
  const HOST_FRAME = `${RAILS_ROOT}/app/models/order.rb:44:in \`block in recalculate_total!'`
  const GEM_BEFORE = "actionpack (8.0.2) lib/action_controller/metal/rescue.rb:23:in `process_action'"
  const GEM_AFTER = "rack (3.1.8) lib/rack/urlmap.rb:74:in `call'"

  test("returns nothing for an empty backtrace", () => {
    expect(segmentBacktrace([], RAILS_ROOT)).toEqual([])
  })

  test("gives backtrace[0] its own frame segment even where it fails isHostFrame", () => {
    expect(segmentBacktrace([RAISED], RAILS_ROOT)).toEqual([{ type: "frame", index: 0, frame: RAISED, host: false }])
  })

  test("folds a contiguous run of non-Host-app frames into one gap", () => {
    expect(segmentBacktrace([RAISED, GEM_BEFORE, GEM_AFTER], RAILS_ROOT)).toEqual([
      { type: "frame", index: 0, frame: RAISED, host: false },
      { type: "gap", from: 1, frames: [GEM_BEFORE, GEM_AFTER] },
    ])
  })

  test("splits into two gaps around an interior Host-app frame, rather than one spanning both", () => {
    expect(segmentBacktrace([RAISED, GEM_BEFORE, HOST_FRAME, GEM_AFTER], RAILS_ROOT)).toEqual([
      { type: "frame", index: 0, frame: RAISED, host: false },
      { type: "gap", from: 1, frames: [GEM_BEFORE] },
      { type: "frame", index: 2, frame: HOST_FRAME, host: true },
      { type: "gap", from: 3, frames: [GEM_AFTER] },
    ])
  })

  test("leaves adjacent Host-app frames as separate frame segments, with no gap between them", () => {
    const secondHostFrame = `${RAILS_ROOT}/app/models/order.rb:50`
    expect(segmentBacktrace([RAISED, HOST_FRAME, secondHostFrame], RAILS_ROOT)).toEqual([
      { type: "frame", index: 0, frame: RAISED, host: false },
      { type: "frame", index: 1, frame: HOST_FRAME, host: true },
      { type: "frame", index: 2, frame: secondHostFrame, host: true },
    ])
  })

  test("collapses to one gap spanning everything but backtrace[0] when railsRoot is unknown", () => {
    expect(segmentBacktrace([RAISED, GEM_BEFORE, HOST_FRAME], null)).toEqual([
      { type: "frame", index: 0, frame: RAISED, host: false },
      { type: "gap", from: 1, frames: [GEM_BEFORE, HOST_FRAME] },
    ])
  })
})
