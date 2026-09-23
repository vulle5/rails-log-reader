import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test"
import { fireEvent, screen, within } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"

import { aRun } from "./sidecar.fixtures"
import type { Envelope } from "../src/shared/wire"
import { column, itemsOf, lit, openTheReader, search, select, timeline, wholeText } from "./reader.harness"

let opened: Mock<(url: string | URL) => void>

beforeEach(() => {
  opened = spyOn(window.location, "assign").mockImplementation(() => {})
})

afterEach(() => {
  localStorage.clear()
  opened.mockRestore()
})

const SCHEME_KEY = "rails-log-reader.editor-scheme"
const RAILS_ROOT = "/home/dev/example-app"
const RELATIVE_FRAME = "app/models/order.rb:44:in `block in recalculate_total!'"
const RELATIVE_LOCATION = "app/models/order.rb:44"
const GEM_FRAME = "/home/dev/.gem/rack-3.1.8/lib/rack/urlmap.rb:74:in 'Rack::URLMap#call'"
const GEM_LOCATION = "/home/dev/.gem/rack-3.1.8/lib/rack/urlmap.rb:74"
const PSEUDO_FRAME = "<internal:kernel>:187:in `loop'"

/** The Reader over a Run that raised with `backtrace`, the request already selected. */
async function aRaise(backtrace: string[], { header = true } = {}) {
  const run = aRun("srv-1")
  const user = await theReaderShowing("/orders", [
    ...(header ? [run.header()] : []),
    run.start("req-1", "POST", "/orders"),
    run.finish("req-1", { status: 500, exception: { class: "NoMethodError", message: "boom", backtrace } }),
  ])
  for (const reveal of within(column("Detail column")).queryAllByRole("button", { name: /frames? hidden$/ })) {
    await user.click(reveal)
  }
  return user
}

/** The Reader over `envelopes`, the row for `path` already selected. */
async function theReaderShowing(path: string, envelopes: Envelope[]) {
  const { user } = openTheReader(envelopes)
  await select(user, path)
  return user
}

function frames() {
  return itemsOf(within(column("Detail column")).getByRole("list", { name: "Backtrace" }))
}

/** The openable `path:line` inside `scope`, which is its own element only where it is openable. */
function locationIn(scope: HTMLElement | undefined, location: string) {
  return within(scope!).getByText(location)
}

/** A click with `modifier` held for it, the way a developer makes one. */
async function clickWith(user: UserEvent, modifier: "Control" | "Meta", element: HTMLElement) {
  await user.keyboard(`{${modifier}>}`)
  await user.click(element)
  await user.keyboard(`{/${modifier}}`)
}

async function press(user: UserEvent, key: "Control" | "Meta") {
  await user.keyboard(`{${key}>}`)
}

async function release(user: UserEvent, key: "Control" | "Meta") {
  await user.keyboard(`{/${key}}`)
}

/** The window losing focus, which user-event has no gesture for. */
function blurTheWindow() {
  fireEvent.blur(window)
}

async function onPlatform<T>(platform: string, body: () => Promise<T>) {
  const own = Object.getOwnPropertyDescriptor(navigator, "platform")
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true })
  try {
    return await body()
  } finally {
    if (own === undefined) delete (navigator as { platform?: string }).platform
    else Object.defineProperty(navigator, "platform", own)
  }
}

