import { afterEach, describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import type { EvaluationEntry, Outcome, ReplSnapshot, ReplState, RubyError, RubyNode, StartedConsole } from "../src/shared/repl"
import type { Envelope } from "../src/shared/wire"
import { aRun } from "./sidecar.fixtures"
import {
  aReplSession,
  detailPanel,
  detailTab,
  lit,
  openRepl,
  openTheReader,
  replDrawer,
  replOpen,
  rowShowing,
  search,
  showDetailTab,
  treeItem,
  treeItemsOf,
  wholeText,
} from "./reader.harness"

/**
 * *Search* in the *REPL*: a term typed into the search box, and what the *Transcript*, a folded
 * drawer's header and an *Evaluation row*'s Result tab light and count, read off the rendered
 * Reader over a seeded fold and a stand-in REPL session.
 */

afterEach(() => {
  localStorage.clear()
})

const PID = 48213
const READY: ReplState = { kind: "ready", pid: PID }
const RUNNING: StartedConsole[] = [{ pid: PID, cleared: false }]

/** The console Run `PID`, booted, and the evaluation of entry `id` recorded in the Sidecar under it. */
function recorded(id: number, input: string): Envelope[] {
  const run = aRun("con-1")
  return [run.header("console", PID), run.evaluationStart(`repl-0a1b2c3d-${id}`, input), run.evaluationFinish(`repl-0a1b2c3d-${id}`)]
}

function entry(fields: Partial<EvaluationEntry>): EvaluationEntry {
  return { kind: "evaluation", id: 1, input: "Post.count", output: "", outputCut: false, outcome: null, ...fields }
}

/** A result with no structure to draw, whose `pretty_inspect` is `text`. */
function textResult(text: string): Outcome {
  return { kind: "result", className: "Object", text, cut: false, tree: { type: "object", inspect: text }, inspectError: null }
}

/** `{name: "Ada", address: {city: "Helsinki", geo: {lat: 60.1}}, tags: [:admin]}`, laid out. */
const NESTED: RubyNode = {
  type: "hash",
  inspect: '{name: "Ada", address: {city: "Helsinki", geo: {lat: 60.1}}, tags: [:admin]}',
  pairs: [
    [{ type: "symbol", inspect: ":name" }, { type: "string", inspect: '"Ada"', step: "[:name]" }],
    [
      { type: "symbol", inspect: ":address" },
      {
        type: "hash",
        inspect: '{city: "Helsinki", geo: {lat: 60.1}}',
        step: "[:address]",
        pairs: [
          [{ type: "symbol", inspect: ":city" }, { type: "string", inspect: '"Helsinki"', step: "[:city]" }],
          [
            { type: "symbol", inspect: ":geo" },
            { type: "hash", inspect: "{lat: 60.1}", step: "[:geo]", pairs: [[{ type: "symbol", inspect: ":lat" }, { type: "float", inspect: "60.1", step: "[:lat]" }]] },
          ],
        ],
      },
    ],
    [{ type: "symbol", inspect: ":tags" }, { type: "array", inspect: "[:admin]", step: "[:tags]", items: [{ type: "symbol", inspect: ":admin", step: "[0]" }] }],
  ],
}

/** An evaluation's error, with `causes` behind it. */
function raised(className: string, message: string, backtrace: string[], causes: RubyError[] = []): Outcome {
  return { kind: "error", className, message, backtrace, causes }
}

/** `count` lines, `line 1` to `line <count>`, each ended by a line break. */
function lines(count: number) {
  return Array.from({ length: count }, (_, at) => `line ${at + 1}\n`).join("")
}

/** A Hash of `count` integers, `k1: 1` onwards, as the eval loop lays it out. */
function hashOf(count: number): RubyNode {
  const pairs: [RubyNode, RubyNode][] = Array.from({ length: count }, (_, at) => [
    { type: "symbol", inspect: `:k${at + 1}` },
    { type: "integer", inspect: String(at + 1), step: `[:k${at + 1}]` },
  ])
  return { type: "hash", inspect: `{${pairs.map(([key, value]) => `${key.inspect.slice(1)}: ${value.inspect}`).join(", ")}}`, pairs }
}

function resultOf(tree: RubyNode): Outcome {
  return { kind: "result", className: "Hash", text: tree.inspect, cut: false, tree, inspectError: null }
}

/** The Reader over `envelopes`, its drawer folded on a session holding `snapshot`. */
function theFoldedReader(envelopes: Envelope[], snapshot: Partial<ReplSnapshot>) {
  const session = aReplSession({ state: READY, consoles: RUNNING, ...snapshot })
  return openTheReader(envelopes, { repl: session.repl })
}

/** The Reader over `envelopes`, its drawer open on a session holding `snapshot`. */
async function theReader(envelopes: Envelope[], snapshot: Partial<ReplSnapshot>) {
  const view = theFoldedReader(envelopes, snapshot)
  await openRepl(view.user)
  return view
}

/** The folded drawer's own button, which its count of matches describes. */
function openButton() {
  return within(replDrawer()).getByRole("button", { name: "Open REPL" })
}

/** The drawer header's count of matches, when it shows one. */
function drawerCount() {
  return within(replDrawer()).queryByText(/\bmatch(es)?$/)
}

function transcript() {
  return within(replDrawer()).getByRole("list", { name: "Transcript" })
}

function theEntry() {
  const [found] = within(transcript()).getAllByRole("listitem")
  if (found === undefined) throw new Error("the Transcript has no entry")
  return found
}

describe("Search in the Transcript", () => {
  test("lights an input, what it printed and its result's text", async () => {
    const { user } = await theReader([], {
      transcript: [entry({ input: 'Post.find_by(title: "Draft")', output: "Draft saved\n", outcome: textResult("#<Post draft>") })],
    })

    await search(user, "draft")

    expect(lit(transcript())).toEqual(["Draft", "Draft", "draft"])
  })

  test("opens a result's tree down to a deep match, and leaves its matchless siblings folded", async () => {
    const { user } = await theReader([], { transcript: [entry({ outcome: resultOf(NESTED) })] })
    const tree = within(transcript()).getByRole("tree", { name: "Result" })
    expect(treeItem(tree, "address")).toHaveAttribute("aria-expanded", "false")

    await search(user, "helsinki")

    const address = treeItem(tree, "address")
    expect(address).toHaveAttribute("aria-expanded", "true")
    expect(lit(treeItem(address, "city"))).toEqual(["Helsinki"])
    expect(treeItem(address, "geo")).toHaveAttribute("aria-expanded", "false")
    expect(treeItem(tree, "tags")).toHaveAttribute("aria-expanded", "false")
    expect(lit(tree)).toEqual(["Helsinki"])

    await search(user, "")

    expect(treeItem(tree, "address")).toHaveAttribute("aria-expanded", "false")
  })

  test("never lights the Reader's own words", async () => {
    const { user } = await theReader(recorded(1, "Post.count"), {
      transcript: [entry({ output: lines(25), outcome: textResult("3") }), entry({ id: 2, input: "exit!", outcome: { kind: "lost" } })],
    })

    expect(within(theEntry()).getByRole("button", { name: "0 queries · 0 logs" })).toBeInTheDocument()
    expect(theEntry()).toHaveTextContent("…5 more lines · open in Result")

    for (const term of ["queries", "more lines", "open in Result", "=>", "›", "exited"]) {
      await search(user, term)
      expect(lit(transcript())).toEqual([])
    }
  })

  test("opens what was printed past its cut while the term matches there, and cuts it again once cleared", async () => {
    const { user } = await theReader([], { transcript: [entry({ output: lines(25), outcome: textResult("nil") })] })

    await search(user, "line 23")

    expect(within(theEntry()).getByText(wholeText(lines(25)))).toBeInTheDocument()
    expect(lit(theEntry())).toEqual(["line 23"])
    expect(theEntry()).not.toHaveTextContent("more lines")

    await search(user, "")

    expect(within(theEntry()).queryByText(/line 23/)).not.toBeInTheDocument()
    expect(theEntry()).toHaveTextContent("…5 more lines · show all")
  })

  test("leaves the cut alone for a match inside the lines it shows", async () => {
    const { user } = await theReader([], { transcript: [entry({ output: lines(25), outcome: textResult("nil") })] })

    await search(user, "line 3")

    expect(within(theEntry()).queryByText(/line 23/)).not.toBeInTheDocument()
    expect(lit(theEntry())).toEqual(["line 3"])
    expect(theEntry()).toHaveTextContent("…5 more lines · show all")
  })

  test("opens a result's text past its cut while the term matches there", async () => {
    const { user } = await theReader([], { transcript: [entry({ outcome: textResult(lines(22)) })] })

    await search(user, "line 22")

    expect(lit(theEntry())).toEqual(["line 22"])
    expect(theEntry()).not.toHaveTextContent("more lines")
  })

  test("opens a result's tree past its cut while the term matches there, and cuts it again once cleared", async () => {
    const { user } = await theReader([], { transcript: [entry({ outcome: resultOf(hashOf(26)) })] })
    const tree = within(theEntry()).getByRole("tree", { name: "Result" })

    await search(user, "k24")

    expect(treeItemsOf(tree)).toHaveLength(26)
    expect(lit(tree)).toEqual(["k24"])
    expect(theEntry()).not.toHaveTextContent("more lines")

    await search(user, "")

    expect(treeItemsOf(tree)).toHaveLength(20)
    expect(theEntry()).toHaveTextContent("…6 more lines · show all")
  })

  test("lights an error's class, message and frames, and a cause's class and message, but never Caused by", async () => {
    const { user } = await theReader([], {
      transcript: [
        entry({
          outcome: raised("ArgumentError", "missing argument", ["(repl):1:in `argument'"], [{ className: "ArgumentError", message: "inner", backtrace: [] }]),
        }),
      ],
    })

    await search(user, "argument")
    expect(lit(theEntry())).toEqual(["Argument", "argument", "argument", "Argument"])

    await search(user, "caused")
    expect(lit(theEntry())).toEqual([])
  })

  test("opens a cause for a match in its backtrace, and folds it back once cleared", async () => {
    const { user } = await theReader([], {
      transcript: [entry({ outcome: raised("RuntimeError", "top", [], [{ className: "KeyError", message: "root", backtrace: ["(repl):7:in `lookup'"] }]) })],
    })
    const cause = within(theEntry()).getByRole("button", { name: "Caused by KeyError: root" })

    await search(user, "lookup")

    expect(cause).toHaveAttribute("aria-expanded", "true")
    expect(lit(theEntry())).toEqual(["lookup"])

    await search(user, "")

    expect(cause).toHaveAttribute("aria-expanded", "false")
    expect(within(theEntry()).queryByRole("list", { name: "Backtrace" })).not.toBeInTheDocument()
  })

  test("keeps a cause the developer folded over a match folded, counting the matches on its line", async () => {
    const { user } = await theReader([], {
      transcript: [entry({ outcome: raised("RuntimeError", "top", [], [{ className: "KeyError", message: "root", backtrace: ["(repl):7:in `lookup'"] }]) })],
    })
    await search(user, "lookup")

    await user.click(within(theEntry()).getByRole("button", { name: /^Caused by KeyError: root/ }))

    const cause = within(theEntry()).getByRole("button", { name: "Caused by KeyError: root · 1 match" })
    expect(cause).toHaveAttribute("aria-expanded", "false")
    expect(within(theEntry()).queryByRole("list", { name: "Backtrace" })).not.toBeInTheDocument()
  })
})

describe("a folded REPL drawer's count of Search matches", () => {
  test("counts every match the Transcript would light, and stays folded", async () => {
    const { user } = theFoldedReader([], {
      transcript: [
        { kind: "output", id: 1, output: "Drafts loaded\n", outputCut: false },
        entry({ id: 2, input: "Post.where(draft: true)", output: "1 draft\n" + lines(25), outcome: textResult("[#<Post draft>]") }),
      ],
    })

    await search(user, "draft")

    expect(openButton()).toHaveAccessibleDescription("4 matches")
    expect(replOpen()).toBe(false)
  })

  test("counts an error's matches, a folded cause's frames among them", async () => {
    const { user } = theFoldedReader([], {
      transcript: [
        entry({
          outcome: raised("KeyError", "key not found: :key", ["(repl):1:in `fetch_key'"], [{ className: "KeyError", message: "inner", backtrace: ["(repl):2:in `key'"] }]),
        }),
      ],
    })

    await search(user, "key")

    expect(openButton()).toHaveAccessibleDescription("6 matches")
  })

  test("counts a match deep in a result's tree, though its folds are closed", async () => {
    const { user } = theFoldedReader([], { transcript: [entry({ outcome: resultOf(NESTED) })] })

    await search(user, "helsinki")

    expect(openButton()).toHaveAccessibleDescription("1 match")
  })

  test("never counts the Reader's own words", async () => {
    const { user } = theFoldedReader([], { transcript: [entry({ output: lines(25), outcome: { kind: "lost" } })] })

    await search(user, "REPL")
    expect(drawerCount()).not.toBeInTheDocument()

    await search(user, "more lines")
    expect(drawerCount()).not.toBeInTheDocument()

    await search(user, "exited")
    expect(drawerCount()).not.toBeInTheDocument()
  })

  test("is gone once the term is cleared", async () => {
    const { user } = theFoldedReader([], { transcript: [entry({ input: "Draft.count" })] })
    await search(user, "draft")
    expect(openButton()).toHaveAccessibleDescription("1 match")

    await search(user, "")

    expect(drawerCount()).not.toBeInTheDocument()
  })
})

describe("the Result tab's count of Search matches", () => {
  test("on Timeline, equals the matches the tab lights on opening, never the input it does not show", async () => {
    const { user } = await theReader(recorded(1, "Draft.first"), {
      transcript: [entry({ input: "Draft.first", output: "Draft saved\n", outcome: textResult("#<Draft id: 1>") })],
    })
    await user.click(rowShowing("Draft.first"))

    await search(user, "draft")

    expect(detailTab("Timeline")).toHaveAttribute("aria-selected", "true")
    expect(detailTab("Result")).toHaveAccessibleDescription("2 matches")

    await showDetailTab(user, "Result")

    expect(lit(detailPanel("Result"))).toEqual(["Draft", "Draft"])
    expect(detailTab("Result")).not.toHaveAccessibleDescription()
  })

  test("counts a result as the tab shows it, pretty or raw", async () => {
    const { user } = await theReader(recorded(1, "user"), { transcript: [entry({ input: "user", outcome: resultOf(NESTED) })] })
    await user.click(rowShowing("user"))
    await search(user, "{")
    expect(detailTab("Result")).not.toHaveAccessibleDescription()

    await showDetailTab(user, "Result")
    await user.click(within(detailPanel("Result")).getByRole("button", { name: "Raw" }))
    expect(lit(detailPanel("Result"))).toEqual(["{", "{", "{"])
    await showDetailTab(user, "Timeline")

    expect(detailTab("Result")).toHaveAccessibleDescription("3 matches")
  })

  test("is gone once the term is cleared", async () => {
    const { user } = await theReader(recorded(1, "Draft.first"), { transcript: [entry({ input: "Draft.first", outcome: textResult("#<Draft>") })] })
    await user.click(rowShowing("Draft.first"))
    await search(user, "draft")
    expect(detailTab("Result")).toHaveAccessibleDescription("1 match")

    await search(user, "")

    expect(detailTab("Result")).not.toHaveAccessibleDescription()
  })
})
