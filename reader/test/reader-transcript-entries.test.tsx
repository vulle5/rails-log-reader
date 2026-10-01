import { afterEach, describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import { LOAD_ON_OPEN_EVENTS } from "../src/shared/bounds"
import type { EvaluationEntry, Outcome, ReplSnapshot, ReplState, RubyNode, StartedConsole, TranscriptEntry } from "../src/shared/repl"
import type { Envelope } from "../src/shared/wire"
import { Reader } from "../src/ui/Reader"
import {
  activityRows,
  aReplSession,
  column,
  detailPanel,
  detailTab,
  openRepl,
  openTheReader,
  replDrawer,
  rowShowing,
  showDetailTab,
  tab,
  treeItemsOf,
  valueTree,
  wholeText,
} from "./reader.harness"
import { aRun } from "./sidecar.fixtures"

/**
 * A *Transcript* entry's link to its *Evaluation row*, and the cut that keeps one long entry
 * from burying the rest, through the rendered Reader over a seeded fold and a stand-in *REPL*
 * session.
 */

afterEach(() => {
  localStorage.clear()
})

const PID = 48213
const READY: ReplState = { kind: "ready", pid: PID }
/** The session has run the console process `PID`, and the Transcript holds its entries. */
const RUNNING: StartedConsole[] = [{ pid: PID, cleared: false }]

/** The id the eval loop records the evaluation of entry `id` in the Sidecar under. */
function recordedAs(id: number) {
  return `repl-0a1b2c3d-${id}`
}

function entry(fields: Partial<EvaluationEntry>): EvaluationEntry {
  return { kind: "evaluation", id: 1, input: "Post.count", output: "", outputCut: false, outcome: null, ...fields }
}

const INTEGER: Outcome = { kind: "result", className: "Integer", text: "3", cut: false, tree: { type: "integer", inspect: "3" }, inspectError: null }

/** `count` lines, `line 1` to `line <count>`, each ended by a line break. */
function lines(count: number) {
  return Array.from({ length: count }, (_, at) => `line ${at + 1}\n`).join("")
}

/** A Hash of `count` integers, `:k1 => 1` onwards, as the eval loop lays it out. */
function hashOf(count: number): Outcome {
  const pairs: [RubyNode, RubyNode][] = Array.from({ length: count }, (_, at) => [
    { type: "symbol", inspect: `:k${at + 1}` },
    { type: "integer", inspect: String(at + 1), step: `[:k${at + 1}]` },
  ])
  const text = `{${pairs.map(([key, value]) => `${key.inspect.slice(1)}: ${value.inspect}`).join(", ")}}`
  return { kind: "result", className: "Hash", text, cut: false, tree: { type: "hash", inspect: text, pairs }, inspectError: null }
}

/** A result with no structure to draw, whose `pretty_inspect` is `text`. */
function textResult(text: string): Outcome {
  return { kind: "result", className: "Object", text, cut: false, tree: { type: "object", inspect: text }, inspectError: null }
}

/** The console Run `PID`, booted. */
function consoleRun() {
  const run = aRun("con-1")
  return { run, header: run.header("console", PID) }
}

/** The evaluation of entry `id`, recorded in the Sidecar with `sql` queries and `logs` log lines. */
function recorded(run: ReturnType<typeof aRun>, id: number, input: string, sql = 0, logs = 0): Envelope[] {
  return [
    run.evaluationStart(recordedAs(id), input),
    ...Array.from({ length: sql }, () => run.sql(recordedAs(id))),
    ...Array.from({ length: logs }, () => run.log(recordedAs(id))),
    run.evaluationFinish(recordedAs(id)),
  ]
}

/** Enough finished requests to push the fold past its ceiling on their own. */
function traffic(count: number) {
  const server = aRun("srv-1")
  return Array.from({ length: count }, (_, at) => [server.start(`req-${at}`, "GET", `/filler/${at}`), server.finish(`req-${at}`)]).flat()
}

/** The Reader over `batches`, its drawer open on a session holding `snapshot`: ready, and running `PID`. */
async function theReader(batches: Envelope[][], snapshot: Partial<ReplSnapshot>) {
  const session = aReplSession({ state: READY, consoles: RUNNING, ...snapshot })
  const [first = [], ...rest] = batches
  const view = openTheReader(first, { repl: session.repl })
  for (const batch of rest) view.fold.fold(batch)
  if (rest.length > 0) view.rerender(<Reader {...view.fold.props} repl={session.repl} />)
  await openRepl(view.user)
  return view
}

function transcriptEntries() {
  return within(within(replDrawer()).getByRole("list", { name: "Transcript" })).getAllByRole("listitem")
}

function theEntry(at = 0) {
  const found = transcriptEntries()[at]
  if (found === undefined) throw new Error(`the Transcript has no entry ${at}`)
  return found
}

describe("a Transcript entry's row link", () => {
  test("says its row's SQL and log counts", async () => {
    const { run, header } = consoleRun()
    await theReader([[header, ...recorded(run, 1, "Post.count", 3, 1)]], { transcript: [entry({ id: 1, outcome: INTEGER })] })

    expect(within(theEntry()).getByRole("button", { name: "3 queries · 1 log" })).toBeInTheDocument()
  })

  test("counts one query and many logs in their own words", async () => {
    const { run, header } = consoleRun()
    await theReader([[header, ...recorded(run, 1, "Post.count", 1, 2)]], { transcript: [entry({ id: 1, outcome: INTEGER })] })

    expect(within(theEntry()).getByRole("button", { name: "1 query · 2 logs" })).toBeInTheDocument()
  })

  test("selects the row on Timeline, though another tab was chosen", async () => {
    const { run, header } = consoleRun()
    const { user } = await theReader(
      [[header, ...recorded(run, 1, "Post.count", 3, 1), ...recorded(run, 2, "Comment.count", 1)]],
      { transcript: [entry({ id: 1, outcome: INTEGER }), entry({ id: 2, input: "Comment.count", outcome: INTEGER })] },
    )
    await user.click(rowShowing("Comment.count"))
    await showDetailTab(user, "Result")

    await user.click(within(theEntry(0)).getByRole("button", { name: "3 queries · 1 log" }))

    expect(rowShowing("Post.count")).toHaveAttribute("aria-selected", "true")
    expect(detailTab("Timeline")).toHaveAttribute("aria-selected", "true")
  })

  test("shows All when the row-kind tab showing hides the row", async () => {
    const { run, header } = consoleRun()
    const { user } = await theReader([[header, ...recorded(run, 1, "Post.count", 3, 1)]], { transcript: [entry({ id: 1, outcome: INTEGER })] })
    await user.click(tab("Requests"))

    await user.click(within(theEntry()).getByRole("button", { name: "3 queries · 1 log" }))

    expect(tab("All")).toHaveAttribute("aria-selected", "true")
    expect(rowShowing("Post.count")).toHaveAttribute("aria-selected", "true")
  })

  test("reads timeline no longer held, and links to nothing, once the Memory bound took the row", async () => {
    const { run, header } = consoleRun()
    await theReader([[header, ...recorded(run, 1, "Post.count", 3, 1)], traffic(LOAD_ON_OPEN_EVENTS)], {
      transcript: [entry({ id: 1, outcome: INTEGER })],
    })
    expect(activityRows().some((row) => within(row).queryByText("Post.count") !== null)).toBe(false)

    expect(within(theEntry()).getByText("timeline no longer held")).toBeInTheDocument()
    expect(within(theEntry()).queryByRole("button", { name: /quer/ })).not.toBeInTheDocument()
  })

  test("is absent for an entry with no row", async () => {
    await theReader([[]], { transcript: [entry({ id: 1, outcome: INTEGER })] })

    expect(within(theEntry()).queryByRole("button", { name: /quer/ })).not.toBeInTheDocument()
    expect(within(theEntry()).queryByText("timeline no longer held")).not.toBeInTheDocument()
  })

  test("is absent for what was printed outside any evaluation", async () => {
    const { run, header } = consoleRun()
    const standalone: TranscriptEntry = { kind: "output", id: 1, output: "Loading development environment\n", outputCut: false }
    await theReader([[header, ...recorded(run, 1, "Post.count", 3, 1)]], { transcript: [standalone] })

    expect(within(theEntry()).queryByRole("button", { name: /quer/ })).not.toBeInTheDocument()
  })

  test("is absent for a row another console process ran", async () => {
    const { run, header } = consoleRun()
    await theReader([[header, ...recorded(run, 1, "Post.count", 3, 1)]], {
      consoles: [{ pid: PID, cleared: true }, { pid: PID + 1, cleared: false }],
      state: { kind: "ready", pid: PID + 1 },
      transcript: [entry({ id: 1, outcome: INTEGER })],
    })

    expect(within(theEntry()).queryByRole("button", { name: /quer/ })).not.toBeInTheDocument()
  })
})

describe("a Transcript entry's cut", () => {
  test("cuts what was printed at 20 lines, and opens the row's Result tab for the rest", async () => {
    const { run, header } = consoleRun()
    const { user } = await theReader([[header, ...recorded(run, 1, "Post.count")]], {
      transcript: [entry({ id: 1, output: lines(25), outcome: INTEGER })],
    })

    expect(within(theEntry()).getByText(wholeText(lines(20).replace(/\n$/, "")))).toBeInTheDocument()
    expect(within(theEntry()).queryByText(/line 21/)).not.toBeInTheDocument()
    expect(theEntry()).toHaveTextContent("…5 more lines · open in Result")

    await user.click(within(theEntry()).getByRole("button", { name: "open in Result" }))

    expect(rowShowing("Post.count")).toHaveAttribute("aria-selected", "true")
    expect(detailTab("Result")).toHaveAttribute("aria-selected", "true")
    expect(within(detailPanel("Result")).getByText(wholeText(lines(25)))).toBeInTheDocument()
  })

  test("leaves 20 lines of what was printed whole", async () => {
    const { run, header } = consoleRun()
    await theReader([[header, ...recorded(run, 1, "Post.count")]], { transcript: [entry({ id: 1, output: lines(20), outcome: INTEGER })] })

    expect(within(theEntry()).getByText(wholeText(lines(20)))).toBeInTheDocument()
    expect(theEntry()).not.toHaveTextContent("more lines")
  })

  test("cuts a result's tree, as first drawn, at 20 lines", async () => {
    const { run, header } = consoleRun()
    await theReader([[header, ...recorded(run, 1, "Post.count")]], { transcript: [entry({ id: 1, outcome: hashOf(26) })] })

    const tree = within(theEntry()).getByRole("tree", { name: "Result" })
    expect(treeItemsOf(tree)).toHaveLength(20)
    expect(theEntry()).toHaveTextContent("…6 more lines · open in Result")
  })

  test("cuts a result's text at 20 lines", async () => {
    const { run, header } = consoleRun()
    await theReader([[header, ...recorded(run, 1, "Post.count")]], { transcript: [entry({ id: 1, outcome: textResult(lines(22)) })] })

    expect(within(theEntry()).queryByText(/line 21/)).not.toBeInTheDocument()
    expect(theEntry()).toHaveTextContent("…2 more lines · open in Result")
  })

  test("cuts what was printed and the result each on its own", async () => {
    const { run, header } = consoleRun()
    await theReader([[header, ...recorded(run, 1, "Post.count")]], {
      transcript: [entry({ id: 1, output: lines(23), outcome: hashOf(24) })],
    })

    expect(theEntry()).toHaveTextContent("…3 more lines · open in Result")
    expect(theEntry()).toHaveTextContent("…4 more lines · open in Result")
  })

  test("opens the rest of the result in the row's Result tab", async () => {
    const { run, header } = consoleRun()
    const { user } = await theReader([[header, ...recorded(run, 1, "Post.count")]], { transcript: [entry({ id: 1, outcome: hashOf(26) })] })

    await user.click(within(theEntry()).getByRole("button", { name: "open in Result" }))

    expect(detailTab("Result")).toHaveAttribute("aria-selected", "true")
    expect(treeItemsOf(valueTree("Result"))).toHaveLength(26)
  })

  test("never cuts what the developer opened inside the lines it shows", async () => {
    const { run, header } = consoleRun()
    const nested = hashOf(20)
    if (nested.kind !== "result" || nested.tree.pairs === undefined) throw new Error("not a hash")
    const [first] = nested.tree.pairs
    first![1] = { type: "array", inspect: "[…]", step: "[:k1]", items: Array.from({ length: 5 }, (_, at) => ({ type: "integer", inspect: String(at), step: `[${at}]` })) }
    const { user } = await theReader([[header, ...recorded(run, 1, "Post.count")]], { transcript: [entry({ id: 1, outcome: nested })] })
    const tree = within(theEntry()).getByRole("tree", { name: "Result" })
    const [k1] = treeItemsOf(tree)

    await user.click(k1!)

    expect(within(k1!).getAllByRole("treeitem")).toHaveLength(5)
    expect(treeItemsOf(tree)).toHaveLength(20)
    expect(theEntry()).not.toHaveTextContent("more lines")
  })

  test("reads show all with no row, and shows the rest in place", async () => {
    const { user } = await theReader([[]], { transcript: [entry({ id: 1, output: lines(25), outcome: hashOf(26) })] })
    expect(theEntry()).toHaveTextContent("…5 more lines · show all")
    expect(theEntry()).toHaveTextContent("…6 more lines · show all")
    const [printed, result] = within(theEntry()).getAllByRole("button", { name: "show all" })

    await user.click(printed!)

    expect(within(theEntry()).getByText(wholeText(lines(25)))).toBeInTheDocument()
    expect(within(theEntry()).getAllByRole("button", { name: "show all" })).toEqual([result!])

    await user.click(result!)

    expect(treeItemsOf(within(theEntry()).getByRole("tree", { name: "Result" }))).toHaveLength(26)
    expect(within(theEntry()).queryByRole("button", { name: "show all" })).not.toBeInTheDocument()
  })

  test("reads show all once the Memory bound took the row", async () => {
    const { run, header } = consoleRun()
    await theReader([[header, ...recorded(run, 1, "Post.count")], traffic(LOAD_ON_OPEN_EVENTS)], {
      transcript: [entry({ id: 1, output: lines(25), outcome: INTEGER })],
    })

    expect(theEntry()).toHaveTextContent("…5 more lines · show all")
  })

  test("cuts what was printed outside any evaluation, shown in place", async () => {
    const { user } = await theReader([[]], { transcript: [{ kind: "output", id: 1, output: lines(21), outputCut: false }] })
    expect(theEntry()).toHaveTextContent("…1 more line · show all")

    await user.click(within(theEntry()).getByRole("button", { name: "show all" }))

    expect(within(theEntry()).getByText(wholeText(lines(21)))).toBeInTheDocument()
  })
})

describe("the Result tab", () => {
  test("is never cut", async () => {
    const { run, header } = consoleRun()
    const { user } = await theReader([[header, ...recorded(run, 1, "Post.count")]], {
      transcript: [entry({ id: 1, output: lines(25), outcome: hashOf(26) })],
    })
    await user.click(rowShowing("Post.count"))

    await showDetailTab(user, "Result")

    expect(within(detailPanel("Result")).getByText(wholeText(lines(25)))).toBeInTheDocument()
    expect(treeItemsOf(valueTree("Result"))).toHaveLength(26)
    expect(within(column("Detail column")).queryByText(/more lines/)).not.toBeInTheDocument()
  })
})