describe("opening a backtrace frame in the editor", () => {
  beforeEach(() => localStorage.setItem(SCHEME_KEY, "vscode://file{path}:{line}"))

  test("Ctrl-click on a relative frame's path:line opens it resolved against rails_root", async () => {
    const user = await aRaise([RELATIVE_FRAME])

    await clickWith(user, "Control", locationIn(frames()[0], RELATIVE_LOCATION))

    expect(opened.mock.calls).toEqual([[`vscode://file${RAILS_ROOT}/app/models/order.rb:44`]])
  })

  test("opens a gem frame from a revealed gap, its absolute path used as is", async () => {
    const user = await aRaise([RELATIVE_FRAME, GEM_FRAME])
    const gem = frames()[1]

    expect(gem).toHaveTextContent(GEM_FRAME)
    await clickWith(user, "Control", locationIn(gem, GEM_LOCATION))

    expect(opened.mock.calls).toEqual([["vscode://file/home/dev/.gem/rack-3.1.8/lib/rack/urlmap.rb:74"]])
  })

  test("marks only the path:line portion as openable, never the method", async () => {
    const user = await aRaise([RELATIVE_FRAME])
    const frame = frames()[0]!

    expect(locationIn(frame, RELATIVE_LOCATION)).toHaveTextContent(/^app\/models\/order\.rb:44$/)
    expect(frame.textContent).toBe(RELATIVE_FRAME)

    // The method is the frame's own text, outside the openable element.
    expect(within(frame).getByText(":in `block in recalculate_total!'")).toBe(frame)
    await clickWith(user, "Control", frame)

    expect(opened).not.toHaveBeenCalled()
  })

  test("a plain click opens nothing", async () => {
    const user = await aRaise([RELATIVE_FRAME])

    await user.click(locationIn(frames()[0], RELATIVE_LOCATION))

    expect(opened).not.toHaveBeenCalled()
  })

  test("is ⌘-click on macOS, where Ctrl-click opens nothing", async () => {
    await onPlatform("MacIntel", async () => {
      const user = await aRaise([RELATIVE_FRAME])
      const location = locationIn(frames()[0], RELATIVE_LOCATION)

      await clickWith(user, "Control", location)
      expect(opened).not.toHaveBeenCalled()

      await clickWith(user, "Meta", location)
      expect(opened).toHaveBeenCalledTimes(1)
    })
  })

  test("leaves a relative frame inert while rails_root is unknown", async () => {
    const user = await aRaise([RELATIVE_FRAME], { header: false })
    const frame = frames()[0]!

    expect(within(frame).queryByText(RELATIVE_LOCATION)).not.toBeInTheDocument()
    expect(frame.textContent).toBe(RELATIVE_FRAME)
    await clickWith(user, "Control", frame)

    expect(opened).not.toHaveBeenCalled()
  })

  test("leaves a pseudo-path frame inert, rendered as before", async () => {
    await aRaise([PSEUDO_FRAME])
    const frame = frames()[0]!

    expect(within(frame).queryByText("<internal:kernel>:187")).not.toBeInTheDocument()
    expect(frame.innerHTML).toBe(PSEUDO_FRAME.replace("<", "&lt;").replace(">", "&gt;"))
  })

  test("keeps search highlighting across the path:line and the method", async () => {
    const user = await aRaise([RELATIVE_FRAME])
    const frame = frames()[0]!
    const location = locationIn(frame, RELATIVE_LOCATION)

    await search(user, "rb:44:in")

    expect(lit(frame)).toEqual(["rb:44", ":in"])
    expect(lit(location)).toEqual(["rb:44"])
    expect(frame.textContent).toBe(RELATIVE_FRAME)
  })
})

describe("the underline while the modifier is held", () => {
  test("shows only on the hovered frame, and only while the modifier is down", async () => {
    const user = await aRaise([RELATIVE_FRAME, GEM_FRAME])
    const first = locationIn(frames()[0], RELATIVE_LOCATION)
    const second = locationIn(frames()[1], GEM_LOCATION)

    await press(user, "Control")
    expect(first).not.toHaveAttribute("data-armed")
    expect(second).not.toHaveAttribute("data-armed")

    await user.hover(second)
    expect(first).not.toHaveAttribute("data-armed")
    expect(second).toHaveAttribute("data-armed")

    await user.unhover(second)
    await user.hover(first)
    expect(first).toHaveAttribute("data-armed")
    expect(second).not.toHaveAttribute("data-armed")

    await release(user, "Control")
    expect(first).not.toHaveAttribute("data-armed")
    expect(second).not.toHaveAttribute("data-armed")
  })

  test("needs the hover too: hovering with no modifier shows nothing", async () => {
    const user = await aRaise([RELATIVE_FRAME])
    const location = locationIn(frames()[0], RELATIVE_LOCATION)

    await user.hover(location)

    expect(location).not.toHaveAttribute("data-armed")
  })

  test("clears when the window loses focus with the modifier still down", async () => {
    const user = await aRaise([RELATIVE_FRAME])
    const location = locationIn(frames()[0], RELATIVE_LOCATION)
    await user.hover(location)
    await press(user, "Control")
    expect(location).toHaveAttribute("data-armed")

    blurTheWindow()

    expect(location).not.toHaveAttribute("data-armed")
  })

  test("is ⌘ on macOS, not Ctrl", async () => {
    await onPlatform("MacIntel", async () => {
      const user = await aRaise([RELATIVE_FRAME])
      const location = locationIn(frames()[0], RELATIVE_LOCATION)
      await user.hover(location)

      await press(user, "Control")
      expect(location).not.toHaveAttribute("data-armed")
      await release(user, "Control")

      await press(user, "Meta")
      expect(location).toHaveAttribute("data-armed")
    })
  })
})

