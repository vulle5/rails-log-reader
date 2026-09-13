import { describe, expect, test } from "bun:test"

import { isHostFrame } from "../src/ui/features/detail-column/lib/backtrace"

/**
 * Classifying a backtrace frame as the Host app's own code: exact against `rails_root`,
 * never a guess at a path's shape.
 */
describe("classifying a backtrace frame against rails_root", () => {
  test("is a Host frame when the path sits under rails_root", () => {
    expect(isHostFrame("/home/dev/example-app/app/models/order.rb:44:in `each'", "/home/dev/example-app")).toBe(true)
  })

  test("is not a Host frame for a gem outside rails_root", () => {
    expect(
      isHostFrame("puma (6.6.0) lib/puma/server.rb:443:in `process_client'", "/home/dev/example-app"),
    ).toBe(false)
  })

  // Sharing the prefix as text is not sharing the directory: `/home/dev/example-app-worker`
  // is a sibling of `/home/dev/example-app`, not something under it.
  test("is not a Host frame for a sibling directory that merely shares the prefix", () => {
    expect(isHostFrame("/home/dev/example-app-worker/job.rb:9", "/home/dev/example-app")).toBe(false)
  })

  test("is not a Host frame for rails_root itself with nothing after it", () => {
    expect(isHostFrame("/home/dev/example-app", "/home/dev/example-app")).toBe(false)
  })

  // The explicit-absence call: a Run whose `run_header` was never observed has no rails_root
  // to classify against, so nothing is guessed a Host frame.
  test("is never a Host frame when rails_root is unknown", () => {
    expect(isHostFrame("/home/dev/example-app/app/models/order.rb:44", null)).toBe(false)
  })
})
