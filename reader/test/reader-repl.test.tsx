import { afterEach, describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import type { Outcome, ReplSnapshot, ReplState, RubyError, RubyNode, TranscriptEntry } from "../src/shared/repl"
import { Reader } from "../src/ui/Reader"
import { aReplSession, openRepl, openTheReader, replDrawer, type ReaderProps } from "./reader.harness"
import { RUBY_HASH, RUBY_RECORD } from "./repl.fixtures"

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

/** An evaluation's error, raised at `(repl):1` unless it says otherwise, with no causes unless it has them. */
function raised(
  className: string,
  message: string,
  backtrace: string[] = ["(repl):1:in `<main>'"],
  causes: RubyError[] = [],
): Extract<Outcome, { kind: "error" }> {
  return { kind: "error", className, message, backtrace, causes }
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
      transcript: [evaluation({ input: "Post.find(0)", outcome: raised("ActiveRecord::RecordNotFound", "Couldn't find Post with 'id'=0") })],
    })

    expect(transcriptEntries()[0]).toHaveTextContent("ActiveRecord::RecordNotFound: Couldn't find Post with 'id'=0")
  })

  test("shows an evaluation Ctrl-C stopped as raising Interrupt, with no message after it", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ input: "sleep 60", outcome: raised("Interrupt", "", []) })],
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

