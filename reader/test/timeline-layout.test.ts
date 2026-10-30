import { describe, expect, test } from "bun:test"

import { aRun } from "./sidecar.fixtures"
import type { TimelineEvent } from "../src/shared/activity"
import { segmentBacktrace } from "../src/ui/lib/backtrace"
import { entryHeight, timelineLayout, type TimelineContent } from "../src/ui/features/detail-column/lib/timeline-layout"

/**
 * Seam 2: where each block of a Timeline tab sits, estimated from its own data, because a DOM
 * with no layout cannot say and a browser says only once it has laid the block out.
 */

const WIDE = 720
const NARROW = 320

const run = aRun("srv-1")
const SHORT = 'SELECT "posts".* FROM "posts" WHERE "posts"."id" = ?'
const LONG = `SELECT ${Array.from({ length: 40 }, (_, at) => `"posts"."column_${at}"`).join(", ")} FROM "posts"`

/** A query with nothing under its statement unless a test adds it. */
function query(sql = SHORT, payload: Parameters<typeof run.sql>[2] = {}) {
  return run.sql("req-1", sql, { binds: [], ...payload })
}

function content(timeline: readonly TimelineEvent[], more: Partial<TimelineContent> = {}): TimelineContent {
  return { timeline, exception: null, trailing: [], ...more }
}

function offsets(content: TimelineContent, width = WIDE) {
  return timelineLayout(content, width).blocks.map((block) => block.offset)
}

function fractions(content: TimelineContent, width = WIDE) {
  return timelineLayout(content, width).blocks.map((block) => block.fraction)
}

describe("estimating an entry", () => {
  test("gives the same height for the same entry and width every time", () => {
    const entry = query(LONG, { binds: [12, "draft"], callsite: "app/models/post.rb:12:in 'published'" })
    expect(entryHeight(entry, WIDE)).toBe(entryHeight(structuredClone(entry), WIDE))
  })

  test("estimates a longer statement taller than a short one at the same width", () => {
    expect(entryHeight(query(LONG), WIDE)).toBeGreaterThan(entryHeight(query(SHORT), WIDE))
  })

  test("estimates a longer message taller than a short one at the same width", () => {
    const short = run.log("req-1", "Rendering posts/show")
    const long = run.log("req-1", `Parameters: ${"{ \"id\" => \"12\" } ".repeat(40)}`)
    expect(entryHeight(long, WIDE)).toBeGreaterThan(entryHeight(short, WIDE))
  })

  test("estimates a wrapping entry taller at a narrower width", () => {
    expect(entryHeight(query(LONG), NARROW)).toBeGreaterThan(entryHeight(query(LONG), WIDE))
    const long = run.log("req-1", "word ".repeat(80))
    expect(entryHeight(long, NARROW)).toBeGreaterThan(entryHeight(long, WIDE))
  })

  test("leaves a one-line entry the same height at a narrower width", () => {
    expect(entryHeight(query("BEGIN"), NARROW)).toBe(entryHeight(query("BEGIN"), WIDE))
    expect(entryHeight(run.log("req-1", "Hi"), NARROW)).toBe(entryHeight(run.log("req-1", "Hi"), WIDE))
  })

  test("counts each line of a statement written across several", () => {
    expect(entryHeight(query("SELECT 1\nFROM posts\nWHERE id = 1"), WIDE)).toBeGreaterThan(entryHeight(query("SELECT 1"), WIDE))
  })

  test.each([
    ["binds", query(SHORT, { binds: [12, "draft"] })],
    ["a Callsite", query(SHORT, { callsite: "app/models/post.rb:12:in 'published'" })],
    ["a cut notice", { ...query(SHORT), truncated: { sql: 70_000 } }],
  ])("adds %s to a query's estimate", (_, entry) => {
    expect(entryHeight(entry, WIDE)).toBeGreaterThan(entryHeight(query(SHORT), WIDE))
  })

  test("estimates more binds than fit on a line taller than those that do", () => {
    const few = query(SHORT, { binds: [1, 2] })
    const many = query(SHORT, { binds: Array.from({ length: 60 }, (_, at) => `value-${at}`) })
    expect(entryHeight(many, WIDE)).toBeGreaterThan(entryHeight(few, WIDE))
  })

  test.each([
    ["a Callsite", run.log("req-1", "Hi", { callsite: "app/controllers/posts_controller.rb:4:in 'show'" })],
    ["a cut notice", { ...run.log("req-1", "Hi"), truncated: { message: 70_000 } }],
    ["tags", run.log("req-1", "word ".repeat(30), { tags: ["7f3c9a1e-2b4d-4f6a-9c8e-1a2b3c4d5e6f", "www.example.test"] })],
  ])("adds %s to a log line's estimate", (_, entry) => {
    const bare = run.log("req-1", entry.payload.message)
    expect(entryHeight(entry, NARROW)).toBeGreaterThan(entryHeight(bare, NARROW))
  })

  test("sets a log line's cut notice beside a message it leaves room for", () => {
    const line = run.log("req-1", "Hi")
    expect(entryHeight({ ...line, truncated: { message: 70_000 } }, WIDE)).toBe(entryHeight(line, WIDE))
  })

  test("wraps tags that do not fit beside the severity onto lines of their own", () => {
    const tags = (count: number) => Array.from({ length: count }, (_, at) => `tenant-${at}`)
    expect(entryHeight(run.log("req-1", "Hi", { tags: tags(20) }), NARROW)).toBeGreaterThan(
      entryHeight(run.log("req-1", "Hi", { tags: tags(2) }), NARROW),
    )
  })

  test("adds nothing for a rails-sourced line's Callsite, which is never shown", () => {
    const line = run.log("req-1", "Hi", { source: "rails" })
    const located = run.log("req-1", "Hi", { source: "rails", callsite: "actionpack/lib/action_controller.rb:1:in 'process'" })
    expect(entryHeight(located, WIDE)).toBe(entryHeight(line, WIDE))
  })
})

