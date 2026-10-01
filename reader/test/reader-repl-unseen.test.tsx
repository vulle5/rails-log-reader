import { afterEach, describe, expect, test } from "bun:test"
import { within } from "@testing-library/react"

import type { Outcome, ReplSnapshot, ReplState, TranscriptEntry } from "../src/shared/repl"
import { Reader } from "../src/ui/Reader"
import { aReplSession, openRepl, openTheReader, replDrawer, replOpen, foldRepl } from "./reader.harness"

/**
 * The *Unseen result*, through the rendered Reader over a stand-in session: the mark on a
 * folded REPL drawer's header, which a tab's own snapshot updates turn on and unfolding turns off.
 */

afterEach(() => {
  localStorage.clear()
})

const READY: ReplState = { kind: "ready", pid: 48213 }
const RESULT: Outcome = { kind: "result", className: "Integer", text: "2", cut: false, tree: { type: "integer", inspect: "2" }, inspectError: null }
const RAISED: Outcome = { kind: "error", className: "RuntimeError", message: "boom", backtrace: ["(repl):1:in `<main>'"], causes: [] }
const LOST: Outcome = { kind: "lost" }

function evaluation(id: number, outcome: Outcome | null, input = "1 + 1"): TranscriptEntry {
  return { kind: "evaluation", id, input, output: "", outputCut: false, outcome }
}

/** The Reader over a session holding `snapshot`, its drawer folded as on a first visit. */
function openFolded(snapshot: Partial<ReplSnapshot> = {}) {
  const view = openTheReader([], { repl: aReplSession({ state: READY, ...snapshot }).repl })

  /** The session holding `next` in place of what it held, as its updates fold in. */
  function update(next: Partial<ReplSnapshot>, loaded = true) {
    view.rerender(<Reader {...view.fold.props} repl={{ ...aReplSession({ state: READY, ...next }).repl, loaded }} />)
  }

  return { ...view, update }
}

function mark() {
  return within(replDrawer()).getByText("new")
}

function markAbsent() {
  return within(replDrawer()).queryByText("new")
}

describe("the Unseen result", () => {
  test("is not shown while nothing has finished since the drawer folded", () => {
    openFolded()

    expect(markAbsent()).not.toBeInTheDocument()
  })

  test("is shown on the folded header when an evaluation finishes", () => {
    const { update } = openFolded({ transcript: [evaluation(1, null)] })

    update({ transcript: [evaluation(1, RESULT)] })

    expect(mark()).toBeVisible()
    expect(mark()).toHaveAttribute("data-outcome", "result")
  })

  test("is not shown for an evaluation still running", () => {
    const { update } = openFolded()

    update({ state: { kind: "busy", pid: 48213, id: 1, since: 0 }, transcript: [evaluation(1, null)] })

    expect(markAbsent()).not.toBeInTheDocument()
  })

  test("is in the error colour when the latest unseen evaluation raised", () => {
    const { update } = openFolded()

    update({ transcript: [evaluation(1, RESULT), evaluation(2, RAISED)] })

    expect(mark()).toHaveAttribute("data-outcome", "error")
  })

  test("is in the error colour when the latest unseen evaluation ended without a result", () => {
    const { update } = openFolded()

    update({ transcript: [evaluation(1, LOST)] })

    expect(mark()).toHaveAttribute("data-outcome", "error")
  })

  test("goes back to the plain colour when a later evaluation returned", () => {
    const { update } = openFolded()

    update({ transcript: [evaluation(1, RAISED), evaluation(2, RESULT)] })

    expect(mark()).toHaveAttribute("data-outcome", "result")
  })

  test("is shown for the first evaluation after a Restart, whose id an earlier one already had", () => {
    const { update } = openFolded({ transcript: [evaluation(1, RESULT)] })

    update({ transcript: [evaluation(1, { ...RESULT }, "2 + 2")] })

    expect(mark()).toBeVisible()
  })

  test("is not shown for the Transcript a reload onto a folded drawer replays", () => {
    const { update } = openFolded()

    update({ transcript: [evaluation(1, RESULT), evaluation(2, RAISED)] }, false)
    update({ transcript: [evaluation(1, RESULT), evaluation(2, RAISED)] })

    expect(markAbsent()).not.toBeInTheDocument()
  })

  test("is shown for what finishes after that replay", () => {
    const { update } = openFolded()
    update({ transcript: [evaluation(1, RESULT)] }, false)
    update({ transcript: [evaluation(1, RESULT), evaluation(2, null)] })

    update({ transcript: [evaluation(1, RESULT), evaluation(2, RAISED)] })

    expect(mark()).toHaveAttribute("data-outcome", "error")
  })
})

describe("the Unseen result across a reconnect", () => {
  test("stays while the session's snapshot is replaced by one holding the same evaluations", () => {
    const { update } = openFolded()
    update({ transcript: [evaluation(1, RESULT)] })

    update({ transcript: [evaluation(1, { ...RESULT })] })

    expect(mark()).toBeVisible()
  })

  test("is shown for an evaluation that finished while the socket was down", () => {
    const { update } = openFolded({ transcript: [evaluation(1, null)] })

    update({ transcript: [evaluation(1, RAISED)] })

    expect(mark()).toHaveAttribute("data-outcome", "error")
  })
})

describe("the Unseen result and the drawer's fold", () => {
  test("leaves the drawer folded when an evaluation finishes", () => {
    const { update } = openFolded()

    update({ transcript: [evaluation(1, RESULT)] })

    expect(replOpen()).toBe(false)
  })

  test("is cleared by unfolding", async () => {
    const { user, update } = openFolded()
    update({ transcript: [evaluation(1, RESULT)] })

    await openRepl(user)
    await foldRepl(user)

    expect(markAbsent()).not.toBeInTheDocument()
  })

  test("is not shown while the drawer is open", async () => {
    const { user, update } = openFolded()
    await openRepl(user)

    update({ transcript: [evaluation(1, RESULT)] })

    expect(markAbsent()).not.toBeInTheDocument()
  })

  test("counts only what finished since the drawer last folded", async () => {
    const { user, update } = openFolded()
    update({ transcript: [evaluation(1, RESULT)] })
    await openRepl(user)
    await foldRepl(user)

    update({ transcript: [evaluation(1, RESULT), evaluation(2, RAISED)] })

    expect(mark()).toHaveAttribute("data-outcome", "error")
  })
})
