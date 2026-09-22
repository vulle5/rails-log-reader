import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act, screen, within } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"

import { openTheReader as renderTheReader } from "./reader.harness"

const INDEX_HTML = await Bun.file(new URL("../src/ui/index.html", import.meta.url)).text()

/**
 * The OS's answer to `prefers-color-scheme: dark`, and a way to change it mid-test. Stubbed
 * because it is the one input here that belongs to the machine rather than to the Reader:
 * happy-dom has no OS to ask.
 */
let osPrefersDark = false
const listeners = new Set<(event: { matches: boolean }) => void>()

function setOsTheme(dark: boolean) {
  osPrefersDark = dark
  for (const listener of listeners) listener({ matches: dark })
}

const matchMedia = window.matchMedia

beforeEach(() => {
  osPrefersDark = false
  listeners.clear()
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === "(prefers-color-scheme: dark)" && osPrefersDark
    },
    media: query,
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  window.matchMedia = matchMedia
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

/**
 * `index.html`'s own inline script, run as the browser runs it: before anything else, with
 * whatever the page has stored and whatever the OS prefers. Read out of the file rather than
 * restated here, because the file is what ships — a copy of its logic in a test would be a
 * second theme resolution that could agree with itself forever.
 */
function theInlineScript() {
  const page = new DOMParser().parseFromString(INDEX_HTML, "text/html")
  const inline = [...page.querySelectorAll("head script")].find((script) => !script.hasAttribute("src"))
  if (inline === undefined) throw new Error("index.html has no inline script in its <head>")
  return inline
}

function runTheInlineScript() {
  new Function(theInlineScript().textContent ?? "")()
}

function paintedTheme() {
  return document.documentElement.dataset.theme
}

describe("the theme, before React mounts", () => {
  test("follows the OS into dark when nothing has been chosen", () => {
    setOsTheme(true)

    runTheInlineScript()

    expect(paintedTheme()).toBe("dark")
  })

  test("follows the OS into light when nothing has been chosen", () => {
    setOsTheme(false)

    runTheInlineScript()

    expect(paintedTheme()).toBe("light")
  })

  test("paints a choice that was made over whatever the OS prefers", () => {
    setOsTheme(true)
    localStorage.setItem("rails-log-reader.theme", "light")

    runTheInlineScript()

    expect(paintedTheme()).toBe("light")
  })

  test("follows the OS when the choice made was to follow it", () => {
    setOsTheme(true)
    localStorage.setItem("rails-log-reader.theme", "system")

    runTheInlineScript()

    expect(paintedTheme()).toBe("dark")
  })

  test("follows the OS when what is stored is not a theme at all", () => {
    setOsTheme(true)
    localStorage.setItem("rails-log-reader.theme", "solarized")

    runTheInlineScript()

    expect(paintedTheme()).toBe("dark")
  })

  test("still paints a theme when site data is blocked and storage throws", () => {
    setOsTheme(true)
    const getItem = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new DOMException("blocked", "SecurityError")
    }

    try {
      runTheInlineScript()
    } finally {
      Storage.prototype.getItem = getItem
    }

    expect(paintedTheme()).toBe("dark")
  })

  test("is a classic script, so it runs before the page paints rather than after it parses", () => {
    const inline = theInlineScript()

    expect(inline).not.toHaveAttribute("type")
    expect(inline).not.toHaveAttribute("defer")
    expect(inline).not.toHaveAttribute("async")
  })
})

/** The Reader opened the way a page load opens it: the inline script first, then React. */
function openTheReader() {
  runTheInlineScript()
  return renderTheReader()
}

/** The theme switch lives in the Settings dialog, so choosing one starts by opening it. */
async function themes(user: UserEvent) {
  if (screen.queryByRole("dialog") === null) await user.click(screen.getByRole("button", { name: "Settings" }))
  return within(screen.getByRole("group", { name: "Theme" }))
}

async function choose(user: UserEvent, named: string) {
  await user.click((await themes(user)).getByRole("button", { name: named }))
}

async function chosen(user: UserEvent) {
  return (await themes(user))
    .getAllByRole("button", { pressed: true })
    .map((button) => button.textContent)
}

describe("choosing a theme", () => {
  test("offers light, dark and following the OS — and follows the OS until told otherwise", async () => {
    const { user } = openTheReader()

    expect(await chosen(user)).toEqual(["System"])
    expect((await themes(user)).getByRole("button", { name: "Light" })).toBeInTheDocument()
    expect((await themes(user)).getByRole("button", { name: "Dark" })).toBeInTheDocument()
  })

  test("paints the theme chosen, over whatever the OS prefers", async () => {
    setOsTheme(false)
    const { user } = openTheReader()

    await choose(user, "Dark")

    expect(paintedTheme()).toBe("dark")
    expect(await chosen(user)).toEqual(["Dark"])
  })

  test("remembers the choice, so the next page load paints it before React is there to", async () => {
    setOsTheme(false)
    const { user, unmount } = openTheReader()

    await choose(user, "Dark")
    unmount()
    delete document.documentElement.dataset.theme

    const reopened = openTheReader()

    expect(paintedTheme()).toBe("dark")
    expect(await chosen(reopened.user)).toEqual(["Dark"])
  })

  test("follows the OS as it changes, while following it is the choice", () => {
    setOsTheme(false)
    openTheReader()

    // The OS changing is no DOM event, and nothing on screen changes to wait for.
    act(() => setOsTheme(true))

    expect(paintedTheme()).toBe("dark")
  })

  test("stays on a chosen theme when the OS changes under it", async () => {
    setOsTheme(false)
    const { user } = openTheReader()
    await choose(user, "Light")

    act(() => setOsTheme(true))

    expect(paintedTheme()).toBe("light")
  })

  test("goes back to following the OS, from wherever it was", async () => {
    setOsTheme(true)
    const { user } = openTheReader()
    await choose(user, "Light")

    await choose(user, "System")

    expect(paintedTheme()).toBe("dark")
    expect(await chosen(user)).toEqual(["System"])
  })
})
