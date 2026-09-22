import { afterEach, beforeEach, describe, expect, test } from "bun:test"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
  document.body.innerHTML = ""
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

    expect(inline.getAttribute("type")).toBeNull()
    expect(inline.hasAttribute("defer")).toBe(false)
    expect(inline.hasAttribute("async")).toBe(false)
  })
})

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")

const mounted: { unmount: () => void }[] = []

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount()
  })
})

/** The Reader opened the way a page load opens it: the inline script first, then React. */
async function openTheReader() {
  runTheInlineScript()

  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => {
    const root = createRoot(container)
    mounted.push(root)
    root.render(<Reader />)
  })
  return container
}

function themeButton(container: HTMLElement, named: string) {
  const found = [...container.querySelectorAll("[role='group'][aria-label='Theme'] button")].find(
    (button) => button.textContent === named,
  )
  if (found === undefined) throw new Error(`no ${named} theme button`)
  return found
}

function chosen(container: HTMLElement) {
  return [...container.querySelectorAll("[role='group'][aria-label='Theme'] button[aria-pressed='true']")].map(
    (button) => button.textContent,
  )
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

describe("choosing a theme", () => {
  test("offers light, dark and following the OS — and follows the OS until told otherwise", async () => {
    const container = await openTheReader()

    expect(chosen(container)).toEqual(["System"])
    expect(themeButton(container, "Light")).toBeDefined()
    expect(themeButton(container, "Dark")).toBeDefined()
  })

  test("paints the theme chosen, over whatever the OS prefers", async () => {
    setOsTheme(false)
    const container = await openTheReader()

    await click(themeButton(container, "Dark"))

    expect(paintedTheme()).toBe("dark")
    expect(chosen(container)).toEqual(["Dark"])
  })

  test("remembers the choice, so the next page load paints it before React is there to", async () => {
    setOsTheme(false)
    const container = await openTheReader()

    await click(themeButton(container, "Dark"))
    act(() => {
      for (const root of mounted.splice(0)) root.unmount()
    })
    delete document.documentElement.dataset.theme

    const reopened = await openTheReader()

    expect(paintedTheme()).toBe("dark")
    expect(chosen(reopened)).toEqual(["Dark"])
  })

  test("follows the OS as it changes, while following it is the choice", async () => {
    setOsTheme(false)
    await openTheReader()

    await act(async () => setOsTheme(true))

    expect(paintedTheme()).toBe("dark")
  })

  test("stays on a chosen theme when the OS changes under it", async () => {
    setOsTheme(false)
    const container = await openTheReader()
    await click(themeButton(container, "Light"))

    await act(async () => setOsTheme(true))

    expect(paintedTheme()).toBe("light")
  })

  test("goes back to following the OS, from wherever it was", async () => {
    setOsTheme(true)
    const container = await openTheReader()
    await click(themeButton(container, "Light"))

    await click(themeButton(container, "System"))

    expect(paintedTheme()).toBe("dark")
    expect(chosen(container)).toEqual(["System"])
  })
})
