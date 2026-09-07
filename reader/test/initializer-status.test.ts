import { describe, expect, test } from "bun:test"

import { detectMismatch, type InitializerFileStatus } from "../src/shared/initializer-status"
import { WIRE_VERSION } from "../src/shared/wire"
import { isWireVersionUnderstood } from "../src/shared/wire-compatibility"

/**
 * #29, at its purest seam: both halves of "is the Initializer current" are plain functions
 * over plain values — no filesystem, no `EventSource`, no process — so the whole truth table
 * is driven from here the same way Seam 1 drives the fold from a fixture Sidecar.
 */

const CURRENT: InitializerFileStatus = { installed: true, current: true }
const STALE: InitializerFileStatus = { installed: true, current: false }
const NOT_INSTALLED: InitializerFileStatus = { installed: false, current: false }

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