describe("laying out a timeline", () => {
  const entries = [query(), run.log("req-1", "Hi"), query(LONG), query("COMMIT")]

  test("gives the same offsets and fractions for the same content every time", () => {
    expect(timelineLayout(content(entries), WIDE)).toEqual(timelineLayout(content(structuredClone(entries)), WIDE))
  })

  test("places entries one after another in timeline order, each at its estimate below the last", () => {
    const { blocks } = timelineLayout(content(entries), WIDE)
    expect(blocks.map((block) => block.kind === "entry" && block.event)).toEqual(entries)
    expect(blocks[0]!.offset).toBe(0)
    for (const [at, block] of blocks.entries()) {
      expect(block.height).toBe(entryHeight(entries[at]!, WIDE))
      if (at > 0) expect(block.offset).toBe(blocks[at - 1]!.offset + blocks[at - 1]!.height)
    }
  })

  test("places each block at its offset as a fraction of the total", () => {
    const layout = timelineLayout(content(entries), WIDE)
    const at = fractions(content(entries))
    expect(at).toEqual(layout.blocks.map((block) => block.offset / layout.total))
    expect(at).toEqual(at.toSorted((a, b) => a - b))
    expect(at.every((fraction) => fraction >= 0 && fraction < 1)).toBe(true)
  })

  test("rescales every fraction for an arriving entry and leaves earlier offsets alone", () => {
    const before = content(entries)
    const after = content([...entries, query(LONG)])
    expect(offsets(after).slice(0, entries.length)).toEqual(offsets(before))
    const scaled = fractions(after).slice(1, entries.length)
    for (const [at, fraction] of fractions(before).slice(1).entries()) expect(scaled[at]).toBeLessThan(fraction)
  })

  test("moves every later block up by the estimate of an entry left out", () => {
    const [first, hidden, ...rest] = [query(), query(LONG, { cached: true }), query(), run.log("req-1", "Hi"), query("COMMIT")]
    const all = offsets(content([first!, hidden!, ...rest]))
    const thinned = offsets(content([first!, ...rest]))
    const height = entryHeight(hidden!, WIDE)
    const expected = [all[0]!, ...all.slice(2).map((offset) => offset - height)]
    expect(thinned).toHaveLength(expected.length)
    for (const [at, offset] of thinned.entries()) expect(offset).toBeCloseTo(expected[at]!, 9)
  })

  test("gives a timeline of nothing but marked statements a block per entry", () => {
    const writes = Array.from({ length: 500 }, (_, at) => query(`UPDATE "posts" SET "views" = ${at}`))
    expect(timelineLayout(content(writes), WIDE).blocks).toHaveLength(500)
  })

  test("estimates a narrower column taller", () => {
    const wide = timelineLayout(content([query(LONG)]), WIDE)
    const narrow = timelineLayout(content([query(LONG)]), NARROW)
    expect(narrow.total).toBeGreaterThan(wide.total)
  })
})

