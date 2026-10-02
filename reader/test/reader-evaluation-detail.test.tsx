import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import type { EvaluationEntry, Outcome, ReplSnapshot, ReplState, StartedConsole } from "../src/shared/repl"
import type { Envelope } from "../src/shared/wire"
import { Reader } from "../src/ui/Reader"
import {
  activityRows,
  aReplSession,
  column,
  detailPanel,
  detailTab,
  detailTabBar,
  openRepl,
  openTheReader,
  replDrawer,
  replOpen,
  select,
  showDetailTab,
  treeItem,
  valueTree,
  wholeText,
} from "./reader.harness"
import { RUBY_HASH } from "./repl.fixtures"
import { aRun } from "./sidecar.fixtures"

/**
 * An *Evaluation row*'s *Detail column*, through the rendered Reader over a seeded fold and a
 * stand-in *REPL* session: the header saying what ran, Show in REPL, and the Result tab reading
 * the *Transcript*'s entry.
 */

/**
 * Every jump the Reader asked for, in order. Recorded rather than measured: happy-dom has no
 * layout, so "did the Transcript scroll" is a question about what was asked of the element.
 */
let jumps: Element[] = []
const scrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  jumps = []
  Element.prototype.scrollIntoView = function record(this: Element) {
    jumps.push(this)
  }
})

afterEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView
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

function result(className: string, text: string, tree = RUBY_HASH): Outcome {
  return { kind: "result", className, text, cut: false, tree, inspectError: null }
}

const INTEGER: Outcome = { kind: "result", className: "Integer", text: "3", cut: false, tree: { type: "integer", inspect: "3" }, inspectError: null }

/** The Reader over `envelopes`, the session holding `snapshot`: ready, and running `PID`, unless it says otherwise. */
function theReader(envelopes: Envelope[], snapshot: Partial<ReplSnapshot> = {}) {
  const session = (next: Partial<ReplSnapshot>) => aReplSession({ state: READY, consoles: RUNNING, ...next }).repl
  const view = openTheReader(envelopes, { repl: session(snapshot) })

  /** The fold given `batch`, and the session holding `next` in place of what it held. */
  function update(batch: Envelope[], next: Partial<ReplSnapshot>) {
    view.fold.fold(batch)
    view.rerender(<Reader {...view.fold.props} repl={session(next)} />)
  }

  return { ...view, update }
}

/** The console Run `PID`, booted. */
function consoleRun() {
  const run = aRun("con-1")
  return { run, header: run.header("console", PID) }
}

function detail() {
  return column("Detail column")
}

function transcriptEntries() {
  return within(within(replDrawer()).getByRole("list", { name: "Transcript" })).queryAllByRole("listitem")
}

function showInRepl() {
  return within(detail()).getByRole("button", { name: "Show in REPL" })
}

describe("an Evaluation row's Detail header", () => {
  test("shows the whole input, highlighted as Ruby", async () => {
    const { run, header } = consoleRun()
    const input = "post = Post.find(1)\npost.comments.count"
    const { user } = theReader([header, run.evaluationStart(recordedAs(1), input), run.evaluationFinish(recordedAs(1))])

    await user.click(activityRows().at(-1)!)

    const code = within(detail()).getByText(wholeText(input))
    expect(within(code).getByText("Post")).toHaveAttribute("data-token", "constant")
    expect(within(code).getByText("1")).toHaveAttribute("data-token", "number")
  })

  test("shows the class and message of what it raised, though the Transcript no longer holds it", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([
      header,
      run.evaluationStart(recordedAs(1), "Post.find(999)"),
      run.evaluationFinish(recordedAs(1), { outcome: "raised", class: "ActiveRecord::RecordNotFound", message: "Couldn't find Post with 'id'=999" }),
    ])

    await select(user, "Post.find(999)")

    expect(within(detail()).getByText("ActiveRecord::RecordNotFound")).toBeInTheDocument()
    expect(within(detail()).getByText("Couldn't find Post with 'id'=999")).toBeInTheDocument()
  })

  test("shows no error for an evaluation that finished ok", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))])

    await select(user, "Post.count")

    expect(within(detail()).queryByText(/Error|raised/)).not.toBeInTheDocument()
  })

  test("opens a folded drawer at the entry on Show in REPL", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], {
      transcript: [entry({ id: 1, input: "Post.count", outcome: INTEGER }), entry({ id: 2, input: "Comment.count", outcome: INTEGER })],
    })
    await select(user, "Post.count")
    expect(replOpen()).toBe(false)

    await user.click(showInRepl())

    expect(replOpen()).toBe(true)
    expect(jumps.at(-1)).toBe(transcriptEntries()[0])
  })

  test("takes an open drawer to the entry on Show in REPL", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(2), "Comment.count"), run.evaluationFinish(recordedAs(2))], {
      transcript: [entry({ id: 1, input: "Post.count", outcome: INTEGER }), entry({ id: 2, input: "Comment.count", outcome: INTEGER })],
    })
    await openRepl(user)
    await select(user, "Comment.count")

    await user.click(showInRepl())

    expect(jumps.at(-1)).toBe(transcriptEntries()[1])
  })

  test("offers no Show in REPL once the Transcript no longer holds the entry", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], { transcript: [] })

    await select(user, "Post.count")

    expect(within(detail()).queryByRole("button", { name: "Show in REPL" })).not.toBeInTheDocument()
  })
})

