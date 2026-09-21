import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test"

import { aRun } from "./sidecar.fixtures"
import type { Envelope } from "../src/shared/wire"
import type { RunIdentity } from "../src/shared/run-identity"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")
const { activityTable } = await import("../src/shared/activity")
const { latchRunIdentity } = await import("../src/shared/run-identity")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { unmount: () => void }[] = []
let opened: Mock<(url: string | URL) => void>

beforeEach(() => {
  opened = spyOn(window.location, "assign").mockImplementation(() => {})
})

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount()
  })
  document.body.innerHTML = ""
  localStorage.clear()
  opened.mockRestore()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const SCHEME_KEY = "rails-log-reader.editor-scheme"
const RAILS_ROOT = "/home/dev/example-app"
const RELATIVE_FRAME = "app/models/order.rb:44:in `block in recalculate_total!'"
const GEM_FRAME = "/home/dev/.gem/rack-3.1.8/lib/rack/urlmap.rb:74:in 'Rack::URLMap#call'"
const PSEUDO_FRAME = "<internal:kernel>:187:in `loop'"

/** The Reader over a Run that raised with `backtrace`, the request already selected. */
async function aRaise(backtrace: string[], { header = true } = {}) {
  const run = aRun("srv-1")
  const container = await theReaderShowing("/orders", [
    ...(header ? [run.header()] : []),
    run.start("req-1", "POST", "/orders"),
    run.finish("req-1", { status: 500, exception: { class: "NoMethodError", message: "boom", backtrace } }),
  ])
  for (const reveal of [...container.querySelectorAll(".backtrace-reveal")]) {
    await act(async () => reveal.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  }
  return container
}

/** The Reader over `envelopes`, the row for `path` already selected. */
async function theReaderShowing(path: string, envelopes: Envelope[]) {
  const activity = activityTable()
  activity.fold(envelopes)
  const identity: RunIdentity = latchRunIdentity(null, envelopes)

  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => {
    const root = createRoot(container)
    mounted.push(root)
    root.render(<Reader rows={activity.rows} railsRoot={identity?.railsRoot ?? null} />)
  })

  const row = [...container.querySelectorAll("tbody tr")].find(
    (candidate) => candidate.querySelector(".cell-path")?.textContent === path,
  )!
  await act(async () => {
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  return container
}

function frames(container: HTMLElement) {
  return [...container.querySelectorAll(".backtrace > li")]
}

function locationIn(frame: Element | undefined) {
  const location = frame?.querySelector(".source-location")
  if (location == null) throw new Error("the frame has no openable path:line")
  return location
}

async function click(element: Element, modifiers: MouseEventInit = {}) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers }))
  })
}

async function press(key: "Control" | "Meta") {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: key === "Control", metaKey: key === "Meta" }))
  })
}

async function release(key: "Control" | "Meta") {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key }))
  })
}

async function hover(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
  })
}

async function unhover(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }))
  })
}

function armed(container: HTMLElement) {
  return [...container.querySelectorAll(".source-location-armed")].map((location) => location.textContent)
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
    const container = await aRaise([RELATIVE_FRAME])

    await click(locationIn(frames(container)[0]), { ctrlKey: true })

    expect(opened.mock.calls).toEqual([[`vscode://file${RAILS_ROOT}/app/models/order.rb:44`]])
  })

  test("opens a gem frame from a revealed gap, its absolute path used as is", async () => {
    const container = await aRaise([RELATIVE_FRAME, GEM_FRAME])
    const gem = frames(container)[1]

    expect(gem?.textContent).toBe(GEM_FRAME)
    await click(locationIn(gem), { ctrlKey: true })

    expect(opened.mock.calls).toEqual([["vscode://file/home/dev/.gem/rack-3.1.8/lib/rack/urlmap.rb:74"]])
  })

  test("marks only the path:line portion as openable, never the method", async () => {
    const container = await aRaise([RELATIVE_FRAME])
    const frame = frames(container)[0]!

    expect(locationIn(frame).textContent).toBe("app/models/order.rb:44")
    expect(frame.textContent).toBe(RELATIVE_FRAME)

    const method = [...frame.childNodes].find((node) => node.textContent === ":in `block in recalculate_total!'")
    expect(method).toBeDefined()
    await click(frame, { ctrlKey: true })

    expect(opened).not.toHaveBeenCalled()
  })

  test("a plain click opens nothing", async () => {
    const container = await aRaise([RELATIVE_FRAME])

    await click(locationIn(frames(container)[0]))

    expect(opened).not.toHaveBeenCalled()
  })

  test("is ⌘-click on macOS, where Ctrl-click opens nothing", async () => {
    await onPlatform("MacIntel", async () => {
      const container = await aRaise([RELATIVE_FRAME])
      const location = locationIn(frames(container)[0])

      await click(location, { ctrlKey: true })
      expect(opened).not.toHaveBeenCalled()

      await click(location, { metaKey: true })
      expect(opened).toHaveBeenCalledTimes(1)
    })
  })

  test("leaves a relative frame inert while rails_root is unknown", async () => {
    const container = await aRaise([RELATIVE_FRAME], { header: false })
    const frame = frames(container)[0]!

    expect(frame.querySelector(".source-location")).toBeNull()
    expect(frame.textContent).toBe(RELATIVE_FRAME)
    await click(frame, { ctrlKey: true })

    expect(opened).not.toHaveBeenCalled()
  })

  test("leaves a pseudo-path frame inert, rendered as before", async () => {
    const container = await aRaise([PSEUDO_FRAME])
    const frame = frames(container)[0]!

    expect(frame.querySelector(".source-location")).toBeNull()
    expect(frame.innerHTML).toBe(PSEUDO_FRAME.replace("<", "&lt;").replace(">", "&gt;"))
  })

  test("keeps search highlighting across the path:line and the method", async () => {
    const container = await aRaise([RELATIVE_FRAME])
    await act(async () => {
      const search = container.querySelector<HTMLInputElement>(".search-box")!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "rb:44:in")
      search.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const frame = frames(container)[0]!

    expect([...frame.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["rb:44", ":in"])
    expect(locationIn(frame).querySelector("mark")?.textContent).toBe("rb:44")
    expect(frame.textContent).toBe(RELATIVE_FRAME)
  })
})

