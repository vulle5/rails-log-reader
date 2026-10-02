import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TRANSCRIPT_LIMIT, type EvaluationEntry, type Outcome, type ReplState, type TranscriptEntry } from "../src/shared/repl"
import { Transcript } from "../src/ui/features/repl/components/Transcript"
import { useTranscriptScroll, type Reveal } from "../src/ui/features/repl/hooks/transcript-scroll"
import type { HistoryEntry } from "../src/ui/features/repl/lib/input-history"
import { Reader } from "../src/ui/Reader"
import { aReplSession, foldRepl, openRepl, openTheReader, replDrawer, replOpen } from "./reader.harness"

/**
 * The *Transcript*'s *Auto-scroll*: following as entries arrive and grow, and as the prompt
 * under it changes its height; paused by scrolling up, and counting what came to something on
 * the "↓ N new" pill while it is; following again on a submit from this tab and on a Restart,
 * through the rendered Reader over a stand-in session.
 *
 * happy-dom does no layout, so the layout is supplied: every character the Transcript draws is
 * a pixel of its height, its port is `PORT` pixels tall, and `scrollTop` clamps to the range a
 * browser would clamp it to. A `ResizeObserver` is stood in whose callbacks the test runs, the
 * way a browser would after laying the port out again.
 */

const PORT = 40

const geometry = {
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
}

const scrolledTo = new WeakMap<Element, number>()
const observed: Array<() => void> = []
const realObserver = globalThis.ResizeObserver
const scrollIntoView = Element.prototype.scrollIntoView

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return this.textContent?.length ?? 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => PORT })
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return Math.min(scrolledTo.get(this) ?? 0, bottomOf(this))
    },
    set(this: Element, top: number) {
      scrolledTo.set(this, Math.min(Math.max(top, 0), bottomOf(this)))
    },
  })
})

afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollHeight", geometry.scrollHeight!)
  Object.defineProperty(HTMLElement.prototype, "clientHeight", geometry.clientHeight!)
  Object.defineProperty(Element.prototype, "scrollTop", geometry.scrollTop!)
})

beforeEach(() => {
  observed.length = 0
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      observed.push(callback)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  // Scrolls the Transcript to the entry's top, as a browser would; the scroll event that
  // follows is the test's to fire, since a browser announces it after the fact.
  Element.prototype.scrollIntoView = function scrollToEntry(this: Element) {
    const port = this.parentElement!
    let above = 0
    for (let entry = port.firstElementChild; entry !== this && entry !== null; entry = entry.nextElementSibling) {
      above += entry.textContent?.length ?? 0
    }
    port.scrollTop = above
  }
})

afterEach(() => {
  globalThis.ResizeObserver = realObserver
  Element.prototype.scrollIntoView = scrollIntoView
  localStorage.clear()
})

/** How far down a port goes: what "the bottom" means, and what a browser clamps to. */
function bottomOf(port: Element) {
  return Math.max(port.scrollHeight - (port as HTMLElement).clientHeight, 0)
}

const RESULT: Outcome = { kind: "result", className: "Integer", text: "3", cut: false, tree: { type: "integer", inspect: "3" }, inspectError: null }
const RAISED: Outcome = { kind: "error", className: "NameError", message: "undefined local variable", backtrace: [], causes: [] }
const LOST: Outcome = { kind: "lost" }

function evaluation(id: number, outcome: Outcome | null = RESULT, output = ""): EvaluationEntry {
  return { kind: "evaluation", id, input: `Post.find(${id})`, output, outputCut: false, outcome }
}

function printed(id: number, output: string): TranscriptEntry {
  return { kind: "output", id, output, outputCut: false }
}

/** Entries enough to overflow the port several times over. */
const HISTORY: TranscriptEntry[] = [evaluation(1), evaluation(2), evaluation(3), evaluation(4)]

/**
 * The Transcript over `entries`, and a way to hand it the next snapshot's. A `reveal` is asked
 * for once, and is gone by the next snapshot, as the Reader clears it once it is told.
 */
function aTranscript(entries: readonly TranscriptEntry[] = HISTORY, reveal: Reveal | null = null) {
  const user = userEvent.setup()
  const { rerender } = render(<FollowedTranscript entries={entries} reveal={reveal} />)

  function arrive(next: readonly TranscriptEntry[]) {
    rerender(<FollowedTranscript entries={next} reveal={null} />)
  }

  return { user, arrive }
}

