import { describe, expect, test } from "bun:test"

import { latchAppName, resolveAppName } from "../src/shared/app-name"
import type { Envelope } from "../src/shared/wire"

/**
 * #95's own seam: both halves of "what does the Reader call this Host app" are plain
 * functions over plain values — no `EventSource`, no fetch, no process — so the truth table
 * is driven from here the same way Seam 1 drives the fold in `activity.ts`.
 */

function header(appName: string, runId = "run-1"): Envelope {
  return {
    v: 3,
    run_id: runId,
    seq: 1,
    at_mono: 0,
    at_wall: 0,
    request_id: null,
    type: "run_header",
    payload: { kind: "server", rails_version: "8.0.2", app_name: appName, rails_root: "/home/dev/app", pid: 1 },
  }
}

function start(runId = "run-1"): Envelope {
  return {
    v: 3,
    run_id: runId,
    seq: 2,
    at_mono: 1,
    at_wall: 1,
    request_id: "req-1",
    type: "request_start",
    payload: { method: "GET", path: "/" },
  }
}

describe("latchAppName", () => {
  test("stays null until a run_header has arrived", () => {
    expect(latchAppName(null, [start()])).toBeNull()
  })

  test("takes the first run_header's app_name", () => {
    expect(latchAppName(null, [start(), header("MyApp")])).toBe("MyApp")
  })

  test("never reconsiders once latched, even against a later Run's different name", () => {
    expect(latchAppName("MyApp", [header("OtherApp", "run-2")])).toBe("MyApp")
  })

  test("takes the first header when a batch carries more than one", () => {
    expect(latchAppName(null, [header("First"), header("Second", "run-2")])).toBe("First")
  })
})

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
