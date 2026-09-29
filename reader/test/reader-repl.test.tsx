import { afterEach, describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import type { Outcome, ReplSnapshot, ReplState, RubyNode, TranscriptEntry } from "../src/shared/repl"
import { Reader } from "../src/ui/Reader"
import { aReplSession, openRepl, openTheReader, replDrawer, type ReaderProps } from "./reader.harness"
import { RUBY_HASH } from "./repl.fixtures"

/**
 * The *REPL* in its drawer, through the rendered Reader over a stand-in session: the console
 * process's state in the header, the prompt, and the *Transcript*.
 */

afterEach(() => {
  localStorage.clear()
})

const PID = 48213
const READY: ReplState = { kind: "ready", pid: PID }
const EXITED: ReplState = { kind: "exited", code: 1, signal: null, stderr: "" }

/** The Reader with its drawer open, over a session holding `snapshot`. */
async function openedOver(...args: Parameters<typeof aReplSession>) {
  const session = aReplSession(...args)
  const view = openTheReader([], { repl: session.repl })
  await openRepl(view.user)
  return { ...view, ...session }
}

function prompt() {
  return within(replDrawer()).getByRole("textbox", { name: "Ruby" })
}

function hintRow() {
  return within(replDrawer()).getByRole("status")
}

function sandboxToggle() {
  return within(replDrawer()).getByRole("checkbox", { name: "Sandbox" })
}

function restartButton() {
  return within(replDrawer()).getByRole("button", { name: "Restart" })
}

function transcriptEntries() {
  return within(within(replDrawer()).getByRole("list", { name: "Transcript" })).queryAllByRole("listitem")
}

/** A result whose value is `tree`, by default a structureless leaf of its text. */
function result(text: string, tree: RubyNode = { type: "object", inspect: text }, inspectError: string | null = null): Extract<Outcome, { kind: "result" }> {
  return { kind: "result", text, cut: false, tree, inspectError }
}

function evaluation(entry: Partial<Extract<TranscriptEntry, { kind: "evaluation" }>>): TranscriptEntry {
  return { kind: "evaluation", id: 1, input: "1 + 1", output: "", outputCut: false, outcome: null, ...entry }
}

describe("the REPL drawer's header", () => {
  test("says nothing before the console process has been started", () => {
    openTheReader([], { repl: aReplSession().repl })

    expect(within(replDrawer()).queryByText(/booting|pid|running|exited/)).not.toBeInTheDocument()
  })

  test("says what the console process is doing, with a dot that repeats it", () => {
    const states: [ReplState, string][] = [
      [{ kind: "booting" }, "booting…"],
      [READY, `pid ${PID}`],
      [{ kind: "busy", pid: PID, id: 1, since: Date.now() - 42_000 }, `running 0:42 · pid ${PID}`],
      [{ kind: "busy", pid: PID, id: 1, since: Date.now() - 125_000 }, `running 2:05 · pid ${PID}`],
      [EXITED, "exited 1"],
      [{ kind: "exited", code: null, signal: "SIGKILL", stderr: "" }, "exited SIGKILL"],
      [{ kind: "exited", code: null, signal: null, stderr: "" }, "exited"],
    ]

    for (const [state, says] of states) {
      const { unmount } = openTheReader([], { repl: aReplSession({ state }).repl })

      expect(within(replDrawer()).getByText(says)).toHaveAttribute("data-state", state.kind)
      unmount()
    }
  })

  test("says it while the drawer is folded too", () => {
    openTheReader([], { repl: aReplSession({ state: READY }).repl })

    expect(within(replDrawer()).getByText(`pid ${PID}`)).toBeInTheDocument()
  })

  test("wears a sandbox tag whenever the running console process is sandboxed", () => {
    const shows: [Partial<ReplSnapshot>, boolean][] = [
      [{ state: { kind: "booting" }, sandbox: true }, true],
      [{ state: READY, sandbox: true }, true],
      [{ state: { kind: "busy", pid: PID, id: 1, since: Date.now() }, sandbox: true }, true],
      [{ state: EXITED, sandbox: true }, false],
      [{ state: READY, sandbox: false }, false],
    ]

    for (const [snapshot, tagged] of shows) {
      const { unmount } = openTheReader([], { repl: aReplSession(snapshot).repl })

      if (tagged) expect(within(replDrawer()).getByText("sandbox")).toBeInTheDocument()
      else expect(within(replDrawer()).queryByText("sandbox")).not.toBeInTheDocument()
      unmount()
    }
  })
})

describe("a REPL whose console process exited", () => {
  test("shows its exit status and what it printed on stderr", async () => {
    await openedOver({ state: { kind: "exited", code: 1, signal: null, stderr: "config/application.rb:1: boom (RuntimeError)\n" } })

    expect(within(replDrawer()).getByText("The REPL exited with status 1.")).toBeInTheDocument()
    expect(within(replDrawer()).getByText("config/application.rb:1: boom (RuntimeError)")).toBeInTheDocument()
    expect(restartButton()).toBeInTheDocument()
  })

  test("says which signal ended it", async () => {
    await openedOver({ state: { kind: "exited", code: null, signal: "SIGKILL", stderr: "" } })

    expect(within(replDrawer()).getByText("The REPL was ended by SIGKILL.")).toBeInTheDocument()
  })

  test("says why one that could not be started never started", async () => {
    await openedOver({ state: { kind: "exited", code: null, signal: null, stderr: "EACCES: permission denied, posix_spawn 'bin/rails'" } })

    expect(within(replDrawer()).getByText("The REPL could not start.")).toBeInTheDocument()
    expect(within(replDrawer()).getByText("EACCES: permission denied, posix_spawn 'bin/rails'")).toBeInTheDocument()
  })

  test("is started again by Restart", async () => {
    const { user, asked } = await openedOver({ state: EXITED })

    await user.click(restartButton())

    expect(asked.restarts).toEqual([false])
  })
})

describe("the REPL's Restart", () => {
  test("asks for a fresh console process while one is running", async () => {
    const { user, asked } = await openedOver({ state: READY })

    await user.click(restartButton())

    expect(asked.restarts).toEqual([false])
  })

  test("has its sandbox toggle off by default, and asks for a sandboxed console process once it is on", async () => {
    const { user, asked } = await openedOver({ state: READY })
    expect(sandboxToggle()).not.toBeChecked()

    await user.click(sandboxToggle())
    await user.click(restartButton())

    expect(asked.restarts).toEqual([true])
  })

  test("leaves the running console process alone when the toggle changes", async () => {
    const { user, asked } = await openedOver({ state: READY })

    await user.click(sandboxToggle())

    expect(asked.restarts).toEqual([])
    expect(within(replDrawer()).queryByText("sandbox")).not.toBeInTheDocument()
  })

  test("starts its toggle at the session's choice", async () => {
    await openedOver({ state: READY, sandbox: true })

    expect(sandboxToggle()).toBeChecked()
  })
})

describe("the REPL's console process", () => {
  test("is asked to start when the drawer opens", async () => {
    const { asked } = await openedOver()

    expect(asked.boots).toBeGreaterThan(0)
  })

  test("is never asked to start while the drawer stays folded", () => {
    const { repl, asked } = aReplSession()

    openTheReader([], { repl })

    expect(asked.boots).toBe(0)
  })
})

describe("the REPL's prompt", () => {
  test("runs what is typed on Enter, and empties", async () => {
    const { user, asked } = await openedOver({ state: READY })

    await user.type(prompt(), "1 + 1{Enter}")

    expect(asked.submitted).toEqual(["1 + 1"])
    expect(prompt()).toHaveValue("")
  })

  test("takes a new line on Shift+Enter without running", async () => {
    const { user, asked } = await openedOver({ state: READY })

    await user.type(prompt(), "[[1,{Shift>}{Enter}{/Shift}2]{Enter}")

    expect(asked.submitted).toEqual(["[1,\n2]"])
  })

  test("takes a new line on Shift+Enter even when what is typed is complete", async () => {
    const { user, asked } = await openedOver({ state: READY, capabilities: ["check"] })

    await user.type(prompt(), "1 + 1{Shift>}{Enter}{/Shift}")

    expect(asked.submitted).toEqual([])
    expect(prompt()).toHaveValue("1 + 1\n")
  })

  test("runs nothing when nothing is typed", async () => {
    const { user, asked } = await openedOver({ state: READY })

    await user.type(prompt(), "  {Enter}")

    expect(asked.submitted).toEqual([])
  })

  test("holds its key hints in the row under it", async () => {
    await openedOver({ state: READY })

    expect(hintRow()).toHaveTextContent("Enter to run")
  })

  test("says why in its hint row when an input is refused, and keeps the input", async () => {
    const { user, asked } = await openedOver({ state: { kind: "busy", pid: PID, id: 1, since: Date.now() } })

    await user.type(prompt(), "2 + 2{Enter}")

    expect(asked.submitted).toEqual([])
    expect(hintRow()).toHaveTextContent("Already running. Wait for it to finish.")
    expect(prompt()).toHaveValue("2 + 2")
  })

  test("says why when the server refused an input, and puts that input back", async () => {
    const { user, rerender, fold } = await openedOver({ state: READY })
    await user.type(prompt(), "2 + 2{Enter}")

    const props: ReaderProps = {
      ...fold.props,
      repl: aReplSession({ state: READY }, { reason: "Already running. Wait for it to finish.", input: "2 + 2" }).repl,
    }
    rerender(<Reader {...props} />)

    expect(await within(hintRow()).findByText("Already running. Wait for it to finish.")).toBeInTheDocument()
    expect(prompt()).toHaveValue("2 + 2")
  })
})

describe("the REPL's prompt's highlighting", () => {
  test("highlights Ruby as it is typed", async () => {
    const { user } = await openedOver({ state: READY })

    await user.type(prompt(), "Post.find(42) # the answer")

    expect(within(replDrawer()).getByText("Post")).toHaveAttribute("data-token", "constant")
    expect(within(replDrawer()).getByText("find")).toHaveAttribute("data-token", "identifier")
    expect(within(replDrawer()).getByText("42")).toHaveAttribute("data-token", "number")
    expect(within(replDrawer()).getByText("# the answer")).toHaveAttribute("data-token", "comment")
  })

  test("follows an edit in the middle of the input, and leaves the input the textarea's", async () => {
    const { user } = await openedOver({ state: READY })
    await user.type(prompt(), "puts x")

    await user.type(prompt(), ":sym, ", { initialSelectionStart: 5, initialSelectionEnd: 5 })

    expect(prompt()).toHaveValue("puts :sym, x")
    expect(within(replDrawer()).getByText(":sym")).toHaveAttribute("data-token", "symbol")

    await user.type(prompt(), "{Backspace}", { initialSelectionStart: 5, initialSelectionEnd: 11 })

    expect(prompt()).toHaveValue("puts x")
    expect(within(replDrawer()).queryByText(":sym")).not.toBeInTheDocument()
  })
})

describe("the REPL's prompt on Enter with the multi-line check", () => {
  test("runs a complete input", async () => {
    const { user, asked } = await openedOver({ state: READY, capabilities: ["check"] })

    await user.type(prompt(), "1 + 1{Enter}")

    expect(asked.submitted).toEqual(["1 + 1"])
    expect(asked.checked).toEqual(["1 + 1"])
  })

  test("takes a new line on an incomplete input without running, and runs it once it is complete", async () => {
    const { user, asked } = await openedOver({ state: READY, capabilities: ["check"] })

    await user.type(prompt(), "[[1, 2].each do |x|{Enter}")

    expect(asked.submitted).toEqual([])
    expect(prompt()).toHaveValue("[1, 2].each do |x|\n")

    await user.type(prompt(), "  x{Enter}end{Enter}")

    expect(asked.submitted).toEqual(["[1, 2].each do |x|\n  x\nend"])
  })

  test("takes the new line at the caret, and leaves the caret after it", async () => {
    const { user } = await openedOver({ state: READY, capabilities: ["check"] })
    await user.type(prompt(), "posts.each do |post| post.save")

    await user.type(prompt(), "{Enter}", { initialSelectionStart: 20, initialSelectionEnd: 21 })
    await user.keyboard("  ")

    expect(prompt()).toHaveValue("posts.each do |post|\n  post.save")
  })

  test("takes a new line on an incomplete input while an evaluation runs, and refuses a complete one", async () => {
    const { user, asked } = await openedOver({ state: { kind: "busy", pid: PID, id: 1, since: Date.now() }, capabilities: ["check"] })

    await user.type(prompt(), "def greet{Enter}")

    expect(prompt()).toHaveValue("def greet\n")

    await user.type(prompt(), "end{Enter}")

    expect(asked.submitted).toEqual([])
    expect(hintRow()).toHaveTextContent("Already running. Wait for it to finish.")
    expect(prompt()).toHaveValue("def greet\nend")
  })

  test("always runs when the console process has no multi-line check", async () => {
    const { user, asked } = await openedOver({ state: READY, capabilities: [] })

    await user.type(prompt(), "[[1, 2].each do |x|{Enter}")

    expect(asked.submitted).toEqual(["[1, 2].each do |x|"])
  })
})

describe("the REPL's prompt on Ctrl-C", () => {
  const BUSY: ReplState = { kind: "busy", pid: PID, id: 1, since: Date.now() }

  test("interrupts a running evaluation, and keeps the input", async () => {
    const { user, asked } = await openedOver({ state: BUSY })

    await user.type(prompt(), "Post.count{Control>}c{/Control}")

    expect(asked.interrupts).toBe(1)
    expect(prompt()).toHaveValue("Post.count")
  })

  test("says it interrupts in its hint row while an evaluation runs", async () => {
    await openedOver({ state: BUSY })

    expect(hintRow()).toHaveTextContent("Ctrl-C to interrupt")
  })

  test("copies a selection, and interrupts nothing", async () => {
    const { user, asked } = await openedOver({ state: BUSY })
    await user.type(prompt(), "Post.count")
    await user.pointer([{ target: prompt(), offset: 0, keys: "[MouseLeft>]" }, { offset: 4 }, { keys: "[/MouseLeft]" }])

    await user.keyboard("{Control>}c{/Control}")

    expect(await navigator.clipboard.readText()).toBe("Post")
    expect(asked.interrupts).toBe(0)
    expect(prompt()).toHaveValue("Post.count")
  })

  test("clears the input when nothing is running", async () => {
    const { user, asked } = await openedOver({ state: READY })

    await user.type(prompt(), "Post.count{Control>}c{/Control}")

    expect(prompt()).toHaveValue("")
    expect(asked.interrupts).toBe(0)
    expect(asked.submitted).toEqual([])
  })
})

describe("the REPL's Transcript", () => {
  test("shows each evaluation's input, then what it printed, then its result", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ input: "answer = 42", output: "side effect\n", outcome: result("42") })],
    })

    expect(transcriptEntries()[0]).toHaveTextContent(/answer = 42\s*side effect\s*=> 42/)
  })

  test("highlights each evaluation's input", async () => {
    await openedOver({ state: READY, transcript: [evaluation({ input: 'Post.where(title: "hi") # mine' })] })

    const entry = within(transcriptEntries()[0]!)
    expect(entry.getByText("Post")).toHaveAttribute("data-token", "constant")
    expect(entry.getByText("title:")).toHaveAttribute("data-token", "symbol")
    expect(entry.getByText('"hi"')).toHaveAttribute("data-token", "string")
    expect(entry.getByText("# mine")).toHaveAttribute("data-token", "comment")
  })

  test("shows an evaluation that raised as its error's class and message", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ input: "Post.find(0)", outcome: { kind: "error", className: "ActiveRecord::RecordNotFound", message: "Couldn't find Post with 'id'=0" } })],
    })

    expect(transcriptEntries()[0]).toHaveTextContent("ActiveRecord::RecordNotFound: Couldn't find Post with 'id'=0")
  })

  test("shows an evaluation Ctrl-C stopped as raising Interrupt, with no message after it", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ input: "sleep 60", outcome: { kind: "error", className: "Interrupt", message: "" } })],
    })

    expect(within(transcriptEntries()[0]!).getByText("Interrupt")).toBeInTheDocument()
  })

  test("shows what the console process printed outside any evaluation as an entry of its own", async () => {
    await openedOver({
      state: READY,
      transcript: [
        { kind: "output", id: 1, output: "Loading development environment (Rails 8.1.3)\n", outputCut: false },
        evaluation({ id: 2, outcome: result("2") }),
      ],
    })

    const [printed, evaluated] = transcriptEntries()
    expect(printed).toHaveTextContent("Loading development environment (Rails 8.1.3)")
    expect(evaluated).toHaveTextContent("1 + 1")
  })

  test("shows a running evaluation's input and what it has printed so far", async () => {
    await openedOver({
      state: { kind: "busy", pid: PID, id: 1, since: Date.now() },
      transcript: [evaluation({ input: "sleep 5", output: "working\n" })],
    })

    expect(transcriptEntries()[0]).toHaveTextContent(/sleep 5\s*working/)
  })

  test("says when a result or what was printed was cut", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ output: "x", outputCut: true, outcome: { ...result("y"), cut: true } })],
    })

    expect(within(transcriptEntries()[0]!).getByText(/Output cut/)).toBeInTheDocument()
    expect(within(transcriptEntries()[0]!).getByText(/Result cut at 64 KB/)).toBeInTheDocument()
  })

  test("says when the console process ended before an evaluation answered", async () => {
    await openedOver({ state: EXITED, transcript: [evaluation({ outcome: { kind: "lost" } })] })

    expect(transcriptEntries()[0]).toHaveTextContent("The REPL exited before it answered.")
  })
})

