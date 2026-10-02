import { afterEach, describe, expect, test } from "bun:test"
import { fireEvent, within } from "@testing-library/react"

import type { ReplState, TranscriptEntry } from "../src/shared/repl"
import { HISTORY_LIMIT, type HistoryEntry } from "../src/ui/features/repl/lib/input-history"
import { Reader } from "../src/ui/Reader"
import { aReplSession, openRepl, openTheReader, replDrawer, replOpen } from "./reader.harness"

/**
 * The *REPL*'s *Input history*, through the rendered Reader over a stand-in session and a real
 * `localStorage`: what ↑ opens over the prompt, and what is kept between page loads.
 */

const ROOT = "/work/blog"
const PID = 48213
const READY: ReplState = { kind: "ready", pid: PID }
const MINUTE = 60_000

afterEach(() => {
  localStorage.clear()
})

function keyOf(root: string) {
  return `rails-log-reader.repl-history:${root}`
}

/** Puts `entries` in storage as an earlier page load left them, each having run `minutes` ago. */
function kept(entries: { input: string; minutes?: number; pid?: number; raised?: boolean }[], root = ROOT) {
  const stored: HistoryEntry[] = entries.map(({ input, minutes = 5, pid = PID, raised = false }) => ({
    input,
    at: Date.now() - minutes * MINUTE,
    pid,
    raised,
  }))
  localStorage.setItem(keyOf(root), JSON.stringify(stored))
}

function stored(root = ROOT) {
  return JSON.parse(localStorage.getItem(keyOf(root)) ?? "[]") as HistoryEntry[]
}

/** The Reader with its drawer open over a session in `state`, on the Host app at `railsRoot`. */
async function opened(state: ReplState = READY, railsRoot: string | null = ROOT) {
  const session = aReplSession({ state })
  const view = openTheReader([], { repl: session.repl, railsRoot })
  // Open already when an earlier page load left it so.
  if (!replOpen()) await openRepl(view.user)
  return { ...view, ...session }
}

function prompt() {
  return within(replDrawer()).getByRole("textbox", { name: "Ruby" })
}

function historyList() {
  return within(replDrawer()).queryByRole("listbox", { name: "Input history" })
}

function historyRows() {
  return within(within(replDrawer()).getByRole("listbox", { name: "Input history" })).getAllByRole("option")
}

/** Each row's own text, oldest first. */
function rowTexts() {
  return historyRows().map((row) => row.textContent)
}

function selectedRow() {
  return within(within(replDrawer()).getByRole("listbox", { name: "Input history" })).getByRole("option", { selected: true })
}

/**
 * `localStorage` counting the reads and writes made through it until `stop`. A stand-in in its
 * place, because happy-dom's storage keeps the methods it first handed out and a spy on
 * `Storage.prototype` is not called.
 */
