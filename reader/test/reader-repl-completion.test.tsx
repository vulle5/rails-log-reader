import { afterEach, describe, expect, test } from "bun:test"
import { screen, waitFor, within } from "@testing-library/react"

import type { Candidate, Completion, ReplState } from "../src/shared/repl"
import { aReplSession, openRepl, openTheReader, replDrawer, replOpen } from "./reader.harness"

/**
 * The *REPL*'s completion, through the rendered Reader over a stand-in session: what Tab asks
 * for, the popover it opens at the caret, and what the trigger Setting changes about both.
 */

const PID = 48213
const READY: ReplState = { kind: "ready", pid: PID }
const BUSY: ReplState = { kind: "busy", pid: PID, id: 1, since: Date.now() }
const COMPLETES = ["complete"]

afterEach(() => {
  localStorage.clear()
})

/** The Reader with its drawer open over a session in `state` that completes, unless `capabilities` says it cannot. */
async function opened(state: ReplState = READY, capabilities: string[] = COMPLETES, completing?: Parameters<typeof aReplSession>[2]) {
  const session = aReplSession({ state, capabilities }, null, completing)
  const view = openTheReader([], { repl: session.repl })
  if (!replOpen()) await openRepl(view.user)
  return { ...view, ...session }
}

function prompt() {
  return within(replDrawer()).getByRole("textbox", { name: "Ruby" }) as HTMLTextAreaElement
}

function hintRow() {
  return within(replDrawer()).getByRole("status")
}

function popover() {
  return within(replDrawer()).queryByRole("listbox", { name: /^Completions/ })
}

async function theListbox() {
  return await within(replDrawer()).findByRole("listbox", { name: /^Completions/ })
}

/** The popover's candidates as text, in order. */
async function options() {
  return within(await theListbox())
    .getAllByRole("option")
    .map((option) => option.textContent)
}

async function chosen() {
  return within(await theListbox()).getByRole("option", { selected: true })
}

/** Something that answers when it is told to, so a test decides what order answers arrive in. */
function deferred() {
  let resolve!: (completion: Completion) => void
  const promise = new Promise<Completion>((done) => (resolve = done))
  return { promise, resolve }
}

const METHODS: Candidate[] = [
  { text: "upcase", kind: "method" },
  { text: "upcase!", kind: "method" },
]

