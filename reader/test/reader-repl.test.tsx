import { afterEach, describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import type { ReplState, TranscriptEntry } from "../src/shared/repl"
import { Reader } from "../src/ui/Reader"
import { aReplSession, openRepl, openTheReader, replDrawer, type ReaderProps } from "./reader.harness"

/**
 * The *REPL* in its drawer, through the rendered Reader over a stand-in session: the console
 * process's state in the header, the prompt, and the *Transcript*.
 */

afterEach(() => {
  localStorage.clear()
})

const PID = 48213
const READY: ReplState = { kind: "ready", pid: PID }

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

function transcriptEntries() {
  return within(within(replDrawer()).getByRole("list", { name: "Transcript" })).queryAllByRole("listitem")
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
      [{ kind: "exited", code: 1 }, "exited 1"],
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

describe("the REPL's Transcript", () => {
  test("shows each evaluation's input, then what it printed, then its result", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ input: "answer = 42", output: "side effect\n", outcome: { kind: "result", text: "42", cut: false } })],
    })

    expect(transcriptEntries()[0]).toHaveTextContent(/answer = 42\s*side effect\s*=> 42/)
  })

  test("shows an evaluation that raised as its error's class and message", async () => {
    await openedOver({
      state: READY,
      transcript: [evaluation({ input: "Post.find(0)", outcome: { kind: "error", className: "ActiveRecord::RecordNotFound", message: "Couldn't find Post with 'id'=0" } })],
    })

    expect(transcriptEntries()[0]).toHaveTextContent("ActiveRecord::RecordNotFound: Couldn't find Post with 'id'=0")
  })

  test("shows what the console process printed outside any evaluation as an entry of its own", async () => {
    await openedOver({
      state: READY,
      transcript: [
        { kind: "output", id: 1, output: "Loading development environment (Rails 8.1.3)\n", outputCut: false },
        evaluation({ id: 2, outcome: { kind: "result", text: "2", cut: false } }),
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
      transcript: [evaluation({ output: "x", outputCut: true, outcome: { kind: "result", text: "y", cut: true } })],
    })

    expect(within(transcriptEntries()[0]!).getByText(/Output cut/)).toBeInTheDocument()
    expect(within(transcriptEntries()[0]!).getByText(/Result cut at 64 KB/)).toBeInTheDocument()
  })

  test("says when the console process ended before an evaluation answered", async () => {
    await openedOver({ state: { kind: "exited", code: null }, transcript: [evaluation({ outcome: { kind: "lost" } })] })

    expect(transcriptEntries()[0]).toHaveTextContent("The REPL exited before it answered.")
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
