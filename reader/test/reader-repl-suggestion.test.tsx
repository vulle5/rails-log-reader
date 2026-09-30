import { afterEach, describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"

import type { HistoryEntry } from "../src/ui/features/repl/lib/input-history"
import { aReplSession, openRepl, openTheReader, replDrawer, replOpen } from "./reader.harness"

/**
 * The *REPL*'s *History suggestion*, through the rendered Reader over a stand-in session and
 * seeded *Input history*: the grey text after the caret, what takes it, and who owns it while
 * the completion popover is open.
 */

const ROOT = "/work/blog"
const PID = 48213
const SETTING_KEY = "rails-log-reader.history-suggestion"

afterEach(() => {
  localStorage.clear()
})

/** Puts `inputs` in storage as an earlier page load left them, the last one newest. */
function kept(...inputs: string[]) {
  const stored: HistoryEntry[] = inputs.map((input, at) => ({ input, at, pid: PID, raised: false }))
  localStorage.setItem(`rails-log-reader.repl-history:${ROOT}`, JSON.stringify(stored))
}

async function opened() {
  const session = aReplSession({ state: { kind: "ready", pid: PID }, capabilities: ["complete"] })
  const view = openTheReader([], { repl: session.repl, railsRoot: ROOT })
  if (!replOpen()) await openRepl(view.user)
  return { ...view, ...session }
}

function prompt() {
  return within(replDrawer()).getByRole("textbox", { name: "Ruby" })
}

/** The grey text, found by the words it adds. */
function suggestion(rest: string) {
  return within(replDrawer()).getByText(rest)
}

/** Nothing of the grey text, by the words it would add. */
function noSuggestion(rest: string) {
  return within(replDrawer()).queryByText(rest)
}

describe("the History suggestion", () => {
  test("offers the rest of the newest entry that starts with what is typed", async () => {
    kept("User.count", "User.find(1)", "Post.all")
    const { user } = await opened()

    await user.type(prompt(), "User.")

    expect(suggestion("find(1)")).toHaveAttribute("data-suggestion", "history")
    expect(noSuggestion("count")).not.toBeInTheDocument()
    expect(prompt()).toHaveValue("User.")
  })

  test("offers nothing before anything is typed, or once the whole entry is", async () => {
    kept("User.count")
    const { user } = await opened()

    expect(within(replDrawer()).queryByText("User.count")).not.toBeInTheDocument()

    await user.type(prompt(), "User.count")

    expect(prompt()).toHaveValue("User.count")
  })

  test("follows what is typed, and goes once what is typed stops matching", async () => {
    kept("User.count", "User.find(1)")
    const { user } = await opened()

    await user.type(prompt(), "User.")
    expect(suggestion("find(1)")).toBeInTheDocument()

    await user.type(prompt(), "c")
    expect(suggestion("ount")).toBeInTheDocument()
    expect(noSuggestion("find(1)")).not.toBeInTheDocument()

    await user.type(prompt(), "x")
    expect(noSuggestion("ount")).not.toBeInTheDocument()

    await user.keyboard("{Backspace}")
    expect(suggestion("ount")).toBeInTheDocument()
  })

  test("is taken by →, the caret after it", async () => {
    kept("User.find(1)")
    const { user } = await opened()

    await user.type(prompt(), "User.")
    await user.keyboard("{ArrowRight}")

    expect(prompt()).toHaveValue("User.find(1)")
    expect((prompt() as HTMLTextAreaElement).selectionStart).toBe("User.find(1)".length)
    expect(noSuggestion("find(1)")).not.toBeInTheDocument()
  })

  test("is taken by End", async () => {
    kept("User.find(1)")
    const { user } = await opened()

    await user.type(prompt(), "User.")
    await user.keyboard("{End}")

    expect(prompt()).toHaveValue("User.find(1)")
  })

  test("is never taken, nor drawn, with the caret off the end of the text", async () => {
    kept("User.find(1)")
    const { user } = await opened()

    await user.type(prompt(), "User.")
    await user.keyboard("{ArrowLeft}")

    expect(noSuggestion("find(1)")).not.toBeInTheDocument()

    await user.keyboard("{ArrowRight}")

    expect(prompt()).toHaveValue("User.")
    expect(suggestion("find(1)")).toBeInTheDocument()
  })

  test("is not drawn while the Input history is open over the Transcript", async () => {
    kept("User.find(1)")
    const { user } = await opened()

    await user.type(prompt(), "User.")
    await user.keyboard("{ArrowUp}")

    expect(within(replDrawer()).getByRole("listbox", { name: "Input history" })).toBeInTheDocument()
    expect(noSuggestion("find(1)")).not.toBeInTheDocument()
  })

  test("goes when the input loses focus, and is back when it has it again", async () => {
    kept("User.find(1)")
    const { user } = await opened()

    await user.type(prompt(), "User.")
    await user.tab()

    expect(noSuggestion("find(1)")).not.toBeInTheDocument()

    await user.click(prompt())

    expect(suggestion("find(1)")).toBeInTheDocument()
  })

  test("is not offered for another Host app's history", async () => {
    localStorage.setItem("rails-log-reader.repl-history:/work/other", JSON.stringify([{ input: "User.find(1)", at: 1, pid: PID, raised: false }]))
    const { user } = await opened()

    await user.type(prompt(), "User.")

    expect(noSuggestion("find(1)")).not.toBeInTheDocument()
  })
})

describe("the History suggestion beside the completion popover", () => {
  test("previews the selected completion, and never the history, while the popover is open", async () => {
    kept('"abc".upcase.reverse')
    const { user } = await opened()

    await user.type(prompt(), '"abc".up')
    expect(suggestion("case.reverse")).toHaveAttribute("data-suggestion", "history")

    await user.keyboard("{Tab}")
    await within(replDrawer()).findByRole("listbox", { name: /^Completions/ })

    expect(suggestion("case")).toHaveAttribute("data-suggestion", "completion")
    expect(noSuggestion("case.reverse")).not.toBeInTheDocument()

    await user.keyboard("{ArrowDown}")

    expect(suggestion("case!")).toHaveAttribute("data-suggestion", "completion")
    expect(noSuggestion("case")).not.toBeInTheDocument()
  })

  test("takes the previewed completion on →, and the history is back once the popover has closed", async () => {
    kept('"abc".upcase.reverse')
    const { user } = await opened()

    await user.type(prompt(), '"abc".up')
    await user.keyboard("{Tab}")
    await within(replDrawer()).findByRole("listbox", { name: /^Completions/ })
    await user.keyboard("{ArrowDown}{ArrowRight}")

    expect(prompt()).toHaveValue('"abc".upcase!')
    expect(within(replDrawer()).queryByRole("listbox", { name: /^Completions/ })).not.toBeInTheDocument()
    expect(noSuggestion("case!")).not.toBeInTheDocument()
  })

  test("returns to the history when the popover is closed with Esc", async () => {
    kept('"abc".upcase.reverse')
    const { user } = await opened()

    await user.type(prompt(), '"abc".up')
    await user.keyboard("{Tab}")
    await within(replDrawer()).findByRole("listbox", { name: /^Completions/ })
    await user.keyboard("{Escape}")

    expect(suggestion("case.reverse")).toHaveAttribute("data-suggestion", "history")
  })

  test("previews the first candidate as soon as the popover opens as a word is typed", async () => {
    localStorage.setItem("rails-log-reader.completion-trigger", "typing")
    kept('"abc".upcase.reverse')
    const { user } = await opened()

    await user.type(prompt(), '"abc".up')
    await within(replDrawer()).findByRole("listbox", { name: /^Completions/ })

    expect(suggestion("case")).toHaveAttribute("data-suggestion", "completion")
    expect(noSuggestion("case.reverse")).not.toBeInTheDocument()
  })
})

describe("the History suggestion Setting", () => {
  test("off shows no suggestion", async () => {
    localStorage.setItem(SETTING_KEY, "off")
    kept("User.find(1)")
    const { user } = await opened()

    await user.type(prompt(), "User.")
    await user.keyboard("{ArrowRight}")

    expect(noSuggestion("find(1)")).not.toBeInTheDocument()
    expect(prompt()).toHaveValue("User.")
  })

  test("off still previews the chosen completion while the popover is open", async () => {
    localStorage.setItem(SETTING_KEY, "off")
    kept('"abc".upcase.reverse')
    const { user } = await opened()

    await user.type(prompt(), '"abc".up')
    expect(noSuggestion("case.reverse")).not.toBeInTheDocument()

    await user.keyboard("{Tab}")
    await within(replDrawer()).findByRole("listbox", { name: /^Completions/ })

    expect(suggestion("case")).toHaveAttribute("data-suggestion", "completion")
  })

  test("turned off in Settings, takes effect at once", async () => {
    kept("User.find(1)")
    const { user } = await opened()
    await user.type(prompt(), "User.")
    expect(suggestion("find(1)")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Settings" }))
    const group = within(screen.getByRole("dialog", { name: "Settings" })).getByRole("group", { name: "History suggestion" })
    await user.click(within(group).getByRole("button", { name: "Off" }))

    expect(noSuggestion("find(1)")).not.toBeInTheDocument()
  })
})