function countingStorage() {
  const real = window.localStorage
  const counted = { reads: 0, writes: 0 }
  const counting = new Proxy(real, {
    get(target, property) {
      if (property === "getItem") return (key: string) => (counted.reads++, target.getItem(key))
      if (property === "setItem") return (key: string, value: string) => (counted.writes++, target.setItem(key, value))
      const value: unknown = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  Object.defineProperty(globalThis, "localStorage", { value: counting, configurable: true })
  return {
    get reads() {
      return counted.reads
    },
    get writes() {
      return counted.writes
    },
    stop: () => Object.defineProperty(globalThis, "localStorage", { value: real, configurable: true }),
  }
}

function evaluation(entry: Partial<Extract<TranscriptEntry, { kind: "evaluation" }>>): TranscriptEntry {
  return { kind: "evaluation", id: 1, input: "1 + 1", output: "", outputCut: false, outcome: null, ...entry }
}

describe("the REPL's Input history on ↑", () => {
  test("opens on ↑ from the first line, its newest entry nearest the prompt and selected", async () => {
    kept([{ input: "first", minutes: 30 }, { input: "second", minutes: 20 }, { input: "third", minutes: 10 }])
    const { user } = await opened()

    expect(historyList()).not.toBeInTheDocument()
    await user.click(prompt())
    await user.keyboard("{ArrowUp}")

    expect(rowTexts()).toEqual([expect.stringContaining("first"), expect.stringContaining("second"), expect.stringContaining("third")])
    expect(selectedRow()).toHaveTextContent("third")
    expect(prompt()).toHaveAttribute("aria-activedescendant", selectedRow().id)
  })

  test("moves the caret instead on a later line", async () => {
    kept([{ input: "earlier" }])
    const { user } = await opened()

    await user.type(prompt(), "a{Shift>}{Enter}{/Shift}b")
    await user.keyboard("{ArrowUp}")

    expect(historyList()).not.toBeInTheDocument()
    expect(prompt()).toHaveValue("a\nb")

    ;(prompt() as HTMLTextAreaElement).setSelectionRange(1, 1)
    await user.keyboard("{ArrowUp}")

    expect(historyList()).toBeInTheDocument()
  })

  test("does not open with nothing kept", async () => {
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")

    expect(historyList()).not.toBeInTheDocument()
  })

  test("shows each row's first line, how many more lines it has, whether it raised, and when it ran", async () => {
    kept([
      { input: "Post.count", minutes: 3 * 60 },
      { input: "def greet\n  puts 1\nend", minutes: 12 },
      { input: "1 / 0", minutes: 0, raised: true },
    ])
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")
    const [count, greet, divide] = historyRows()

    expect(count).toHaveTextContent("Post.count")
    expect(within(count!).getByText("3h ago")).toBeInTheDocument()
    expect(within(count!).queryByText("raised")).not.toBeInTheDocument()
    expect(within(count!).queryByText(/^\+\d+ lines?$/)).not.toBeInTheDocument()

    expect(greet).toHaveTextContent("def greet")
    expect(within(greet!).getByText("+2 lines")).toBeInTheDocument()
    expect(greet).not.toHaveTextContent("puts 1")
    expect(within(greet!).getByText("12m ago")).toBeInTheDocument()

    expect(within(divide!).getByText("raised")).toBeInTheDocument()
    expect(within(divide!).getByText("just now")).toBeInTheDocument()
  })

  test("marks where an earlier console's entries begin, and never above the running console's own", async () => {
    kept([
      { input: "old one", pid: 100, minutes: 90 },
      { input: "old two", pid: 100, minutes: 80 },
      { input: "older one", pid: 200, minutes: 50 },
      { input: "now", pid: PID, minutes: 5 },
    ])
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")
    const list = within(within(replDrawer()).getByRole("listbox", { name: "Input history" }))

    expect(list.getAllByText(/^earlier console · pid/).map((divider) => divider.textContent)).toEqual([
      "earlier console · pid 100",
      "earlier console · pid 200",
    ])
    const [firstDivider, secondDivider] = list.getAllByText(/^earlier console · pid/)
    // Each sits above the entries it introduces.
    expect(firstDivider!.compareDocumentPosition(historyRows()[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(secondDivider!.compareDocumentPosition(historyRows()[1]!)).toBe(Node.DOCUMENT_POSITION_PRECEDING)
    expect(secondDivider!.compareDocumentPosition(historyRows()[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test("marks where the running console's own entries begin below an earlier console's, and nowhere else", async () => {
    kept([
      { input: "old", pid: 100, minutes: 90 },
      { input: "now one", pid: PID, minutes: 5 },
      { input: "now two", pid: PID, minutes: 4 },
    ])
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")
    const list = within(within(replDrawer()).getByRole("listbox", { name: "Input history" }))

    expect(list.getAllByText(/^this console · pid/).map((divider) => divider.textContent)).toEqual([`this console · pid ${PID}`])
    const [divider] = list.getAllByText(/^this console · pid/)
    expect(divider!.compareDocumentPosition(historyRows()[0]!)).toBe(Node.DOCUMENT_POSITION_PRECEDING)
    expect(divider!.compareDocumentPosition(historyRows()[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test("marks no start of the running console's entries when it has all of them", async () => {
    kept([{ input: "now one" }, { input: "now two" }])
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")

    expect(within(replDrawer()).queryByText(/^this console · pid/)).not.toBeInTheDocument()
  })

  test("filters by substring as it is typed, leaving the input alone", async () => {
    kept([{ input: "Post.count" }, { input: "User.first" }, { input: "post = Post.last" }])
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")
    await user.keyboard("post")

    expect(rowTexts()).toEqual([expect.stringContaining("Post.count"), expect.stringContaining("post = Post.last")])
    expect(prompt()).toHaveValue("")

    await user.keyboard("{Backspace}{Backspace}{Backspace}{Backspace}us")

    expect(rowTexts()).toEqual([expect.stringContaining("User.first")])
  })

  test("says nothing matches when the filter leaves nothing", async () => {
    kept([{ input: "Post.count" }])
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}zzz")

    expect(within(replDrawer()).getByText("Nothing matches.")).toBeInTheDocument()
    expect(prompt()).not.toHaveAttribute("aria-activedescendant")
  })

  test("closes on ↓ when the filter has left nothing to choose", async () => {
    kept([{ input: "Post.count" }])
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}zzz{ArrowUp}{ArrowDown}")

    expect(historyList()).not.toBeInTheDocument()
  })

  test("puts the selected entry in the input on Enter, without running it", async () => {
    kept([{ input: "Post.count" }, { input: "User.first" }])
    const { user, asked } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}{Enter}")

    expect(prompt()).toHaveValue("User.first")
    expect(asked.submitted).toEqual([])
    expect(historyList()).not.toBeInTheDocument()
  })

  test("puts an older entry in the input on Tab once ↑ has chosen it", async () => {
    kept([{ input: "Post.count" }, { input: "User.first" }])
    const { user, asked } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}{ArrowUp}")
    expect(selectedRow()).toHaveTextContent("Post.count")
    await user.keyboard("{Tab}")

    expect(prompt()).toHaveValue("Post.count")
    expect(asked.submitted).toEqual([])
    expect(historyList()).not.toBeInTheDocument()
  })

  test("puts the filtered entry in the input, replacing whatever was there", async () => {
    kept([{ input: "Post.count" }, { input: "User.first" }])
    const { user } = await opened()

    await user.type(prompt(), "draft")
    await user.keyboard("{Home}{ArrowUp}")
    await user.keyboard("cou{Enter}")

    expect(prompt()).toHaveValue("Post.count")
  })

  test("puts the entry in the input when it is clicked", async () => {
    kept([{ input: "Post.count" }, { input: "User.first" }])
    const { user, asked } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")
    await user.click(historyRows()[0]!)

    expect(prompt()).toHaveValue("Post.count")
    expect(asked.submitted).toEqual([])
    expect(historyList()).not.toBeInTheDocument()
  })

  test("closes on Esc, keeping the input as it was", async () => {
    kept([{ input: "Post.count" }])
    const { user } = await opened()

    await user.type(prompt(), "x")
    await user.keyboard("{Home}{ArrowUp}{Escape}")

    expect(historyList()).not.toBeInTheDocument()
    expect(prompt()).toHaveValue("x")
  })

  test("closes on ↓ past the newest entry, and moves toward it on ↓ before that", async () => {
    kept([{ input: "Post.count" }, { input: "User.first" }])
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}{ArrowUp}")
    expect(selectedRow()).toHaveTextContent("Post.count")

    await user.keyboard("{ArrowDown}")
    expect(selectedRow()).toHaveTextContent("User.first")

    await user.keyboard("{ArrowDown}")
    expect(historyList()).not.toBeInTheDocument()
  })

  test("stops at the oldest entry on ↑", async () => {
    kept([{ input: "Post.count" }, { input: "User.first" }])
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}")

    expect(selectedRow()).toHaveTextContent("Post.count")
  })

  test("still runs what is typed once it has closed", async () => {
    kept([{ input: "Post.count" }])
    const { user, asked } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}{Escape}1 + 1{Enter}")

    expect(asked.submitted).toEqual(["1 + 1"])
  })
})

describe("what the REPL keeps of its Input history", () => {
  test("survives a reload", async () => {
    const first = await opened()
    await first.user.type(prompt(), "Post.count{Enter}")
    first.unmount()

    const { user } = await opened()
    await user.click(prompt())
    await user.keyboard("{ArrowUp}")

    expect(rowTexts()).toEqual([expect.stringContaining("Post.count")])
  })

  test("writes an entry on submit with its input, when it ran, the console's pid and that it did not raise", async () => {
    const { user } = await opened()
    const before = Date.now()

    await user.type(prompt(), "Post.count{Enter}")

    expect(stored()).toEqual([{ input: "Post.count", at: expect.any(Number), pid: PID, raised: false }])
    expect(stored()[0]!.at).toBeGreaterThanOrEqual(before)
  })

  test("writes nothing for an input the session refused", async () => {
    const { user } = await opened({ kind: "busy", pid: PID, id: 1, since: Date.now() })

    await user.type(prompt(), "Post.count{Enter}")

    expect(stored()).toEqual([])
  })

  test("is kept apart for each Rails root", async () => {
    kept([{ input: "blog only" }], "/work/blog")
    kept([{ input: "shop only" }], "/work/shop")

    const { user } = await opened(READY, "/work/shop")
    await user.click(prompt())
    await user.keyboard("{ArrowUp}")

    expect(rowTexts()).toEqual([expect.stringContaining("shop only")])
    await user.keyboard("{Escape}")
    await user.type(prompt(), "new{Enter}")

    expect(stored("/work/blog").map((entry) => entry.input)).toEqual(["blog only"])
    expect(stored("/work/shop").map((entry) => entry.input)).toEqual(["shop only", "new"])
  })

  test("keeps a repeat once, at its latest", async () => {
    kept([{ input: "Post.count", minutes: 30 }, { input: "User.first", minutes: 20 }])
    const { user } = await opened()

    await user.type(prompt(), "Post.count{Enter}")

    expect(stored().map((entry) => entry.input)).toEqual(["User.first", "Post.count"])

    await user.keyboard("{ArrowUp}")
    expect(rowTexts()).toEqual([expect.stringContaining("User.first"), expect.stringContaining("Post.count")])
  })

  test("keeps the latest 200 distinct inputs and drops the oldest", async () => {
    expect(HISTORY_LIMIT).toBe(200)
    kept(Array.from({ length: HISTORY_LIMIT }, (_, index) => ({ input: `input ${index}` })))
    const { user } = await opened()

    await user.type(prompt(), "the newest{Enter}")

    const inputs = stored().map((entry) => entry.input)
    expect(inputs).toHaveLength(HISTORY_LIMIT)
    expect(inputs[0]).toBe("input 1")
    expect(inputs.at(-1)).toBe("the newest")
  })

  test("adds a raised mark to its entry when the evaluation raises", async () => {
    const { user, rerender, fold } = await opened()
    await user.type(prompt(), "1 / 0{Enter}")
    expect(stored()[0]).toMatchObject({ input: "1 / 0", raised: false })

    const finished = aReplSession({
      state: READY,
      transcript: [
        evaluation({
          id: 7,
          input: "1 / 0",
          outcome: { kind: "error", className: "ZeroDivisionError", message: "divided by 0", backtrace: [], causes: [] },
        }),
      ],
    })
    rerender(<Reader {...fold.props} railsRoot={ROOT} repl={finished.repl} />)

    expect(stored()).toEqual([expect.objectContaining({ input: "1 / 0", raised: true })])
    await user.click(prompt())
    await user.keyboard("{ArrowUp}")
    expect(within(historyRows()[0]!).getByText("raised")).toBeInTheDocument()
  })

  test("leaves the mark off an evaluation that finished with a result", async () => {
    const { user, rerender, fold } = await opened()
    await user.type(prompt(), "1 + 1{Enter}")

    const finished = aReplSession({
      state: READY,
      transcript: [
        evaluation({ id: 7, input: "1 + 1", outcome: { kind: "result", className: "Integer", text: "2", cut: false, tree: { type: "integer", inspect: "2" }, inspectError: null } }),
      ],
    })
    rerender(<Reader {...fold.props} railsRoot={ROOT} repl={finished.repl} />)

    expect(stored()).toEqual([expect.objectContaining({ input: "1 + 1", raised: false })])
  })

  test("writes only on submit and on finish, and never on a keystroke", async () => {
    kept([{ input: "Post.count" }])
    const { user } = await opened()
    const storage = countingStorage()

    try {
      await user.type(prompt(), "abc")
      await user.keyboard("{Home}{ArrowUp}pos{Backspace}{ArrowUp}{ArrowDown}{Escape}")

      expect(storage.writes).toBe(0)

      await user.keyboard("{Enter}")
      expect(storage.writes).toBe(1)
    } finally {
      storage.stop()
    }
  })

  test("reads storage once, and not again while typing", async () => {
    kept([{ input: "Post.count" }])
    const { user } = await opened()
    const storage = countingStorage()

    try {
      await user.type(prompt(), "abc")
      await user.keyboard("{Home}{ArrowUp}pos{Backspace}{Escape}")

      expect(storage.reads).toBe(0)
    } finally {
      storage.stop()
    }
  })

  test("shows another tab's submit through the storage event", async () => {
    kept([{ input: "Post.count" }])
    const { user } = await opened()

    const entries: HistoryEntry[] = [...stored(), { input: "from another tab", at: Date.now(), pid: PID, raised: false }]
    localStorage.setItem(keyOf(ROOT), JSON.stringify(entries))
    // user-event cannot dispatch a `storage` event, which is what a write in another tab raises here.
    fireEvent(window, new StorageEvent("storage", { key: keyOf(ROOT), newValue: JSON.stringify(entries) }))

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")

    expect(rowTexts()).toEqual([expect.stringContaining("Post.count"), expect.stringContaining("from another tab")])
  })

  test("ignores a storage event for another Rails root, or for another key", async () => {
    kept([{ input: "Post.count" }])
    const { user } = await opened()

    const other = JSON.stringify([{ input: "elsewhere", at: Date.now(), pid: PID, raised: false }])
    // user-event cannot dispatch a `storage` event, which is what a write in another tab raises here.
    fireEvent(window, new StorageEvent("storage", { key: keyOf("/work/shop"), newValue: other }))
    fireEvent(window, new StorageEvent("storage", { key: "rails-log-reader.theme", newValue: "dark" }))

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")

    expect(rowTexts()).toEqual([expect.stringContaining("Post.count")])
  })

  test("reads a stored history that is over the cap or repeats an input as the cap and the repeat rule keep it", async () => {
    const entry = (input: string, at: number): HistoryEntry => ({ input, at, pid: PID, raised: false })
    const overfull = Array.from({ length: HISTORY_LIMIT + 50 }, (_, index) => entry(`input ${index}`, index))
    localStorage.setItem(keyOf(ROOT), JSON.stringify([entry("input 0", 1_000), ...overfull]))
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")

    expect(historyRows()).toHaveLength(HISTORY_LIMIT)
    expect(historyRows()[0]).toHaveTextContent("input 50")
    expect(historyRows().at(-1)).toHaveTextContent("input 249")
  })

  test("reads a stored history it cannot make sense of as empty", async () => {
    localStorage.setItem(keyOf(ROOT), "{not json")
    const { user } = await opened()

    await user.click(prompt())
    await user.keyboard("{ArrowUp}")
    expect(historyList()).not.toBeInTheDocument()

    await user.type(prompt(), "1 + 1{Enter}")
    expect(stored().map((entry) => entry.input)).toEqual(["1 + 1"])
  })

  test("keeps it for the session alone, and writes nothing, before the Host app's Rails root is known", async () => {
    const { user } = await opened(READY, null)

    await user.type(prompt(), "1 + 1{Enter}")
    await user.keyboard("{ArrowUp}")

    expect(rowTexts()).toEqual([expect.stringContaining("1 + 1")])
    expect(Object.keys(localStorage).filter((key) => key.includes("repl-history"))).toEqual([])
  })

  test("still remembers for the session when site data is blocked and storage throws", async () => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError")
    }
    Storage.prototype.getItem = blocked
    Storage.prototype.setItem = blocked

    try {
      const { user } = await opened()

      await user.type(prompt(), "1 + 1{Enter}")
      await user.keyboard("{ArrowUp}")

      expect(rowTexts()).toEqual([expect.stringContaining("1 + 1")])
    } finally {
      Storage.prototype.getItem = getItem
      Storage.prototype.setItem = setItem
    }
  })
})
