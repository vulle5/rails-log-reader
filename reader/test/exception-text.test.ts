import { describe, expect, test } from "bun:test"

import { exceptionText } from "../src/ui/features/detail-column/lib/exception-text"

/**
 * What the Exception block's copy control puts on the clipboard: a plain-text reconstruction
 * meant for a bug tracker, a colleague's chat, or an AI assistant — the class and message on
 * one line, one backtrace frame per line, real newlines, no severity labels and no markup.
 */
describe("reconstructing an exception as plain text", () => {
  test("puts the class and message on the first line, one frame per line after it", () => {
    const text = exceptionText(
      {
        class: "NoMethodError",
        message: "undefined method `price_cents' for nil",
        backtrace: [
          "app/models/order.rb:44:in `block in recalculate_total!'",
          "actionpack (8.0.2) lib/action_controller/metal/rescue.rb:23:in `process_action'",
        ],
      },
      null,
    )

    expect(text).toBe(
      [
        "NoMethodError: undefined method `price_cents' for nil",
        "app/models/order.rb:44:in `block in recalculate_total!'",
        "actionpack (8.0.2) lib/action_controller/metal/rescue.rb:23:in `process_action'",
      ].join("\n"),
    )
  })

  test("says nothing extra when the backtrace arrived whole", () => {
    const text = exceptionText({ class: "RuntimeError", message: "boom", backtrace: ["order.rb:1"] }, null)

    expect(text.endsWith("order.rb:1")).toBe(true)
    expect(text).not.toContain("cut")
  })

  test("ends with a comment line when the Sidecar cut the backtrace, matching the on-screen wording", () => {
    const text = exceptionText(
      { class: "RuntimeError", message: "boom", backtrace: ["order.rb:1"] },
      300_000,
    )

    expect(text).toBe(["RuntimeError: boom", "order.rb:1", "# backtrace was cut by the Sidecar — 293 KB was emitted"].join("\n"))
  })

  // `#` marks it as a comment rather than one more real frame, so a paste never silently
  // claims to be the whole trace when it is not.
  test("prefixes the cut line with a comment marker, never bare like a frame", () => {
    const text = exceptionText({ class: "RuntimeError", message: "boom", backtrace: [] }, 900)

    expect(text.split("\n").at(-1)).toStartWith("# ")
  })
})
