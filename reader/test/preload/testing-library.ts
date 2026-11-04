import { afterEach, expect } from "bun:test"
import * as matchers from "@testing-library/jest-dom/matchers"
import { cleanup } from "@testing-library/react"

expect.extend(matchers)

// Every test file shares one window, so what a test stores would otherwise be the next file's
// page load.
afterEach(() => {
  cleanup()
  localStorage.clear()
})