describe("opening a frame with no Editor scheme set", () => {
  function settingsDialog() {
    return screen.getByRole("dialog", { hidden: true })
  }

  /** Found by position rather than by name: a closed dialog's settings have no name to find. */
  function settings() {
    const [theme, scheme] = within(settingsDialog()).getAllByRole("listitem", { hidden: true })
    return { theme: theme!, scheme: scheme! }
  }

  function schemeField() {
    return within(settingsDialog()).getByRole("textbox", { name: "Editor scheme" })
  }

  test("opens Settings at the Editor scheme, focused and outlined, and opens nothing", async () => {
    const user = await aRaise([RELATIVE_FRAME])

    await clickWith(user, "Control", locationIn(frames()[0], RELATIVE_LOCATION))

    expect(settingsDialog()).toHaveAttribute("open")
    expect(schemeField()).toHaveFocus()
    expect(settings().scheme).toHaveAccessibleName("Editor scheme")
    expect(settings().scheme).toHaveAttribute("data-targeted")
    expect(settings().theme).not.toHaveAttribute("data-targeted")
    expect(opened).not.toHaveBeenCalled()
  })

  test("keeps the outline until the dialog closes, and shows none when opened from the reader bar", async () => {
    const user = await aRaise([RELATIVE_FRAME])
    await clickWith(user, "Control", locationIn(frames()[0], RELATIVE_LOCATION))

    await user.click(within(settingsDialog()).getByRole("button", { name: "Close" }))
    expect(settings().scheme).not.toHaveAttribute("data-targeted")
    expect(settings().theme).not.toHaveAttribute("data-targeted")

    await user.click(screen.getByRole("button", { name: "Settings" }))

    expect(settingsDialog()).toHaveAttribute("open")
    expect(settings().scheme).not.toHaveAttribute("data-targeted")
    expect(settings().theme).not.toHaveAttribute("data-targeted")
  })

  test("does not open the clicked frame once a scheme is saved — it takes another click", async () => {
    const user = await aRaise([RELATIVE_FRAME])
    await clickWith(user, "Control", locationIn(frames()[0], RELATIVE_LOCATION))

    // `{` opens a key descriptor in `user.type`; doubled, it is the character itself.
    await user.type(schemeField(), "vscode://file{{path}")
    await user.tab()
    await user.click(within(settingsDialog()).getByRole("button", { name: "Close" }))
    expect(opened).not.toHaveBeenCalled()

    await clickWith(user, "Control", locationIn(frames()[0], RELATIVE_LOCATION))

    expect(opened.mock.calls).toEqual([[`vscode://file${RAILS_ROOT}/app/models/order.rb`]])
  })
})

/** The Reader over one request's timeline, built by `children`, the request already selected. */
async function aTimeline(children: (run: ReturnType<typeof aRun>) => Envelope[], { header = true } = {}) {
  const run = aRun("srv-1")
  return theReaderShowing("/feed", [
    ...(header ? [run.header()] : []),
    run.start("req-1", "GET", "/feed"),
    ...children(run),
    run.finish("req-1"),
  ])
}

const SQL_CALLSITE = "app/controllers/feed_controller.rb:9:in 'FeedController#index'"
const SQL_LOCATION = "app/controllers/feed_controller.rb:9"
const LOG_CALLSITE = "/home/dev/example-app/app/services/feed_cache.rb:14:in 'FeedCache#fetch'"
const LOG_LOCATION = "/home/dev/example-app/app/services/feed_cache.rb:14"

/** A Callsite's own line, read whole as `verbose_query_logs` prints one. */
function callsiteLine(callsite: string) {
  return within(timeline()).getByText(wholeText(`↳ ${callsite}`))
}