/** The Transcript over its own Auto-scroll, as the REPL drawer draws it. */
function FollowedTranscript({ entries, reveal }: { entries: readonly TranscriptEntry[]; reveal: Reveal | null }) {
  const scroll = useTranscriptScroll({ entries, refollowsWhen: "", reveal })
  return <Transcript entries={entries} scroll={scroll} railsRoot={null} />
}

const ROOT = "/work/blog"
const READY: ReplState = { kind: "ready", pid: 48213 }

/**
 * The Reader with its REPL drawer open over a stand-in session holding `entries`, with the
 * eval loop's `capabilities`, and a way to hand it the session's next snapshot along with how
 * many Restarts the session has told this tab of.
 */
async function aDrawer(entries: readonly TranscriptEntry[] = HISTORY, capabilities: string[] = []) {
  const view = openTheReader([], { repl: aReplSession({ state: READY, capabilities, transcript: entries }).repl, railsRoot: ROOT })
  if (!replOpen()) await openRepl(view.user)

  function arrive(next: readonly TranscriptEntry[], restarts = 0) {
    const { repl } = aReplSession({ state: READY, capabilities, transcript: next })
    view.rerender(<Reader {...view.fold.props} railsRoot={ROOT} repl={{ ...repl, restarts }} />)
  }

  return { user: view.user, arrive }
}

/**
 * The Reader reloaded onto a folded REPL drawer, before the session's snapshot has arrived, and
 * a way to hand it the snapshot holding `entries` once it does.
 */
function aReloadOntoAFoldedDrawer() {
  const view = openTheReader([], { repl: { ...aReplSession({ state: READY }).repl, loaded: false }, railsRoot: ROOT })

  function load(entries: readonly TranscriptEntry[]) {
    const { repl } = aReplSession({ state: READY, transcript: entries })
    view.rerender(<Reader {...view.fold.props} railsRoot={ROOT} repl={repl} />)
  }

  return { user: view.user, load }
}

function unseenMark() {
  return within(replDrawer()).getByText("new")
}

function unseenMarkAbsent() {
  return within(replDrawer()).queryByText("new")
}

function prompt() {
  return within(replDrawer()).getByRole("textbox", { name: "Ruby" })
}

function port() {
  return screen.getByRole("list", { name: "Transcript" })
}

function pinnedToBottom() {
  return port().scrollTop === bottomOf(port())
}

/** The one gesture that pauses. user-event has no scroll gesture. */
function scrollUp(up = 20) {
  port().scrollTop = bottomOf(port()) - up
  fireEvent.scroll(port())
}

/** user-event has no scroll gesture. */
function scrollBackToTheBottom() {
  port().scrollTop = bottomOf(port())
  fireEvent.scroll(port())
}

/** The prompt grew or shrank: the port is `height` tall now, and its observer is told. */
function resized(height: number) {
  Object.defineProperty(port(), "clientHeight", { configurable: true, value: height })
  for (const callback of observed) callback()
}

function pill() {
  return screen.getByRole("button", { name: /new$/ })
}

function noPill() {
  return screen.queryByRole("button", { name: /new$/ }) === null
}

describe("a following Transcript", () => {
  test("opens pinned to its newest entry, with no pill", () => {
    aTranscript()

    expect(pinnedToBottom()).toBe(true)
    expect(noPill()).toBe(true)
  })

  test("stays on the bottom as entries arrive", () => {
    const { arrive } = aTranscript()
    const wasAt = port().scrollTop

    arrive([...HISTORY, evaluation(5)])

    expect(port().scrollTop).toBeGreaterThan(wasAt)
    expect(pinnedToBottom()).toBe(true)
  })

  test("keeps its bottom while a running evaluation's output streams in", () => {
    const { arrive } = aTranscript([...HISTORY, evaluation(5, null)])
    const wasAt = port().scrollTop

    arrive([...HISTORY, evaluation(5, null, "Loading 1 of 3\nLoading 2 of 3\n")])

    expect(port().scrollTop).toBeGreaterThan(wasAt)
    expect(pinnedToBottom()).toBe(true)
  })

  test("stays pinned to its newest entry as the prompt grows", () => {
    aTranscript()

    resized(PORT - 20)

    expect(pinnedToBottom()).toBe(true)
  })

  test("stays pinned to its newest entry as the prompt shrinks", () => {
    aTranscript()

    resized(PORT + 20)

    expect(pinnedToBottom()).toBe(true)
  })

  test("is not paused by a scroll that lands before its observer is told", () => {
    aTranscript()

    // The prompt can grow between the last pin and the scroll event that pin queued.
    // user-event has no scroll gesture.
    Object.defineProperty(port(), "clientHeight", { configurable: true, value: PORT - 20 })
    fireEvent.scroll(port())

    expect(pinnedToBottom()).toBe(true)
  })
})