describe("the REPL's prompt on Tab", () => {
  test("asks for completions of the text and the caret", async () => {
    const { user, asked } = await opened()

    await user.type(prompt(), '"abc".up')
    await user.keyboard("{Tab}")

    expect(asked.completed).toEqual([{ text: '"abc".up', caret: 8 }])
  })

  test("opens a popover of several candidates, naming the receiver, each with its kind", async () => {
    const { user } = await opened()

    await user.type(prompt(), '"abc".up')
    await user.keyboard("{Tab}")

    const list = await theListbox()
    expect(list).toHaveAccessibleName("Completions for String")
    expect(within(replDrawer()).getByText("String")).toBeInTheDocument()
    expect(await options()).toEqual(["upcase", "upcase!"])
    expect(within(list).getAllByRole("option").map((option) => option.getAttribute("data-kind"))).toEqual(["method", "method"])
    expect(within(list).getByRole("option", { name: "upcase" })).toHaveAccessibleDescription("method")
    expect(prompt()).toHaveValue('"abc".up')
  })

  test("marks each candidate with its own kind", async () => {
    const { user } = await opened(READY, COMPLETES, () => ({
      kind: "candidates",
      from: 2,
      receiver: null,
      candidates: [
        { text: "up", kind: "local" },
        { text: "Up", kind: "constant" },
        { text: "unless", kind: "keyword" },
        { text: "upto", kind: "method" },
      ],
    }))

    await user.type(prompt(), "x.")
    await user.keyboard("{Tab}")

    const list = await theListbox()
    expect(list).toHaveAccessibleName("Completions")
    expect(within(list).getAllByRole("option").map((option) => option.getAttribute("data-kind"))).toEqual(["local", "constant", "keyword", "method"])
    expect(within(list).getAllByRole("option").map((option) => option.title)).toEqual(["local variable", "constant", "keyword", "method"])
  })

  test("inserts a single candidate at once, with no popover", async () => {
    const { user } = await opened()

    await user.type(prompt(), "upl")
    await user.keyboard("{Tab}")

    expect(await screen.findByDisplayValue("upload")).toBe(prompt())
    expect(popover()).not.toBeInTheDocument()
  })

  test("completes the word before the caret and leaves what follows it", async () => {
    const { user } = await opened()
    await user.type(prompt(), '"abc".up + 1')
    prompt().setSelectionRange(8, 8)

    await user.keyboard("{Tab}")
    await user.keyboard("{ArrowDown}{Enter}")

    expect(prompt()).toHaveValue('"abc".upcase! + 1')
    expect(prompt().selectionStart).toBe(13)
  })

  test("says why in the hint row when nothing completes, and leaves the input", async () => {
    const { user } = await opened()

    await user.type(prompt(), "zzz")
    await user.keyboard("{Tab}")

    expect(await within(replDrawer()).findByText("Nothing completes “zzz”.")).toBe(hintRow())
    expect(prompt()).toHaveValue("zzz")
    expect(popover()).not.toBeInTheDocument()
  })

  test("does not ask while an evaluation runs, and says in the hint row that it waits", async () => {
    const { user, asked } = await opened(BUSY)

    await user.type(prompt(), '"abc".up')
    await user.keyboard("{Tab}")

    expect(asked.completed).toEqual([])
    expect(await within(replDrawer()).findByText("Completion waits for the running evaluation to finish.")).toBe(hintRow())
    expect(prompt()).toHaveValue('"abc".up')
    expect(popover()).not.toBeInTheDocument()
  })

  test("says completion isn't available when the console process has none, and is not asked", async () => {
    const { user, asked } = await opened(READY, [])

    await user.type(prompt(), "up")
    await user.keyboard("{Tab}")

    expect(await within(replDrawer()).findByText("Completion isn't available.")).toBe(hintRow())
    expect(asked.completed).toEqual([])
  })

  test("keeps Tab in the textarea rather than moving focus on", async () => {
    const { user } = await opened()

    await user.type(prompt(), "zzz")
    await user.keyboard("{Tab}")

    expect(prompt()).toHaveFocus()
  })

  test("drops an answer to an older request", async () => {
    const answers = [deferred(), deferred()]
    let asking = 0
    const { user, asked } = await opened(READY, COMPLETES, () => answers[asking++]!.promise)

    await user.type(prompt(), "up")
    await user.keyboard("{Tab}")
    await user.keyboard("{Tab}")
    expect(asked.completed).toHaveLength(2)

    answers[1]!.resolve({ kind: "candidates", from: 0, receiver: null, candidates: [{ text: "upto", kind: "method" }, { text: "upcase", kind: "method" }] })
    expect(await options()).toEqual(["upto", "upcase"])

    answers[0]!.resolve({ kind: "candidates", from: 0, receiver: null, candidates: [{ text: "stale", kind: "method" }, { text: "staler", kind: "method" }] })
    await Promise.resolve()

    expect(await options()).toEqual(["upto", "upcase"])
  })

  test("drops an answer to a request once the input has changed", async () => {
    const answer = deferred()
    const { user } = await opened(READY, COMPLETES, () => answer.promise)

    await user.type(prompt(), "up")
    await user.keyboard("{Tab}")
    await user.type(prompt(), "x")
    answer.resolve({ kind: "candidates", from: 0, receiver: null, candidates: METHODS })
    await answer.promise

    expect(popover()).not.toBeInTheDocument()
    expect(prompt()).toHaveValue("upx")
  })

  test("drops an answer to a request once the caret has moved", async () => {
    const answer = deferred()
    const { user } = await opened(READY, COMPLETES, () => answer.promise)

    await user.type(prompt(), "up")
    await user.keyboard("{Tab}")
    await user.keyboard("{ArrowLeft}")
    answer.resolve({ kind: "candidates", from: 0, receiver: null, candidates: METHODS })
    await answer.promise

    expect(popover()).not.toBeInTheDocument()
  })
})