describe("opening a Callsite in the editor", () => {
  beforeEach(() => localStorage.setItem(SCHEME_KEY, "vscode://file{path}:{line}"))

  test("opens an SQL event's relative callsite resolved against rails_root", async () => {
    const user = await aTimeline((run) => [run.sql("req-1", "SELECT 1", { callsite: SQL_CALLSITE })])

    await clickWith(user, "Control", locationIn(callsiteLine(SQL_CALLSITE), SQL_LOCATION))

    expect(opened.mock.calls).toEqual([[`vscode://file${RAILS_ROOT}/app/controllers/feed_controller.rb:9`]])
  })

  test("opens an App log event's absolute callsite as is", async () => {
    const user = await aTimeline((run) => [run.log("req-1", "Feed cache MISS", { callsite: LOG_CALLSITE })])

    await clickWith(user, "Control", locationIn(callsiteLine(LOG_CALLSITE), LOG_LOCATION))

    expect(opened.mock.calls).toEqual([["vscode://file/home/dev/example-app/app/services/feed_cache.rb:14"]])
  })

  test("marks only the path:line as openable, never the ↳ or the method", async () => {
    const user = await aTimeline((run) => [run.log("req-1", "Feed cache MISS", { callsite: SQL_CALLSITE })])
    const line = callsiteLine(SQL_CALLSITE)

    expect(line.textContent).toBe(`↳ ${SQL_CALLSITE}`)
    expect(locationIn(line, SQL_LOCATION)).toHaveTextContent(/^app\/controllers\/feed_controller\.rb:9$/)
    await clickWith(user, "Control", line)

    expect(opened).not.toHaveBeenCalled()
  })

  test("a plain click opens nothing", async () => {
    const user = await aTimeline((run) => [run.sql("req-1", "SELECT 1", { callsite: SQL_CALLSITE })])

    await user.click(locationIn(callsiteLine(SQL_CALLSITE), SQL_LOCATION))

    expect(opened).not.toHaveBeenCalled()
  })

  test("leaves a relative callsite inert while rails_root is unknown", async () => {
    await aTimeline((run) => [run.sql("req-1", "SELECT 1", { callsite: SQL_CALLSITE })], { header: false })
    const line = callsiteLine(SQL_CALLSITE)

    expect(within(line).queryByText(SQL_LOCATION)).not.toBeInTheDocument()
    expect(line.textContent).toBe(`↳ ${SQL_CALLSITE}`)
  })

  test("leaves a pseudo-path or line-less callsite inert", async () => {
    await aTimeline((run) => [
      run.log("req-1", "one", { callsite: "(eval at app/models/post.rb:3):1:in 'x'" }),
      run.log("req-1", "two", { callsite: "app/models/post.rb" }),
    ])

    // Inert is one piece of text: no element inside the line for a click to open.
    expect(callsiteLine("(eval at app/models/post.rb:3):1:in 'x'").childElementCount).toBe(0)
    expect(callsiteLine("app/models/post.rb").childElementCount).toBe(0)
  })

  test("never opens a path written in a log message, not even a ↳ line kept in the timeline", async () => {
    const user = await aTimeline((run) => [run.log("req-1", `  ↳ ${SQL_CALLSITE}`, { source: "rails" })])

    const message = within(timeline()).getByText(`↳ ${SQL_CALLSITE}`)
    expect(within(message).queryByText(SQL_LOCATION)).not.toBeInTheDocument()
    await clickWith(user, "Control", message)

    expect(opened).not.toHaveBeenCalled()
  })

  test("underlines only the hovered callsite, only while the modifier is down", async () => {
    const user = await aTimeline((run) => [
      run.sql("req-1", "SELECT 1", { callsite: SQL_CALLSITE }),
      run.log("req-1", "Feed cache MISS", { callsite: LOG_CALLSITE }),
    ])
    const first = locationIn(callsiteLine(SQL_CALLSITE), SQL_LOCATION)
    const second = locationIn(callsiteLine(LOG_CALLSITE), LOG_LOCATION)

    await press(user, "Control")
    expect(first).not.toHaveAttribute("data-armed")
    expect(second).not.toHaveAttribute("data-armed")

    await user.hover(second)
    expect(first).not.toHaveAttribute("data-armed")
    expect(second).toHaveAttribute("data-armed")

    await user.unhover(second)
    await user.hover(first)
    expect(first).toHaveAttribute("data-armed")
    expect(second).not.toHaveAttribute("data-armed")

    await release(user, "Control")
    expect(first).not.toHaveAttribute("data-armed")
    expect(second).not.toHaveAttribute("data-armed")

    await press(user, "Control")
    blurTheWindow()
    expect(first).not.toHaveAttribute("data-armed")
    expect(second).not.toHaveAttribute("data-armed")
  })

  test("with no Editor scheme set, opens Settings instead and opens nothing", async () => {
    localStorage.clear()
    const user = await aTimeline((run) => [run.sql("req-1", "SELECT 1", { callsite: SQL_CALLSITE })])

    await clickWith(user, "Control", locationIn(callsiteLine(SQL_CALLSITE), SQL_LOCATION))

    expect(screen.getByRole("dialog", { name: "Settings" })).toHaveAttribute("open")
    expect(opened).not.toHaveBeenCalled()
  })
})
