import { describe, expect, test } from "bun:test"

import { resolveAppName } from "../src/shared/app-name"

/**
 * #95's own seam: `resolveAppName` is a plain function over plain values — no `EventSource`,
 * no fetch, no process — so the truth table is driven from here the same way Seam 1 drives
 * the fold in `activity.ts`. The latching half of "what does the Reader call this Host app"
 * moved to `run-identity.test.ts` when `latchAppName` folded into `latchRunIdentity` (#97).
 */

describe("resolveAppName", () => {
  test("is the wire's latched name when there is no override", () => {
    expect(resolveAppName(null, "MyApp")).toBe("MyApp")
  })

  test("the override wins unconditionally, even once a Run has already said a name", () => {
    expect(resolveAppName("Overridden", "MyApp")).toBe("Overridden")
  })

  test("is null before either has said anything, which is the generic-fallback state", () => {
    expect(resolveAppName(null, null)).toBeNull()
  })
})