describe("the completion popover", () => {
  async function withPopover(input = '"abc".up') {
    const view = await opened()
    await view.user.type(prompt(), input)
    await view.user.keyboard("{Tab}")
    await theListbox()
    return view
  }

  test("selects the first candidate, and names it as the textarea's active descendant", async () => {
    await withPopover()

    expect(await chosen()).toHaveTextContent("upcase")
    expect(prompt()).toHaveAttribute("aria-activedescendant", (await chosen()).id)
    expect(prompt()).toHaveAttribute("aria-controls", (await theListbox()).id)
  })

  test("moves its choice with ↓ and ↑, round the ends", async () => {
    const { user } = await withPopover()

    await user.keyboard("{ArrowDown}")
    expect(await chosen()).toHaveTextContent("upcase!")
    await user.keyboard("{ArrowDown}")
    expect(await chosen()).toHaveTextContent(/^upcase$/)
    await user.keyboard("{ArrowUp}")
    expect(await chosen()).toHaveTextContent("upcase!")
  })

  test("inserts the chosen candidate on Enter, and does not run the input", async () => {
    const { user, asked } = await withPopover()

    await user.keyboard("{ArrowDown}{Enter}")

    expect(prompt()).toHaveValue('"abc".upcase!')
    expect(asked.submitted).toEqual([])
    expect(popover()).not.toBeInTheDocument()
  })

  test("inserts the chosen candidate on Tab", async () => {
    const { user } = await withPopover()

    await user.keyboard("{Tab}")

    expect(prompt()).toHaveValue('"abc".upcase')
    expect(popover()).not.toBeInTheDocument()
  })

  test("inserts the candidate that is clicked, and keeps the prompt's focus", async () => {
    const { user } = await withPopover()

    await user.click(within(await theListbox()).getByRole("option", { name: "upcase!" }))

    expect(prompt()).toHaveValue('"abc".upcase!')
    expect(prompt()).toHaveFocus()
  })

  test("leaves the caret after what it inserted, so typing goes on from there", async () => {
    const { user } = await withPopover()

    await user.keyboard("{Tab}")
    await user.keyboard(".size")

    expect(prompt()).toHaveValue('"abc".upcase.size')
  })

  test("closes on Escape and leaves the input", async () => {
    const { user } = await withPopover()

    await user.keyboard("{Escape}")

    expect(popover()).not.toBeInTheDocument()
    expect(prompt()).toHaveValue('"abc".up')
  })

  test("narrows as the developer types, and widens again on Backspace", async () => {
    const { user } = await withPopover()

    await user.keyboard("case")
    expect(await options()).toEqual(["upcase", "upcase!"])

    await user.keyboard("!")
    expect(await options()).toEqual(["upcase!"])

    await user.keyboard("{Backspace}")
    expect(await options()).toEqual(["upcase", "upcase!"])
  })

  test("chooses the first candidate again when something is typed after another was chosen", async () => {
    const { user } = await withPopover()
    await user.keyboard("{ArrowDown}")
    expect(await chosen()).toHaveTextContent("upcase!")

    await user.keyboard("c")

    expect(await chosen()).toHaveTextContent("upcase")
  })

  test("closes when the word ends", async () => {
    const { user } = await withPopover()

    await user.keyboard("case!")
    await user.keyboard(".")

    expect(popover()).not.toBeInTheDocument()
    expect(prompt()).toHaveValue('"abc".upcase!.')
  })

  test("closes when what is typed matches no candidate", async () => {
    const { user } = await withPopover()

    await user.keyboard("x")

    expect(popover()).not.toBeInTheDocument()
  })

  test("closes when the caret moves off the word", async () => {
    const { user } = await withPopover()

    await user.keyboard("{ArrowLeft}")

    expect(popover()).not.toBeInTheDocument()
  })

  test("closes when the text before the word is edited", async () => {
    const { user } = await withPopover()
    prompt().setSelectionRange(1, 1)

    await user.keyboard("x")

    expect(popover()).not.toBeInTheDocument()
  })

  test("closes on Ctrl-C, which then leaves the input alone", async () => {
    const { user } = await withPopover()

    await user.keyboard("{Control>}c{/Control}")

    expect(popover()).not.toBeInTheDocument()
    expect(prompt()).toHaveValue("")
  })

  test("closes when the prompt loses focus", async () => {
    const { user } = await withPopover()

    await user.tab({ shift: true })

    expect(popover()).not.toBeInTheDocument()
  })

  test("takes ↑ for its own choice, and never opens the Input history", async () => {
    localStorage.setItem(
      "rails-log-reader.repl-history:/work/blog",
      JSON.stringify([{ input: "Post.count", at: Date.now(), pid: PID, raised: false }]),
    )
    const session = aReplSession({ state: READY, capabilities: COMPLETES })
    const { user } = openTheReader([], { repl: session.repl, railsRoot: "/work/blog" })
    await openRepl(user)
    await user.type(prompt(), '"abc".up')
    await user.keyboard("{Tab}")

    await user.keyboard("{ArrowUp}")

    expect(within(replDrawer()).queryByRole("listbox", { name: "Input history" })).not.toBeInTheDocument()
    expect(await chosen()).toHaveTextContent("upcase!")
  })

  test("says what its keys do in the hint row while it is open", async () => {
    const { user } = await withPopover()

    expect(hintRow()).toHaveTextContent("Tab to insert")

    await user.keyboard("{Escape}")

    expect(hintRow()).toHaveTextContent("Enter to run")
  })
})

