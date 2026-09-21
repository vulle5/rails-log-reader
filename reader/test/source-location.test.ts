import { describe, expect, test } from "bun:test"

import { fillScheme, parseFrame, sourceLocation } from "../src/ui/features/detail-column/lib/source-location"

describe("parsing a raw frame", () => {
  test("splits path, line and where the path:line portion ends", () => {
    const frame = "/app/models/order.rb:44:in `block in recalculate_total!'"

    expect(parseFrame(frame)).toEqual({ path: "/app/models/order.rb", line: 44, end: "/app/models/order.rb:44".length })
  })

  test("reads Ruby 3.4's quoting of the method the same way", () => {
    expect(parseFrame("/app/models/order.rb:44:in 'Order#total'")).toEqual({
      path: "/app/models/order.rb",
      line: 44,
      end: 23,
    })
  })

  test("reads a frame with no method at all", () => {
    expect(parseFrame("app/models/order.rb:44")).toEqual({ path: "app/models/order.rb", line: 44, end: 22 })
  })

  test("keeps a colon inside the path", () => {
    expect(parseFrame("/srv/a:b/order.rb:7:in `x'")).toEqual({ path: "/srv/a:b/order.rb", line: 7, end: 19 })
  })

  test("finds nothing without a :line", () => {
    expect(parseFrame("/app/models/order.rb")).toBeNull()
    expect(parseFrame("/app/models/order.rb:in `x'")).toBeNull()
    expect(parseFrame("")).toBeNull()
  })
})

describe("finding a frame's Source location", () => {
  const RAILS_ROOT = "/home/dev/example-app"

  test("uses an absolute path as is, inside rails_root or not", () => {
    expect(sourceLocation("/gems/puma-6.6.0/lib/puma/server.rb:443:in `x'", RAILS_ROOT)).toEqual({
      path: "/gems/puma-6.6.0/lib/puma/server.rb",
      line: 443,
      end: 39,
    })
    expect(sourceLocation("/gems/puma-6.6.0/lib/puma/server.rb:443", null)?.path).toBe(
      "/gems/puma-6.6.0/lib/puma/server.rb",
    )
  })

  test("resolves a relative path against rails_root", () => {
    expect(sourceLocation("app/models/order.rb:44:in `x'", RAILS_ROOT)).toEqual({
      path: `${RAILS_ROOT}/app/models/order.rb`,
      line: 44,
      end: 22,
    })
  })

  test("has none for a relative path while rails_root is unknown", () => {
    expect(sourceLocation("app/models/order.rb:44:in `x'", null)).toBeNull()
  })

  test("has none for a pseudo-path", () => {
    for (const frame of [
      "<internal:kernel>:187:in `loop'",
      "(eval):1:in `<main>'",
      "(eval at /app/models/order.rb:3):1:in `x'",
      "<main>:1",
    ]) {
      expect(sourceLocation(frame, RAILS_ROOT)).toBeNull()
    }
  })
})

describe("filling in the Editor scheme", () => {
  const location = { path: "/home/dev/my app/app/models/order#1.rb", line: 44, end: 0 }

  test("substitutes {path} a segment at a time, keeping its slashes, and {line} as a plain number", () => {
    expect(fillScheme("vscode://file/{path}:{line}", location)).toBe(
      "vscode://file//home/dev/my%20app/app/models/order%231.rb:44",
    )
  })

  test("substitutes only {path} when the template has no {line}", () => {
    expect(fillScheme("txmt://open?url=file://{path}", location)).toBe(
      "txmt://open?url=file:///home/dev/my%20app/app/models/order%231.rb",
    )
  })
})