describe("a REPL result", () => {
  const HASH = RUBY_HASH
  const PRETTY = HASH.inspect

  function resultTree() {
    return within(transcriptEntries()[0]!).getByRole("tree", { name: "Result" })
  }

  function viewToggle(name: "Pretty" | "Raw") {
    return within(transcriptEntries()[0]!).getByRole("button", { name })
  }

  test("shows a Hash as a tree, each key's and leaf's Ruby type on it", async () => {
    const { user } = await openedOver({ state: READY, transcript: [evaluation({ outcome: result(PRETTY, HASH) })] })

    await user.click(within(resultTree()).getByRole("treeitem", { name: /"b"/ }))

    const tree = within(resultTree())
    expect(tree.getByText("a:")).toHaveAttribute("data-source-type", "symbol")
    expect(tree.getByText('"b":')).toHaveAttribute("data-source-type", "string")
    expect(within(tree.getByRole("treeitem", { name: "a: 1" })).getByText("1")).toHaveAttribute("data-source-type", "integer")
    expect(tree.getByText("1.0")).toHaveAttribute("data-source-type", "float")
    expect(tree.getByText("nil")).toHaveAttribute("data-source-type", "nil")
    expect(tree.getByText(":c")).toHaveAttribute("data-source-type", "symbol")
    expect(viewToggle("Pretty")).toHaveAttribute("aria-pressed", "true")
  })

  test("shows the pretty_inspect text on Raw, and the tree again on Pretty", async () => {
    const { user } = await openedOver({ state: READY, transcript: [evaluation({ outcome: result(PRETTY, HASH) })] })

    await user.click(viewToggle("Raw"))

    expect(within(transcriptEntries()[0]!).queryByRole("tree")).not.toBeInTheDocument()
    expect(within(transcriptEntries()[0]!).getByText(PRETTY)).toBeInTheDocument()
    expect(viewToggle("Raw")).toHaveAttribute("aria-pressed", "true")

    await user.click(viewToggle("Pretty"))

    expect(resultTree()).toBeInTheDocument()
  })

  test("shows a scalar as its text alone, with no toggle", async () => {
    await openedOver({ state: READY, transcript: [evaluation({ outcome: result("42", { type: "integer", inspect: "42" }) })] })

    const entry = within(transcriptEntries()[0]!)
    expect(entry.getByText("42")).toBeInTheDocument()
    expect(entry.queryByRole("tree")).not.toBeInTheDocument()
    expect(entry.queryByRole("button", { name: "Raw" })).not.toBeInTheDocument()
  })

  test("says how many items the loop left out of a cut array", async () => {
    const tree: RubyNode = {
      type: "array",
      inspect: "[0, 1, …]",
      items: [
        { type: "integer", inspect: "0", step: "[0]" },
        { type: "integer", inspect: "1", step: "[1]" },
      ],
      more: 4_998,
    }
    await openedOver({ state: READY, transcript: [evaluation({ outcome: result("[0, 1, …]", tree) })] })

    expect(within(resultTree()).getByText("…4998 more items")).toBeInTheDocument()
  })

  test("shows a value whose inspect raised as a result, noting what inspect raised", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ outcome: result("#<Broken>", { type: "object", inspect: "#<Broken>" }, "RuntimeError: nope") })],
    })

    const entry = within(transcriptEntries()[0]!)
    expect(entry.getByText("#<Broken>")).toBeInTheDocument()
    expect(entry.getByText("inspect raised RuntimeError: nope")).toBeInTheDocument()
  })
})

describe("the REPL on a page that may not act", () => {
  test("says where it can run Ruby from instead of offering a prompt, and never starts a console process", async () => {
    const { repl, asked } = aReplSession()
    const { user } = openTheReader([], { repl, actsOnlyFrom: "localhost:5273" })

    await openRepl(user)

    expect(within(replDrawer()).getByText(/Running Ruby needs/)).toHaveTextContent("Running Ruby needs localhost:5273")
    expect(within(replDrawer()).queryByRole("textbox")).not.toBeInTheDocument()
    expect(asked.boots).toBe(0)
  })
})