describe("the completion trigger set to as you type", () => {
  afterEach(() => {
    localStorage.clear()
  })

  async function typing(state: ReplState = READY, capabilities: string[] = COMPLETES) {
    localStorage.setItem("rails-log-reader.completion-trigger", "typing")
    return await opened(state, capabilities)
  }

  test("opens the popover as a word is typed, with the first candidate chosen", async () => {
    const { user } = await typing()

    await user.type(prompt(), '"abc".up')

    expect(await options()).toEqual(["upcase", "upcase!"])
    expect(await chosen()).toHaveTextContent("upcase")
  })

  test("chooses the first candidate again when something is typed after another was chosen", async () => {
    const { user } = await typing()
    await user.type(prompt(), '"abc".up')
    await theListbox()
    await user.keyboard("{ArrowDown}")
    expect(await chosen()).toHaveTextContent("upcase!")

    await user.type(prompt(), "c")

    expect(await options()).toEqual(["upcase", "upcase!"])
    expect(await chosen()).toHaveTextContent("upcase")
  })

  test("opens it for a single candidate too, and inserts nothing", async () => {
    const { user } = await typing()

    await user.type(prompt(), "upl")

    expect(await options()).toEqual(["upload"])
    expect(prompt()).toHaveValue("upl")
  })

  test("says nothing when nothing completes", async () => {
    const view = await typing()
    const { user } = view
    const { asked } = view
    await user.type(prompt(), "zzz")
    await waitFor(() => expect(asked.completed).toHaveLength(3))

    expect(popover()).not.toBeInTheDocument()
    expect(hintRow()).toHaveTextContent("Enter to run")
  })

  test("asks nothing of a console process that is running an evaluation, and says nothing", async () => {
    const { user, asked } = await typing(BUSY)

    await user.type(prompt(), "up")

    expect(asked.completed).toEqual([])
    expect(hintRow()).not.toHaveTextContent("Completion")
  })

  test("inserts the first candidate on Enter, and runs nothing", async () => {
    const { user, asked } = await typing()
    await user.type(prompt(), '"abc".up')
    await theListbox()

    await user.keyboard("{Enter}")

    expect(prompt()).toHaveValue('"abc".upcase')
    expect(asked.submitted).toEqual([])
  })

  test("runs the input on Enter once Esc has closed the popover", async () => {
    const { user, asked } = await typing()
    await user.type(prompt(), '"abc".up')
    await theListbox()

    await user.keyboard("{Escape}{Enter}")

    expect(asked.submitted).toEqual(['"abc".up'])
  })

  test("inserts the chosen candidate on Enter once ↓ chose another", async () => {
    const { user, asked } = await typing()
    await user.type(prompt(), '"abc".up')
    await theListbox()

    await user.keyboard("{ArrowDown}{Enter}")

    expect(prompt()).toHaveValue('"abc".upcase!')
    expect(asked.submitted).toEqual([])
  })

  test("inserts the first candidate on Tab", async () => {
    const { user } = await typing()
    await user.type(prompt(), '"abc".up')
    await theListbox()

    await user.keyboard("{Tab}")

    expect(prompt()).toHaveValue('"abc".upcase')
  })

  test("asks again for each thing typed, and shows the newest answer", async () => {
    const { user, asked } = await typing()

    await user.type(prompt(), "u")
    await user.keyboard("p")
    await options()

    expect(asked.completed.map((each) => each.text)).toEqual(["u", "up"])
  })

  test("asks nothing when the input is emptied by Backspace, and closes", async () => {
    const { user } = await typing()
    await user.type(prompt(), "upl")
    await theListbox()

    await user.keyboard("{Backspace}{Backspace}{Backspace}")

    expect(popover()).not.toBeInTheDocument()
  })

  test("stays on Tab when the Setting says so: nothing opens until it is pressed", async () => {
    localStorage.setItem("rails-log-reader.completion-trigger", "tab")
    const { user, asked } = await opened()

    await user.type(prompt(), '"abc".up')

    expect(asked.completed).toEqual([])
    expect(popover()).not.toBeInTheDocument()
  })

  test("reads a stored trigger it does not know as on Tab", async () => {
    localStorage.setItem("rails-log-reader.completion-trigger", "always")
    const { user, asked } = await opened()

    await user.type(prompt(), "up")

    expect(asked.completed).toEqual([])
  })
})