describe("the underline while the modifier is held", () => {
  test("shows only on the hovered frame, and only while the modifier is down", async () => {
    const container = await aRaise([RELATIVE_FRAME, GEM_FRAME])
    const [first, second] = frames(container).map(locationIn)

    await press("Control")
    expect(armed(container)).toEqual([])

    await hover(second!)
    expect(armed(container)).toEqual([second!.textContent])

    await unhover(second!)
    await hover(first!)
    expect(armed(container)).toEqual([first!.textContent])

    await release("Control")
    expect(armed(container)).toEqual([])
  })

  test("needs the hover too: hovering with no modifier shows nothing", async () => {
    const container = await aRaise([RELATIVE_FRAME])

    await hover(locationIn(frames(container)[0]))

    expect(armed(container)).toEqual([])
  })

  test("clears when the window loses focus with the modifier still down", async () => {
    const container = await aRaise([RELATIVE_FRAME])
    await hover(locationIn(frames(container)[0]))
    await press("Control")
    expect(armed(container)).toHaveLength(1)

    await act(async () => {
      window.dispatchEvent(new Event("blur"))
    })

    expect(armed(container)).toEqual([])
  })

  test("is ⌘ on macOS, not Ctrl", async () => {
    await onPlatform("MacIntel", async () => {
      const container = await aRaise([RELATIVE_FRAME])
      await hover(locationIn(frames(container)[0]))

      await press("Control")
      expect(armed(container)).toEqual([])
      await release("Control")

      await press("Meta")
      expect(armed(container)).toHaveLength(1)
    })
  })
})