describe("scrolling the Transcript up", () => {
  test("pauses it, and stays where it was scrolled to as the prompt changes height", () => {
    aTranscript()
    scrollUp()
    const wasAt = port().scrollTop

    resized(PORT - 20)

    expect(port().scrollTop).toBe(wasAt)
  })

  test("shows no pill while nothing has arrived below", () => {
    aTranscript()

    scrollUp()

    expect(noPill()).toBe(true)
  })

  test("counts an evaluation ending with a result as one new", () => {
    const { arrive } = aTranscript()
    scrollUp()

    arrive([...HISTORY, evaluation(5)])

    expect(pill()).toHaveTextContent("1 new")
    expect(pinnedToBottom()).toBe(false)
  })

  test("counts one more for each evaluation that ends, raised or having lost its console process", () => {
    const { arrive } = aTranscript()
    scrollUp()

    arrive([...HISTORY, evaluation(5)])
    arrive([...HISTORY, evaluation(5), evaluation(6, RAISED)])
    arrive([...HISTORY, evaluation(5), evaluation(6, RAISED), evaluation(7, LOST)])

    expect(pill()).toHaveTextContent("3 new")
  })

  test("counts an evaluation started elsewhere only when it ends", () => {
    const { arrive } = aTranscript()
    scrollUp()

    arrive([...HISTORY, evaluation(5, null)])
    expect(noPill()).toBe(true)

    arrive([...HISTORY, evaluation(5)])
    expect(pill()).toHaveTextContent("1 new")
  })

  test("counts nothing for a running evaluation's output as it streams", () => {
    const { arrive } = aTranscript([...HISTORY, evaluation(5, null)])
    scrollUp()

    arrive([...HISTORY, evaluation(5, null, "Loading 1 of 3\n")])
    arrive([...HISTORY, evaluation(5, null, "Loading 1 of 3\nLoading 2 of 3\n")])

    expect(noPill()).toBe(true)
  })

  test("counts what the console process printed outside any evaluation as one new", () => {
    const { arrive } = aTranscript()
    scrollUp()

    arrive([...HISTORY, printed(5, "Sidekiq booted\n")])

    expect(pill()).toHaveTextContent("1 new")
  })

  test("counts what arrives into a full Transcript, which drops its oldest entry for each one", () => {
    const full = Array.from({ length: TRANSCRIPT_LIMIT }, (_, at) => evaluation(at + 1))
    const { arrive } = aTranscript(full)
    scrollUp()

    const printing = [...full, printed(TRANSCRIPT_LIMIT + 1, "Sidekiq booted\n")].slice(-TRANSCRIPT_LIMIT)
    arrive(printing)
    const running = [...printing, evaluation(TRANSCRIPT_LIMIT + 2, null)].slice(-TRANSCRIPT_LIMIT)
    arrive(running)
    arrive(running.map((entry) => (entry.id === TRANSCRIPT_LIMIT + 2 ? evaluation(entry.id) : entry)))

    expect(pill()).toHaveTextContent("2 new")
  })
})

describe("resuming the Transcript", () => {
  test("happens silently when it is scrolled back to the bottom", () => {
    const { arrive } = aTranscript()
    scrollUp()
    arrive([...HISTORY, evaluation(5)])

    scrollBackToTheBottom()
    arrive([...HISTORY, evaluation(5), evaluation(6)])

    expect(noPill()).toBe(true)
    expect(pinnedToBottom()).toBe(true)
  })

  test("happens on the pill, which takes it to the bottom and drops the count", async () => {
    const { user, arrive } = aTranscript()
    scrollUp()
    arrive([...HISTORY, evaluation(5)])

    await user.click(pill())

    expect(pinnedToBottom()).toBe(true)
    expect(noPill()).toBe(true)
  })
})

describe("revealing an entry", () => {
  test("above the bottom pauses the Transcript, as scrolling to it would", () => {
    const { arrive } = aTranscript(HISTORY, { entry: 1 })
    // The scroll the reveal caused.
    fireEvent.scroll(port())

    arrive([...HISTORY, evaluation(5)])

    expect(port().scrollTop).toBe(0)
    expect(pill()).toHaveTextContent("1 new")
  })
})

describe("submitting from this tab", () => {
  test("scrolls the Transcript to the bottom and follows again, so the running evaluation is in view", async () => {
    const { user, arrive } = await aDrawer()
    scrollUp()
    arrive([...HISTORY, evaluation(5)])

    await user.type(prompt(), "1 + 1{Enter}")

    expect(pinnedToBottom()).toBe(true)
    expect(noPill()).toBe(true)

    arrive([...HISTORY, evaluation(5), evaluation(6, null)])

    expect(pinnedToBottom()).toBe(true)
  })
})