describe("an Evaluation row's Detail tabs", () => {
  test("read Timeline | Result, with Timeline showing", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], {
      transcript: [entry({ id: 1, outcome: INTEGER })],
    })

    await select(user, "Post.count")

    const tabs = within(detailTabBar()).getAllByRole("tab")
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveTextContent(/^Timeline$/)
    expect(tabs[1]).toHaveTextContent(/^Result/)
    expect(detailTab("Timeline")).toHaveAttribute("aria-selected", "true")
  })

  test("keep Result across a Selection of another Evaluation row, and show Timeline on a Request row", async () => {
    const { run, header } = consoleRun()
    const server = aRun("srv-1")
    const { user } = theReader(
      [
        header,
        run.evaluationStart(recordedAs(1), "Post.count"),
        run.evaluationFinish(recordedAs(1)),
        run.evaluationStart(recordedAs(2), "Comment.count"),
        run.evaluationFinish(recordedAs(2)),
        server.start("req-1", "GET", "/posts"),
        server.finish("req-1"),
      ],
      { transcript: [entry({ id: 1, outcome: INTEGER }), entry({ id: 2, input: "Comment.count", outcome: INTEGER })] },
    )
    await select(user, "Post.count")
    await showDetailTab(user, "Result")

    await select(user, "Comment.count")
    expect(detailTab("Result")).toHaveAttribute("aria-selected", "true")

    await select(user, "/posts")
    expect(detailTab("Timeline")).toHaveAttribute("aria-selected", "true")

    await select(user, "Post.count")
    expect(detailTab("Result")).toHaveAttribute("aria-selected", "true")
  })
})

