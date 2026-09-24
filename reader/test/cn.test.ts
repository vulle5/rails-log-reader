import { describe, expect, test } from "bun:test"

import { cn } from "../src/ui/lib/cn"

/**
 * `cn` decides which of two classes a caller meant from their names alone, and the Reader's
 * theme names its own tokens. A token it misreads either drops a class the element needed, or
 * keeps both halves of an override and lets stylesheet order pick the winner.
 */

describe("cn", () => {
  test("joins classes and skips the falsy ones", () => {
    expect(cn("px-2", false, null, undefined, "", { "font-bold": true, italic: false })).toBe("px-2 font-bold")
  })

  test.each([
    ["text-2xs", "text-muted"],
    ["text-sm", "text-status-4xx"],
    ["text-xs", "text-method-put-patch"],
    ["text-sql-keyword", "text-base"],
    ["font-ui", "font-bold"],
    ["font-mono", "font-semibold"],
    ["leading-sql", "text-sm"],
    ["rounded-chip", "border-border"],
    ["shadow-pinned-row", "shadow-accent"],
    ["text-faint", "group-data-[state=interrupted]:text-faint!"],
  ])("keeps %s beside %s, which say different things", (first, second) => {
    expect(cn(first, second)).toBe(`${first} ${second}`)
  })

  test.each([
    ["text-muted", "text-faint"],
    ["text-sm", "text-2xs"],
    ["font-ui", "font-mono"],
    ["leading-sql", "leading-normal"],
    ["rounded-chip", "rounded"],
    ["rounded", "rounded-chip"],
    ["shadow-interrupted", "shadow-pinned-row"],
    ["bg-raised", "bg-transparent"],
    ["py-0.75", "py-2"],
  ])("lets %s give way to a later %s", (first, second) => {
    expect(cn(first, second)).toBe(second)
  })
})