describe("an evaluation that raised", () => {
  const GEM = "activerecord (8.0.2) lib/active_record/relation/finder_methods.rb:400:in `find_one'"
  const OTHER_GEM = "activesupport (8.0.2) lib/active_support/execution_wrapper.rb:91:in `wrap'"

  function backtrace(entry = transcriptEntries()[0]!, at = 0) {
    return within(within(entry).getAllByRole("list", { name: "Backtrace" })[at]!)
  }

  test("shows its class, its message and its backtrace", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ input: 'raise "boom"', outcome: raised("RuntimeError", "boom", ["(repl):1:in `<main>'"]) })],
    })

    const entry = within(transcriptEntries()[0]!)
    expect(entry.getByText("RuntimeError: boom")).toBeInTheDocument()
    expect(entry.getAllByRole("listitem").map((frame) => frame.textContent)).toEqual(["(repl):1:in `<main>'"])
  })

  test("draws no backtrace for an error that came before any of the developer's code ran", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ input: "1 +", outcome: raised("SyntaxError", "(repl):1: syntax error", []) })],
    })

    expect(within(transcriptEntries()[0]!).queryByRole("list", { name: "Backtrace" })).not.toBeInTheDocument()
  })

  test("shows its (repl) frames as the developer's own, and never collapses them", async () => {
    await openedOver({
      state: READY,
      transcript: [
        evaluation({
          outcome: raised("ActiveRecord::RecordNotFound", "gone", [GEM, OTHER_GEM, "(repl):1:in `find_post'", OTHER_GEM, "(repl):2:in `<main>'"]),
        }),
      ],
    })

    const frames = backtrace().getAllByRole("listitem")
    expect(frames.map((frame) => frame.textContent)).toEqual([GEM, "1 frame hidden", "(repl):1:in `find_post'", "1 frame hidden", "(repl):2:in `<main>'"])
    expect(frames[2]).toHaveAttribute("data-frame", "host")
    expect(frames[4]).toHaveAttribute("data-frame", "host")
    expect(frames[0]).not.toHaveAttribute("data-frame")
  })

  test("collapses gem frames into markers that open, as the Detail column's do", async () => {
    const { user } = await openedOver({
      state: READY,
      transcript: [evaluation({ outcome: raised("RuntimeError", "boom", [GEM, OTHER_GEM, "(repl):1:in `<main>'"]) })],
    })

    await user.click(backtrace().getByRole("button", { name: "1 frame hidden" }))

    expect(backtrace().getAllByRole("listitem").map((frame) => frame.textContent)).toEqual([GEM, OTHER_GEM, "(repl):1:in `<main>'"])
  })

  test("shows a frame under the app's own directory as the developer's own", async () => {
    const { repl } = aReplSession({
      state: READY,
      transcript: [evaluation({ outcome: raised("RuntimeError", "boom", [GEM, "/srv/shop/app/models/post.rb:3:in `title'", "(repl):1:in `<main>'"]) })],
    })
    const { user } = openTheReader([], { repl, railsRoot: "/srv/shop" })
    await openRepl(user)

    const frames = backtrace().getAllByRole("listitem")
    expect(frames[1]).toHaveAttribute("data-frame", "host")
    expect(frames[0]).not.toHaveAttribute("data-frame")
  })

  test("folds each cause as Caused by, its backtrace shown once it is opened", async () => {
    const { user } = await openedOver({
      state: READY,
      transcript: [
        evaluation({
          outcome: raised("RuntimeError", "top", ["(repl):5:in `<main>'"], [
            { className: "ArgumentError", message: "middle", backtrace: ["(repl):3:in `<main>'"] },
            { className: "KeyError", message: "root", backtrace: [GEM, "(repl):1:in `<main>'"] },
          ]),
        }),
      ],
    })
    const entry = within(transcriptEntries()[0]!)

    const middle = entry.getByRole("button", { name: "Caused by ArgumentError: middle" })
    const root = entry.getByRole("button", { name: "Caused by KeyError: root" })
    expect(middle).toHaveAttribute("aria-expanded", "false")
    expect(entry.getAllByRole("list", { name: "Backtrace" })).toHaveLength(1)

    await user.click(middle)

    expect(middle).toHaveAttribute("aria-expanded", "true")
    expect(root).toHaveAttribute("aria-expanded", "false")
    expect(backtrace(transcriptEntries()[0]!, 1).getAllByRole("listitem").map((frame) => frame.textContent)).toEqual(["(repl):3:in `<main>'"])

    await user.click(root)

    expect(backtrace(transcriptEntries()[0]!, 2).getAllByRole("listitem").map((frame) => frame.textContent)).toEqual([GEM, "(repl):1:in `<main>'"])
  })

  test("folds a cause again when it is closed", async () => {
    const { user } = await openedOver({
      state: READY,
      transcript: [
        evaluation({ outcome: raised("RuntimeError", "top", [], [{ className: "KeyError", message: "root", backtrace: ["(repl):1:in `<main>'"] }]) }),
      ],
    })
    const entry = within(transcriptEntries()[0]!)
    const cause = entry.getByRole("button", { name: "Caused by KeyError: root" })

    await user.click(cause)
    await user.click(cause)

    expect(cause).toHaveAttribute("aria-expanded", "false")
    expect(entry.queryByRole("list", { name: "Backtrace" })).not.toBeInTheDocument()
  })

  test("shows a cause with no backtrace as a line of its own, with nothing to open", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ outcome: raised("RuntimeError", "top", [], [{ className: "KeyError", message: "never raised", backtrace: [] }]) })],
    })
    const entry = within(transcriptEntries()[0]!)

    expect(entry.getByText("Caused by KeyError: never raised")).toBeInTheDocument()
    expect(entry.queryByRole("button", { name: /Caused by/ })).not.toBeInTheDocument()
  })

  test("says an error's backtrace was cut, under it", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ outcome: { ...raised("SystemStackError", "stack level too deep", [GEM, "(repl):1:in `deep'"]), cut: true } })],
    })

    expect(within(transcriptEntries()[0]!).getByText("Backtrace cut at 64 KB")).toBeInTheDocument()
  })

  test("says nothing was cut when nothing was", async () => {
    await openedOver({ state: READY, transcript: [evaluation({ outcome: raised("RuntimeError", "boom") })] })

    expect(within(transcriptEntries()[0]!).queryByText(/cut/)).not.toBeInTheDocument()
  })

  test("says a cause's backtrace was cut once the cause is opened", async () => {
    const { user } = await openedOver({
      state: READY,
      transcript: [
        evaluation({
          outcome: raised("RuntimeError", "top", [], [{ className: "KeyError", message: "root", backtrace: ["(repl):1:in `deep'"], cut: true }]),
        }),
      ],
    })
    const entry = within(transcriptEntries()[0]!)
    expect(entry.queryByText("Backtrace cut at 64 KB")).not.toBeInTheDocument()

    await user.click(entry.getByRole("button", { name: "Caused by KeyError: root" }))

    expect(entry.getByText("Backtrace cut at 64 KB")).toBeInTheDocument()
  })

  test("says causes past the nearest ten were left out, after the ones it shows", async () => {
    await openedOver({
      state: READY,
      transcript: [
        evaluation({
          outcome: {
            ...raised("RuntimeError", "top", [], [{ className: "KeyError", message: "root", backtrace: ["(repl):1:in `<main>'"] }]),
            causesCut: true,
          },
        }),
      ],
    })

    expect(within(transcriptEntries()[0]!).getByText("Further causes left out")).toBeInTheDocument()
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

  test("reads a Relation's records each as its class and attribute count, and says it has more", async () => {
    const relation: RubyNode = { type: "relation", class: "ActiveRecord::Relation", inspect: "#<ActiveRecord::Relation [...]>", items: [RUBY_RECORD], more: null }
    await openedOver({ state: READY, transcript: [evaluation({ outcome: result(relation.inspect, relation) })] })

    expect(within(resultTree()).getByRole("treeitem", { name: "0: Author {…} 3 attributes" })).toBeInTheDocument()
    expect(within(resultTree()).getByText("…more")).toBeInTheDocument()
  })

  test("shows a record's filtered attribute as a FILTERED marker", async () => {
    await openedOver({ state: READY, transcript: [evaluation({ outcome: result(RUBY_RECORD.inspect, RUBY_RECORD) })] })

    const email = within(resultTree()).getByRole("treeitem", { name: "email: FILTERED" })
    expect(within(email).getByText("FILTERED")).toHaveAttribute("data-filtered")
  })

  test("reads a plain object as its class and ivar count", async () => {
    const money: RubyNode = {
      type: "object",
      class: "Money",
      inspect: '#<Money:0x0 @cents=100, @currency="EUR">',
      step: "[0]",
      fields: [
        ["@cents", { type: "integer", inspect: "100" }],
        ["@currency", { type: "string", inspect: '"EUR"' }],
      ],
    }
    const tree: RubyNode = { type: "array", inspect: `[${money.inspect}]`, items: [money] }
    await openedOver({ state: READY, transcript: [evaluation({ outcome: result(tree.inspect, tree) })] })

    expect(within(resultTree()).getByRole("treeitem", { name: "0: #<Money> {…} 2 ivars" })).toBeInTheDocument()
  })

  test("marks a cycle", async () => {
    const tree: RubyNode = {
      type: "hash",
      inspect: "{a: 1, self: {...}}",
      pairs: [
        [{ type: "symbol", inspect: ":a" }, { type: "integer", inspect: "1", step: "[:a]" }],
        [{ type: "symbol", inspect: ":self" }, { type: "cycle", inspect: "{...}", step: "[:self]" }],
      ],
    }
    await openedOver({ state: READY, transcript: [evaluation({ outcome: result(tree.inspect, tree) })] })

    const cycle = within(resultTree()).getByRole("treeitem", { name: "self: {...}" })
    expect(within(cycle).getByText("{...}")).toHaveAttribute("data-cycle")
  })

  test("offers no path to copy for a Set's member, only its value", async () => {
    const tree: RubyNode = { type: "set", class: "Set", inspect: "#<Set: {1}>", items: [{ type: "integer", inspect: "1" }] }
    await openedOver({ state: READY, transcript: [evaluation({ outcome: result(tree.inspect, tree) })] })

    const member = within(resultTree()).getByRole("treeitem", { name: "0: 1" })
    expect(within(member).getByRole("button", { name: "Copy value" })).toBeInTheDocument()
    expect(within(member).queryByRole("button", { name: "Copy path" })).not.toBeInTheDocument()
  })

  test("copies the whole result as its inspect text", async () => {
    const { user } = await openedOver({ state: READY, transcript: [evaluation({ outcome: result(PRETTY, HASH) })] })

    await user.click(within(transcriptEntries()[0]!).getByRole("button", { name: "Copy result" }))

    expect(await navigator.clipboard.readText()).toBe(HASH.inspect)
  })

  test("copies a nested node's inspect text, and the [...] path that reaches it", async () => {
    const { user } = await openedOver({ state: READY, transcript: [evaluation({ outcome: result(PRETTY, HASH) })] })
    await user.click(within(resultTree()).getByRole("treeitem", { name: /"b"/ }))
    const array = within(resultTree()).getByRole("treeitem", { name: /"b"/ })
    const symbol = within(array).getByRole("treeitem", { name: "2: :c" })

    await user.click(within(symbol).getByRole("button", { name: "Copy value" }))
    expect(await navigator.clipboard.readText()).toBe(":c")

    await user.click(within(symbol).getByRole("button", { name: "Copy path" }))
    expect(await navigator.clipboard.readText()).toBe('["b"][2]')

    // The array's own controls are the first under its item, ahead of its children's.
    await user.click(within(array).getAllByRole("button", { name: "Copy value" })[0]!)
    expect(await navigator.clipboard.readText()).toBe("[1.0, nil, :c]")
  })

  test("names each copy control after the node it copies", async () => {
    await openedOver({ state: READY, transcript: [evaluation({ outcome: result(PRETTY, HASH) })] })

    const leaf = within(resultTree()).getByRole("treeitem", { name: "a: 1" })

    expect(within(leaf).getByRole("button", { name: "Copy value" })).toHaveAccessibleDescription("a: 1")
    expect(within(leaf).getByRole("button", { name: "Copy path" })).toHaveAccessibleDescription("a: 1")
  })

  test("offers no path to copy under an ivar, only the value", async () => {
    const money: RubyNode = {
      type: "object",
      class: "Money",
      inspect: "#<Money:0x0 @parts=[1]>",
      step: "[0]",
      fields: [["@parts", { type: "array", inspect: "[1]", items: [{ type: "integer", inspect: "1" }] }]],
    }
    const tree: RubyNode = { type: "array", inspect: `[${money.inspect}]`, items: [money] }
    const { user } = await openedOver({ state: READY, transcript: [evaluation({ outcome: result(tree.inspect, tree) })] })
    await user.click(within(resultTree()).getByRole("treeitem", { name: /Money/ }))
    await user.click(within(resultTree()).getByRole("treeitem", { name: /@parts/ }))

    const part = within(resultTree()).getByRole("treeitem", { name: "0: 1" })
    expect(within(part).getByRole("button", { name: "Copy value" })).toBeInTheDocument()
    expect(within(part).queryByRole("button", { name: "Copy path" })).not.toBeInTheDocument()
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
