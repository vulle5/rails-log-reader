import { describe, expect, test } from "bun:test"

import { detectEmptyState, detectMismatch, type InitializerFileStatus } from "../src/shared/initializer-status"
import { WIRE_VERSION } from "../src/shared/wire"
import { isWireVersionUnderstood } from "../src/shared/wire-compatibility"

/**
 * #29, at its purest seam: both halves of "is the Initializer current" are plain functions
 * over plain values — no filesystem, no `EventSource`, no process — so the whole truth table
 * is driven from here the same way Seam 1 drives the fold from a fixture Sidecar.
 */

const MASTER = "/home/dev/rails-log-reader/reader/rails/rails_log_reader.rb"

const CURRENT: InitializerFileStatus = { installed: true, current: true, enabled: true, masterPath: MASTER }
const STALE: InitializerFileStatus = { installed: true, current: false, enabled: true, masterPath: MASTER }
const NOT_INSTALLED: InitializerFileStatus = { installed: false, current: false, enabled: false, masterPath: MASTER }

describe("detectMismatch", () => {
  test("says nothing is wrong once the file matches the master and no process disagrees", () => {
    expect(detectMismatch(CURRENT, null)).toEqual({ kind: "none" })
    expect(detectMismatch(CURRENT, WIRE_VERSION)).toEqual({ kind: "none" })
  })

  test("names the file when it does not match the master copy", () => {
    expect(detectMismatch(STALE, null)).toEqual({ kind: "file_stale" })
  })

  test("names the process when the file is current but the wire says an older version", () => {
    // #29's own example: "a stale Initializer still loaded after the new one was copied in".
    expect(detectMismatch(CURRENT, WIRE_VERSION - 1)).toEqual({ kind: "process_stale" })
  })

  test("prefers naming the file when both disagree, since repairing it is the same first step", () => {
    expect(detectMismatch(STALE, WIRE_VERSION - 1)).toEqual({ kind: "file_stale" })
  })

  test("stays quiet on a `v` ahead of this Reader — that is #29's refusal case, not a mismatch to repair", () => {
    expect(detectMismatch(CURRENT, WIRE_VERSION + 1)).toEqual({ kind: "none" })
  })

  test("treats *not installed* as nothing to compare yet, not as a mismatch", () => {
    // #28's empty state, not this one's — a fresh checkout should not open on a repair banner.
    expect(detectMismatch(NOT_INSTALLED, null)).toEqual({ kind: "none" })
  })

  test("stays quiet before the file has been read at all", () => {
    // What `GET /initializer-status` looks like before it has answered — nothing to flash a
    // banner about ahead of the read that would justify one.
    expect(detectMismatch(null, WIRE_VERSION - 1)).toEqual({ kind: "none" })
  })
})

describe("detectEmptyState (#28)", () => {
  const NOT_ENABLED: InitializerFileStatus = { ...CURRENT, enabled: false }

  test("names *not installed* when there is no Initializer, and carries the copy to install", () => {
    expect(detectEmptyState(NOT_INSTALLED, true)).toEqual({ kind: "not_installed", masterPath: MASTER })
  })

  test("names *not installed* even with a Marker file already waiting for it", () => {
    // Touched first and copied second is an order people do things in; the file that is
    // missing is still the one to name.
    expect(detectEmptyState({ ...NOT_INSTALLED, enabled: true }, true)).toEqual({
      kind: "not_installed",
      masterPath: MASTER,
    })
  })

  test("names *not enabled* when the Initializer is there and the Marker file is not", () => {
    expect(detectEmptyState(NOT_ENABLED, true)).toEqual({ kind: "not_enabled" })
  })

  test("names *enabled but idle* when both are there and the history held nothing", () => {
    expect(detectEmptyState(CURRENT, true)).toEqual({ kind: "idle" })
  })

  test("is *enabled but idle* for a copy that has drifted, too — the mismatch banner is what says that", () => {
    expect(detectEmptyState(STALE, true)).toEqual({ kind: "idle" })
  })

  test("says nothing before the history has all arrived, however the files read", () => {
    // Rows may be on their way: a Sidecar left over from before the Marker file was removed
    // still has a history to show, and a cause named over it would flash and vanish.
    for (const file of [NOT_INSTALLED, NOT_ENABLED, CURRENT]) expect(detectEmptyState(file, false)).toBeNull()
  })

  test("says nothing before the files have been read", () => {
    expect(detectEmptyState(null, true)).toBeNull()
  })
})

describe("isWireVersionUnderstood", () => {
  test("understands its own version and everything older", () => {
    expect(isWireVersionUnderstood(WIRE_VERSION)).toBe(true)
    expect(isWireVersionUnderstood(WIRE_VERSION - 1)).toBe(true)
    expect(isWireVersionUnderstood(0)).toBe(true)
  })

  test("refuses a version newer than its own", () => {
    expect(isWireVersionUnderstood(WIRE_VERSION + 1)).toBe(false)
  })
})