describe("opening a frame with no Editor scheme set", () => {
  function settingsDialog(container: HTMLElement) {
    return container.querySelector<HTMLDialogElement>("dialog[aria-label='Settings']")!
  }

  function schemeSetting(container: HTMLElement) {
    return [...settingsDialog(container).querySelectorAll(".setting")].find(
      (setting) => setting.querySelector(".setting-label")?.textContent === "Editor scheme",
    )!
  }

  function schemeField(container: HTMLElement) {
    return settingsDialog(container).querySelector<HTMLInputElement>("input[aria-label='Editor scheme']")!
  }

  function outlined(container: HTMLElement) {
    return [...settingsDialog(container).querySelectorAll(".setting-targeted")]
  }

  test("opens Settings at the Editor scheme, focused and outlined, and opens nothing", async () => {
    const container = await aRaise([RELATIVE_FRAME])

    await click(locationIn(frames(container)[0]), { ctrlKey: true })

    expect(settingsDialog(container).open).toBe(true)
    expect(document.activeElement).toBe(schemeField(container))
    expect(outlined(container)).toEqual([schemeSetting(container)])
    expect(opened).not.toHaveBeenCalled()
  })

  test("keeps the outline until the dialog closes, and shows none when opened from the reader bar", async () => {
    const container = await aRaise([RELATIVE_FRAME])
    await click(locationIn(frames(container)[0]), { ctrlKey: true })

    await act(async () => {
      settingsDialog(container).close()
    })
    expect(outlined(container)).toEqual([])

    const trigger = [...container.querySelectorAll(".reader-bar-controls button")].find(
      (button) => button.textContent === "Settings",
    )!
    await click(trigger)

    expect(settingsDialog(container).open).toBe(true)
    expect(outlined(container)).toEqual([])
  })

  test("does not open the clicked frame once a scheme is saved — it takes another click", async () => {
    const container = await aRaise([RELATIVE_FRAME])
    await click(locationIn(frames(container)[0]), { ctrlKey: true })
    const field = schemeField(container)

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "vscode://file{path}")
      field.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    })
    await act(async () => {
      settingsDialog(container).close()
    })
    expect(opened).not.toHaveBeenCalled()

    await click(locationIn(frames(container)[0]), { ctrlKey: true })

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

function callsites(container: HTMLElement) {
  return [...container.querySelectorAll(".sql-callsite, .log-callsite")]
}

const SQL_CALLSITE = "app/controllers/feed_controller.rb:9:in 'FeedController#index'"
const LOG_CALLSITE = "/home/dev/.gem/actionview-8.0.2/lib/action_view/template.rb:251:in 'block in render'"

describe("opening a Callsite in the editor", () => {
  beforeEach(() => localStorage.setItem(SCHEME_KEY, "vscode://file{path}:{line}"))

  test("opens an SQL event's relative callsite resolved against rails_root", async () => {
    const container = await aTimeline((run) => [run.sql("req-1", "SELECT 1", { callsite: SQL_CALLSITE })])

    await click(locationIn(callsites(container)[0]), { ctrlKey: true })

    expect(opened.mock.calls).toEqual([[`vscode://file${RAILS_ROOT}/app/controllers/feed_controller.rb:9`]])
  })

  test("opens an App log event's absolute callsite as is, a gem's included", async () => {
    const container = await aTimeline((run) => [
      run.log("req-1", "Rendered feed/index.html.erb", { source: "rails", callsite: LOG_CALLSITE }),
    ])

    await click(locationIn(callsites(container)[0]), { ctrlKey: true })

    expect(opened.mock.calls).toEqual([["vscode://file/home/dev/.gem/actionview-8.0.2/lib/action_view/template.rb:251"]])
  })

  test("marks only the path:line as openable, never the ↳ or the method", async () => {
    const container = await aTimeline((run) => [run.log("req-1", "Feed cache MISS", { callsite: SQL_CALLSITE })])
    const line = callsites(container)[0]!

    expect(line.textContent).toBe(`↳ ${SQL_CALLSITE}`)
    expect(locationIn(line).textContent).toBe("app/controllers/feed_controller.rb:9")
    await click(line, { ctrlKey: true })

    expect(opened).not.toHaveBeenCalled()
  })

  test("a plain click opens nothing", async () => {
    const container = await aTimeline((run) => [run.sql("req-1", "SELECT 1", { callsite: SQL_CALLSITE })])

    await click(locationIn(callsites(container)[0]))

    expect(opened).not.toHaveBeenCalled()
  })

  test("leaves a relative callsite inert while rails_root is unknown", async () => {
    const container = await aTimeline((run) => [run.sql("req-1", "SELECT 1", { callsite: SQL_CALLSITE })], {
      header: false,
    })
    const line = callsites(container)[0]!

    expect(line.querySelector(".source-location")).toBeNull()
    expect(line.textContent).toBe(`↳ ${SQL_CALLSITE}`)
  })

  test("leaves a pseudo-path or line-less callsite inert", async () => {
    const container = await aTimeline((run) => [
      run.log("req-1", "one", { callsite: "(eval at app/models/post.rb:3):1:in 'x'" }),
      run.log("req-1", "two", { callsite: "app/models/post.rb" }),
    ])

    expect(callsites(container).map((line) => line.querySelector(".source-location"))).toEqual([null, null])
  })

  test("never opens a path written in a log message, not even a ↳ line kept in the timeline", async () => {
    const container = await aTimeline((run) => [run.log("req-1", `  ↳ ${SQL_CALLSITE}`, { source: "rails" })])

    expect(container.querySelector(".log-message .source-location")).toBeNull()
    await click(container.querySelector(".log-message")!, { ctrlKey: true })

    expect(opened).not.toHaveBeenCalled()
  })

  test("underlines only the hovered callsite, only while the modifier is down", async () => {
    const container = await aTimeline((run) => [
      run.sql("req-1", "SELECT 1", { callsite: SQL_CALLSITE }),
      run.log("req-1", "Rendered", { callsite: LOG_CALLSITE }),
    ])
    const [first, second] = callsites(container).map(locationIn)

    await press("Control")
    expect(armed(container)).toEqual([])

    await hover(second!)
    expect(armed(container)).toEqual([second!.textContent])

    await unhover(second!)
    await hover(first!)
    expect(armed(container)).toEqual([first!.textContent])

    await release("Control")
    expect(armed(container)).toEqual([])

    await press("Control")
    await act(async () => {
      window.dispatchEvent(new Event("blur"))
    })
    expect(armed(container)).toEqual([])
  })

  test("with no Editor scheme set, opens Settings instead and opens nothing", async () => {
    localStorage.clear()
    const container = await aTimeline((run) => [run.sql("req-1", "SELECT 1", { callsite: SQL_CALLSITE })])

    await click(locationIn(callsites(container)[0]), { ctrlKey: true })

    expect(container.querySelector<HTMLDialogElement>("dialog[aria-label='Settings']")!.open).toBe(true)
    expect(opened).not.toHaveBeenCalled()
  })
})
