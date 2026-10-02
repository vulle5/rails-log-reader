import { describe, expect, test } from "bun:test"

import { isLoopbackHostname } from "../src/shared/loopback"

/** The one rule the server asks of a request's `Host` and the page of its own address. */
describe("a loopback hostname", () => {
  test("is localhost or 127.0.0.1", () => {
    expect(isLoopbackHostname("localhost")).toBe(true)
    expect(isLoopbackHostname("127.0.0.1")).toBe(true)
  })

  test("is nothing else, however local it looks", () => {
    for (const hostname of ["tunnel.example", "app.localhost", "127.0.0.2", "[::1]", "localhost.", "0.0.0.0"]) {
      expect(isLoopbackHostname(hostname)).toBe(false)
    }
  })
})