describe("laying out what follows the timeline", () => {
  const RAILS_ROOT = "/home/dev/example-app"
  const BACKTRACE = [
    `${RAILS_ROOT}/app/controllers/posts_controller.rb:12:in 'show'`,
    "/gems/actionpack-8.0.2/lib/action_controller/metal/basic_implicit_render.rb:8:in 'send_action'",
    "/gems/actionpack-8.0.2/lib/abstract_controller/base.rb:226:in 'process_action'",
    "/gems/actionpack-8.0.2/lib/action_controller/metal/rendering.rb:193:in 'process_action'",
    `${RAILS_ROOT}/app/middleware/timing.rb:9:in 'call'`,
  ]
  const segments = segmentBacktrace(BACKTRACE, RAILS_ROOT)
  const exception = (opened: ReadonlySet<number> = new Set()) => ({
    exception: { class: "ActiveRecord::RecordNotFound", message: "Couldn't find Post with 'id'=12" },
    segments,
    opened,
    cut: false,
  })
  const entries = [query(), run.log("req-1", "Hi")]

  test("places the exception block under the timeline, and the trailing section's caption and entries under that", () => {
    const trailing = [run.log("req-1", "Completed"), query("COMMIT")]
    const { blocks } = timelineLayout(content(entries, { exception: exception(), trailing }), WIDE)
    expect(blocks.map((block) => (block.kind === "entry" ? block.section : block.kind))).toEqual([
      "timeline",
      "timeline",
      "exception",
      "caption",
      "trailing",
      "trailing",
    ])
    expect(blocks.map((block) => block.offset)).toEqual(blocks.map((block) => block.offset).toSorted((a, b) => a - b))
  })

  test("gives an empty trailing section no caption", () => {
    const { blocks } = timelineLayout(content(entries), WIDE)
    expect(blocks.some((block) => block.kind === "caption")).toBe(false)
  })

  test("grows the exception block for an opened gem-frame marker", () => {
    const gap = segments.find((segment) => segment.type === "gap")!
    const height = (opened: ReadonlySet<number>) =>
      timelineLayout(content(entries, { exception: exception(opened) }), WIDE).blocks.find((block) => block.kind === "exception")!.height
    expect(height(new Set([gap.from]))).toBeGreaterThan(height(new Set()))
  })

  test("folds an exception message's line breaks into spaces, as its line does", () => {
    const height = (message: string) =>
      timelineLayout(content([], { exception: { ...exception(), exception: { class: "PG::Error", message } } }), WIDE).blocks[0]!.height
    expect(height("ERROR: syntax error\nLINE 1: SELECT")).toBe(height("ERROR: syntax error LINE 1: SELECT"))
  })

  test("grows the exception block for a cut backtrace", () => {
    const height = (cut: boolean) =>
      timelineLayout(content([], { exception: { ...exception(), cut } }), WIDE).blocks.find((block) => block.kind === "exception")!
        .height
    expect(height(true)).toBeGreaterThan(height(false))
  })

  test("counts the exception block and the trailing section in the total", () => {
    const alone = timelineLayout(content(entries), WIDE).total
    const raised = timelineLayout(content(entries, { exception: exception() }), WIDE).total
    const trailed = timelineLayout(content(entries, { exception: exception(), trailing: [query()] }), WIDE).total
    expect(raised).toBeGreaterThan(alone)
    expect(trailed).toBeGreaterThan(raised)
  })
})
