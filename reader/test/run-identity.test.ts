import { describe, expect, test } from "bun:test"

import { latchRunIdentity } from "../src/shared/run-identity"
import type { Envelope } from "../src/shared/wire"

/**
 * `RunIdentity` generalizes `latchAppName`'s contract (see `app-name.test.ts`) from one
 * field to the whole `run_header` payload: the same envelope carries `rails_root`,
 * `app_name`, `kind`, `pid` and `rails_version` together, so there is one fact to latch
 * rather than five independent ones.
 */

function header(runId = "run-1", overrides: Partial<Extract<Envelope, { type: "run_header" }>["payload"]> = {}): Envelope {
  return {
    v: 3,
    run_id: runId,
    seq: 1,
    at_mono: 0,
    at_wall: 0,
    request_id: null,
    type: "run_header",
    payload: {
      kind: "server",
      rails_version: "8.0.2",
      app_name: "MyApp",
      rails_root: "/home/dev/app",
      pid: 1,
      ...overrides,
    },
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

describe("latchRunIdentity", () => {
  test("stays null until a run_header has arrived", () => {
    expect(latchRunIdentity(null, [start()])).toBeNull()
  })

  test("takes the first run_header's fields, all five at once", () => {
    expect(
      latchRunIdentity(null, [start(), header("run-1", { app_name: "MyApp", rails_root: "/home/dev/app", pid: 48_211 })]),
    ).toEqual({
      railsRoot: "/home/dev/app",
      appName: "MyApp",
      runKind: "server",
      pid: 48_211,
      railsVersion: "8.0.2",
    })
  })

  test("never reconsiders once latched, even against a later Run's different header", () => {
    const latched = { railsRoot: "/home/dev/app", appName: "MyApp", runKind: "server" as const, pid: 1, railsVersion: "8.0.2" }
    expect(latchRunIdentity(latched, [header("run-2", { app_name: "OtherApp", rails_root: "/home/dev/other" })])).toBe(
      latched,
    )
  })

  test("survives the owning row's eviction and reopening: latched stays latched across any later batch", () => {
    const latched = { railsRoot: "/home/dev/app", appName: "MyApp", runKind: "server" as const, pid: 1, railsVersion: "8.0.2" }
    // A reopened Run row opens via an unattributed event with no header of its own —
    // exactly what a batch carrying only that looks like.
    expect(latchRunIdentity(latched, [{ ...start(), request_id: null }])).toBe(latched)
  })

  test("takes the first header when a batch carries more than one", () => {
    expect(latchRunIdentity(null, [header("run-1", { app_name: "First" }), header("run-2", { app_name: "Second" })])).toEqual(
      expect.objectContaining({ appName: "First" }),
    )
  })
})