describe("another tab's submit", () => {
  test("leaves this tab's Transcript where it was, and counts once when its evaluation ends", async () => {
    const { arrive } = await aDrawer()
    scrollUp()
    const wasAt = port().scrollTop

    arrive([...HISTORY, evaluation(5, null)])
    arrive([...HISTORY, evaluation(5)])

    expect(port().scrollTop).toBe(wasAt)
    expect(pill()).toHaveTextContent("1 new")
  })
})

describe("filling the prompt without running anything", () => {
  test("from the Input history leaves the Transcript paused where it was", async () => {
    const kept: HistoryEntry[] = [{ input: "Post.count", at: Date.now(), pid: READY.pid, raised: false }]
    localStorage.setItem(`rails-log-reader.repl-history:${ROOT}`, JSON.stringify(kept))
    const { user, arrive } = await aDrawer()
    scrollUp()
    const wasAt = port().scrollTop

    await user.click(prompt())
    await user.keyboard("{ArrowUp}{Enter}")
    arrive([...HISTORY, evaluation(5)])

    expect(prompt()).toHaveValue("Post.count")
    expect(port().scrollTop).toBe(wasAt)
    expect(pill()).toHaveTextContent("1 new")
  })

  test("with a Completion leaves the Transcript paused where it was", async () => {
    const { user, arrive } = await aDrawer(HISTORY, ["complete"])
    scrollUp()
    const wasAt = port().scrollTop

    await user.type(prompt(), "upl")
    await user.keyboard("{Tab}")
    await screen.findByDisplayValue("upload")
    arrive([...HISTORY, evaluation(5)])

    expect(port().scrollTop).toBe(wasAt)
    expect(pill()).toHaveTextContent("1 new")
  })
})

describe("a Restart", () => {
  /** The fresh console process's Transcript, enough to overflow the port again. */
  const RESTARTED = [printed(6, "Loading development environment (rails 8.0.2)\n"), evaluation(7), evaluation(8), evaluation(9)]

  test("from this tab refollows the Transcript and drops its count", async () => {
    const { user, arrive } = await aDrawer()
    scrollUp()
    arrive([...HISTORY, evaluation(5)])

    await user.click(within(replDrawer()).getByRole("button", { name: "Restart" }))
    arrive([], 1)

    expect(noPill()).toBe(true)

    arrive(RESTARTED, 1)

    expect(pinnedToBottom()).toBe(true)
    expect(noPill()).toBe(true)
  })

  test("from another tab refollows the Transcript and drops its count", async () => {
    const { arrive } = await aDrawer()
    scrollUp()
    arrive([...HISTORY, evaluation(5)])

    arrive([], 1)
    arrive(RESTARTED, 1)

    expect(pinnedToBottom()).toBe(true)
    expect(noPill()).toBe(true)
  })
})

describe("folding the REPL drawer", () => {
  test("keeps a paused Transcript paused, where it was, when it reopens", async () => {
    const { user, arrive } = await aDrawer()
    scrollUp()
    const wasAt = port().scrollTop

    await foldRepl(user)
    await openRepl(user)
    arrive([...HISTORY, evaluation(5)])

    expect(port().scrollTop).toBe(wasAt)
    expect(pill()).toHaveTextContent("1 new")
  })

  test("counts what ended while it was folded, which the Unseen result hands over to the pill", async () => {
    const { user, arrive } = await aDrawer()
    scrollUp()
    await foldRepl(user)

    arrive([...HISTORY, evaluation(5)])
    expect(unseenMark()).toBeVisible()

    await openRepl(user)

    expect(unseenMarkAbsent()).not.toBeInTheDocument()
    expect(pill()).toHaveTextContent("1 new")
  })

  test("keeps a following Transcript following, so it reopens on its newest entry", async () => {
    const { user, arrive } = await aDrawer()
    await foldRepl(user)

    arrive([...HISTORY, evaluation(5)])
    await openRepl(user)

    expect(within(port()).getAllByRole("listitem").at(-1)).toHaveTextContent("Post.find(5)")
    expect(pinnedToBottom()).toBe(true)
    expect(noPill()).toBe(true)
  })

  test("leaves a reload onto a folded drawer following, with the history it replays uncounted", async () => {
    const { user, load } = aReloadOntoAFoldedDrawer()

    load(HISTORY)
    await openRepl(user)

    expect(pinnedToBottom()).toBe(true)
    expect(noPill()).toBe(true)
  })
})
