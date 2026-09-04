import { describe, expect, test } from "bun:test"

import { EVENT_TYPES, WIRE_VERSION } from "../src/shared/wire"
import { SAMPLE_ENVELOPES } from "./wire.fixtures"

const SPEC_EVENT_TYPES = [
  "app_log",
  "request_finish",
  "request_route",
  "request_start",
  "run_end",
  "run_header",
  "sql",
]

describe("the wire contract", () => {
  test("names every event type the Initializer emits, run_end among them", () => {
    const declared: string[] = [...EVENT_TYPES]
    expect(declared.sort()).toEqual(SPEC_EVENT_TYPES)
  })

  test("carries a sample envelope for every event type", () => {
    const sampled: string[] = SAMPLE_ENVELOPES.map((envelope) => envelope.type)
    expect(sampled.sort()).toEqual(SPEC_EVENT_TYPES)
  })

  test("stamps every envelope with the schema version", () => {
    for (const envelope of SAMPLE_ENVELOPES) expect(envelope.v).toBe(WIRE_VERSION)
  })

  test("survives a Sidecar round trip: one line in, the same envelope out", () => {
    for (const envelope of SAMPLE_ENVELOPES) {
      const line = JSON.stringify(envelope)
      expect(line).not.toContain("\n")
      expect(JSON.parse(line)).toEqual(envelope)
    }
  })
})