describe("the Result tab", () => {
  test("shows what the evaluation printed, then its result as a tree", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], {
      transcript: [entry({ id: 1, output: "counting…\n", outcome: result("Hash", RUBY_HASH.inspect) })],
    })
    await select(user, "Post.count")

    await showDetailTab(user, "Result")

    const printed = within(detailPanel("Result")).getByText(wholeText("counting…\n"))
    const tree = valueTree("Result")
    expect(detailPanel("Result")).toContainElement(tree)
    expect(printed.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test("has folds and a Pretty | Raw of its own, apart from the Transcript's", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], {
      transcript: [entry({ id: 1, outcome: result("Hash", RUBY_HASH.inspect) })],
    })
    await openRepl(user)
    await select(user, "Post.count")
    await showDetailTab(user, "Result")
    const inTranscript = () => within(transcriptEntries()[0]!)

    await user.click(treeItem(valueTree("Result"), '"b"'))

    expect(treeItem(valueTree("Result"), '"b"')).toHaveAttribute("aria-expanded", "true")
    expect(treeItem(inTranscript().getByRole("tree", { name: "Result" }), '"b"')).toHaveAttribute("aria-expanded", "false")

    await user.click(within(detailPanel("Result")).getByRole("button", { name: "Raw" }))

    expect(within(detailPanel("Result")).getByText(RUBY_HASH.inspect)).toBeInTheDocument()
    expect(inTranscript().getByRole("button", { name: "Pretty" })).toHaveAttribute("aria-pressed", "true")
  })

  test("copies what is showing, and confirms it", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], {
      transcript: [entry({ id: 1, outcome: result("Hash", "{a: 1,\n \"b\" => [1.0, nil, :c]}\n") })],
    })
    await select(user, "Post.count")
    await showDetailTab(user, "Result")
    const copy = () => within(detailPanel("Result")).getByRole("button", { name: "Copy result" })

    await user.click(copy())

    expect(await navigator.clipboard.readText()).toBe(RUBY_HASH.inspect)
    expect(copy()).toHaveTextContent("Copied")

    await user.click(within(detailPanel("Result")).getByRole("button", { name: "Raw" }))
    await user.click(copy())

    expect(await navigator.clipboard.readText()).toBe("{a: 1,\n \"b\" => [1.0, nil, :c]}\n")
    expect(copy()).toHaveTextContent("Copied")
  })

  test("shows the error an evaluation raised, with its backtrace", async () => {
    const { run, header } = consoleRun()
    const raised: Outcome = { kind: "error", className: "RuntimeError", message: "boom", backtrace: ["(repl):1:in `<main>'"], causes: [] }
    const { user } = theReader(
      [header, run.evaluationStart(recordedAs(1), 'raise "boom"'), run.evaluationFinish(recordedAs(1), { outcome: "raised", class: "RuntimeError", message: "boom" })],
      { transcript: [entry({ id: 1, input: 'raise "boom"', outcome: raised })] },
    )
    await select(user, 'raise "boom"')

    await showDetailTab(user, "Result")

    expect(within(detailPanel("Result")).getByText("RuntimeError: boom")).toBeInTheDocument()
    expect(within(detailPanel("Result")).getByText(/\(repl\):1/)).toBeInTheDocument()
  })

  test("is labelled with the result's class", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], {
      transcript: [entry({ id: 1, outcome: result("Hash", RUBY_HASH.inspect) })],
    })

    await select(user, "Post.count")

    expect(detailTab("Result")).toHaveAccessibleName("Result Hash")
  })

  test("is labelled raised when the evaluation raised, though the Transcript no longer holds it", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader(
      [header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1), { outcome: "raised", class: "RuntimeError", message: "boom" })],
      { transcript: [] },
    )

    await select(user, "Post.count")

    expect(detailTab("Result")).toHaveAccessibleName("Result raised")
  })

  test("waits while the evaluation runs, and shows its result once it finishes", async () => {
    const { run, header } = consoleRun()
    const { user, update } = theReader([header, run.evaluationStart(recordedAs(1))], {
      state: { kind: "busy", pid: PID, id: 1, since: Date.now() },
      transcript: [entry({ id: 1 })],
    })
    await select(user, "Post.count")
    await showDetailTab(user, "Result")

    expect(within(detailPanel("Result")).getByText("Waiting for the evaluation to finish…")).toBeInTheDocument()
    expect(detailTab("Result")).toHaveAccessibleName("Result")

    update([run.evaluationFinish(recordedAs(1))], { transcript: [entry({ id: 1, outcome: INTEGER })] })

    expect(within(detailPanel("Result")).getByText("3")).toBeInTheDocument()
    expect(detailTab("Result")).toHaveAccessibleName("Result Integer")
  })

  test("says a Restart cleared the entry", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], {
      consoles: [{ pid: PID, cleared: true }, { pid: PID + 1, cleared: false }],
      transcript: [],
    })
    await select(user, "Post.count")

    await showDetailTab(user, "Result")

    expect(detailPanel("Result")).toHaveTextContent("The REPL was restarted after this ran, which cleared its result.")
  })

  test("says the Transcript dropped the entry as one of its oldest", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], { transcript: [] })
    await select(user, "Post.count")

    await showDetailTab(user, "Result")

    expect(detailPanel("Result")).toHaveTextContent("The REPL keeps only its latest 100 entries, and this one was dropped as one of the oldest.")
  })

  test("says the entry is from a console this Reader didn't run", async () => {
    const { run, header } = consoleRun()
    const { user } = theReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], { consoles: [], transcript: [] })
    await select(user, "Post.count")

    await showDetailTab(user, "Result")

    expect(detailPanel("Result")).toHaveTextContent("This ran in a console this Reader didn't start, so its result isn't here.")
  })

  test("says where results are shown on a page that may not act", async () => {
    const { run, header } = consoleRun()
    const { user } = openTheReader([header, run.evaluationStart(recordedAs(1)), run.evaluationFinish(recordedAs(1))], {
      actsOnlyFrom: "localhost:5273",
    })
    await select(user, "Post.count")

    await showDetailTab(user, "Result")

    expect(detailPanel("Result")).toHaveTextContent("Results are shown on localhost:5273, where the REPL runs.")
  })
})
