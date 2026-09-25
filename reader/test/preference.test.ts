import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { recallPreference, rememberPreference } from "../src/ui/lib/preference"

/**
 * Every Reader-side preference is a few bytes read before first paint, and `localStorage`
 * throws outright in a browser with site data blocked. A preference that cannot be read is
 * its default, and one that cannot be written still applies for the session.
 */

const asIs = (stored: string) => stored

beforeEach(() => localStorage.clear())

describe("recallPreference", () => {
  test("reads the stored value under the setting's own namespaced key", () => {
    localStorage.setItem("rails-log-reader.theme", "dark")

    expect(recallPreference("theme", "system", asIs)).toBe("dark")
  })

  test("is the default when nothing is stored", () => {
    expect(recallPreference("theme", "system", asIs)).toBe("system")
  })

  test("is the default when the stored value does not parse", () => {
    localStorage.setItem("rails-log-reader.console-filter", "{not json")

    expect(recallPreference("console-filter", "opening", (stored) => JSON.parse(stored))).toBe("opening")
  })

  test("keeps settings apart", () => {
    localStorage.setItem("rails-log-reader.theme", "dark")

    expect(recallPreference("editor-scheme", null, asIs)).toBeNull()
  })
})

describe("rememberPreference", () => {
  test("writes under the setting's namespaced key", () => {
    rememberPreference("detail-filter", '{"showingSchema":true}')

    expect(localStorage.getItem("rails-log-reader.detail-filter")).toBe('{"showingSchema":true}')
  })

  test("removes the setting when remembered as null", () => {
    localStorage.setItem("rails-log-reader.editor-scheme", "vscode://file{path}")

    rememberPreference("editor-scheme", null)

    expect(localStorage.getItem("rails-log-reader.editor-scheme")).toBeNull()
  })
})

describe("with site data blocked", () => {
  const { getItem, setItem, removeItem } = Storage.prototype

  beforeEach(() => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError")
    }
    Storage.prototype.getItem = blocked
    Storage.prototype.setItem = blocked
    Storage.prototype.removeItem = blocked
  })

  afterEach(() => {
    Object.assign(Storage.prototype, { getItem, setItem, removeItem })
  })

  test("recalling is the default", () => {
    expect(recallPreference("theme", "system", asIs)).toBe("system")
  })

  test("remembering, or forgetting, does not throw", () => {
    expect(() => rememberPreference("theme", "dark")).not.toThrow()
    expect(() => rememberPreference("editor-scheme", null)).not.toThrow()
  })
})
