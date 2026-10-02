import { afterEach, describe, expect, test } from "bun:test"
import { waitFor, within } from "@testing-library/react"

import type { Completion, ReplState } from "../src/shared/repl"
import type { HistoryEntry } from "../src/ui/features/repl/lib/input-history"
import { aReplSession, openRepl, openTheReader, replDrawer, replOpen } from "./reader.harness"

/**
 * The *REPL*'s hint row, through the rendered Reader over a stand-in session: the keys that work
 * in the input's current state, and nothing else.
 */

const ROOT = "/work/blog"
const PID = 48213
const READY: ReplState = { kind: "ready", pid: PID }
const BUSY: ReplState = { kind: "busy", pid: PID, id: 1, since: Date.now() }
const COMPLETES = ["complete"]

afterEach(() => {
  localStorage.clear()
})

/** Puts `inputs` in storage as an earlier page load left them, the last one newest. */
function kept(...inputs: string[]) {
  const stored: HistoryEntry[] = inputs.map((input, at) => ({ input, at, pid: PID, raised: false }))
  localStorage.setItem(`rails-log-reader.repl-history:${ROOT}`, JSON.stringify(stored))
}

async function opened(state: ReplState = READY, capabilities: string[] = COMPLETES, completing?: Parameters<typeof aReplSession>[2]) {
  const session = aReplSession({ state, capabilities }, null, completing)
  const view = openTheReader([], { repl: session.repl, railsRoot: ROOT })
  if (!replOpen()) await openRepl(view.user)
  return { ...view, ...session }
}

function prompt() {
  return within(replDrawer()).getByRole("textbox", { name: "Ruby" })
}

function hintRow() {
  return within(replDrawer()).getByRole("status")
}

/** The hints in the row, in order, each as its key and what it does. */
function hints() {
  return within(hintRow())
    .queryAllByRole("listitem")
    .map((hint) => hint.textContent)
}

const AROUND: Completion = {
  kind: "candidates",
  from: 0,
  receiver: null,
  candidates: [
    { text: "upcase", kind: "method" },
    { text: "upload", kind: "method" },
  ],
}

describe("the REPL's hint row, idle", () => {
  test("shows the keys that work, each as a key and what it does", async () => {
    kept("Post.count")
    await opened()

    expect(hints()).toEqual(["↵ run (newline if unfinished)", "⇧↵ newline", "⇥ complete", "↑ history", "^C clear"])
  })

  test("leaves out ⇥ when the console process has no completor", async () => {
    kept("Post.count")
    await opened(READY, [])

    expect(hints()).toEqual(["↵ run (newline if unfinished)", "⇧↵ newline", "↑ history", "^C clear"])
  })

  test("leaves out ↑ while there is no Input history", async () => {
    await opened()

    expect(hints()).toEqual(["↵ run (newline if unfinished)", "⇧↵ newline", "⇥ complete", "^C clear"])
  })

  test("shows → only while there is grey text to take", async () => {
    kept("User.find(1)")
    const { user } = await opened()
    expect(hints()).not.toContain("→ take the grey text")

    await user.type(prompt(), "User.")

    expect(hints()).toEqual(["↵ run (newline if unfinished)", "⇧↵ newline", "⇥ complete", "→ take the grey text", "↑ history", "^C clear"])

    await user.type(prompt(), "x")

    expect(hints()).not.toContain("→ take the grey text")
  })
})

describe("the REPL's hint row, for ↑", () => {
  test("shows ↑ only while the caret is on the input's first line, where it opens the Input history", async () => {
    kept("Post.count")
    const { user } = await opened()

    await user.type(prompt(), "a{Shift>}{Enter}{/Shift}b")
    expect(hints()).not.toContain("↑ history")

    await user.pointer({ target: prompt(), offset: 0, keys: "[MouseLeft]" })
    expect(hints()).toContain("↑ history")
  })
})

describe("the REPL's hint row, with the completion popover open", () => {
  async function withPopover() {
    const view = await opened(READY, COMPLETES, () => AROUND)
    await view.user.type(prompt(), "up")
    await view.user.keyboard("{Tab}")
    await within(replDrawer()).findByRole("listbox", { name: /^Completions/ })
    return view
  }

  test("shows the keys that work in the popover, naming the chosen candidate", async () => {
    await withPopover()

    expect(hints()).toEqual(["⇥ take upcase", "↑↓ choose", "esc close"])
  })

  test("follows the choice as ↑↓ moves it", async () => {
    const { user } = await withPopover()

    await user.keyboard("{ArrowDown}")
    expect(hints()).toContain("⇥ take upload")

    await user.keyboard("{ArrowUp}")
    expect(hints()).toContain("⇥ take upcase")
  })

  test("goes back to the idle keys when it closes", async () => {
    const { user } = await withPopover()

    await user.keyboard("{Escape}")

    expect(hints()).toContain("↵ run (newline if unfinished)")
    expect(hints()).not.toContain("↑↓ choose")
  })
})

describe("the REPL's hint row, with the Input history open", () => {
  test("shows the keys that work in the list", async () => {
    kept("Post.count")
    const { user } = await opened()

    await user.type(prompt(), "{ArrowUp}")

    expect(hints()).toEqual(["↑↓ choose", "↵ put in input", "esc close"])

    await user.keyboard("{Escape}")

    expect(hints()).toContain("↵ run (newline if unfinished)")
  })
})

describe("the REPL's hint row, while an evaluation runs", () => {
  test("leads with interrupting, and has no ↵ run", async () => {
    await opened(BUSY)

    expect(hints()).toEqual(["^C interrupt", "⇧↵ newline"])
  })

  test("adds ↑ history when there is any", async () => {
    kept("Post.count")
    await opened(BUSY)

    expect(hints()).toEqual(["^C interrupt", "⇧↵ newline", "↑ history"])
  })
})

describe("the REPL's hint row, with a notice", () => {
  test("is replaced by the notice for a moment, and the keys come back after it", async () => {
    const { user } = await opened(BUSY)
    await user.type(prompt(), "2 + 2{Enter}")

    expect(hintRow()).toHaveTextContent("Already running. Wait for it to finish.")
    expect(hints()).toEqual([])

    await waitFor(() => expect(hints()).toEqual(["^C interrupt", "⇧↵ newline"]), { timeout: 4_000 })
  }, 8_000)
})
