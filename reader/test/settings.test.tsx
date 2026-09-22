import { afterEach, describe, expect, test } from "bun:test"

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Reader } = await import("../src/ui/Reader")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { unmount: () => void }[] = []

function unmountAll() {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount()
  })
}

afterEach(() => {
  unmountAll()
  localStorage.clear()
  document.body.innerHTML = ""
})

async function openTheReader() {
  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => {
    const root = createRoot(container)
    mounted.push(root)
    root.render(<Reader />)
  })
  return container
}

function settingsDialog(container: HTMLElement) {
  const dialog = container.querySelector<HTMLDialogElement>("dialog[aria-label='Settings']")
  if (dialog === null) throw new Error("the Reader has no Settings dialog")
  return dialog
}

function button(scope: Element, named: string) {
  const found = [...scope.querySelectorAll("button")].find((each) => each.textContent === named)
  if (found === undefined) throw new Error(`no ${named} button`)
  return found
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

async function openSettings(container: HTMLElement) {
  await click(button(container.querySelector(".reader-bar-controls")!, "Settings"))
  return settingsDialog(container)
}

describe("the Settings dialog", () => {
  test("is closed until its trigger in the reader bar is clicked", async () => {
    const container = await openTheReader()

    expect(settingsDialog(container).open).toBe(false)

    const dialog = await openSettings(container)

    expect(dialog.open).toBe(true)
  })

  test("closes on its Close button", async () => {
    const container = await openTheReader()
    const dialog = await openSettings(container)

    await click(button(dialog, "Close"))

    expect(dialog.open).toBe(false)
  })

  test("closes on a click on the backdrop, and not on a click inside it", async () => {
    const container = await openTheReader()
    const dialog = await openSettings(container)

    await click(dialog.querySelector("[role='group'][aria-label='Theme'] button")!)
    expect(dialog.open).toBe(true)

    await act(async () => {
      dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(dialog.open).toBe(false)
  })

  test("stays open when a drag that began inside it is released over the backdrop", async () => {
    const container = await openTheReader()
    const dialog = await openSettings(container)

    await act(async () => {
      schemeField(dialog).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(dialog.open).toBe(true)
  })

  test("holds the Theme control, which the reader bar no longer does", async () => {
    const container = await openTheReader()

    const themes = [...container.querySelectorAll("[role='group'][aria-label='Theme']")]

    expect(themes).toHaveLength(1)
    expect(settingsDialog(container).contains(themes[0]!)).toBe(true)
  })
})

function schemeField(dialog: HTMLDialogElement) {
  const field = dialog.querySelector<HTMLInputElement>("input[aria-label='Editor scheme']")
  if (field === null) throw new Error("the Settings dialog has no Editor scheme field")
  return field
}

/** Typed as a person types it: a value React's own input tracking sees change, then an `input`. */
async function type(field: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function leave(field: HTMLInputElement) {
  await act(async () => {
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
  })
}

const SCHEME_KEY = "rails-log-reader.editor-scheme"

describe("the Editor scheme setting", () => {
  test("is empty until set, with the VS Code template shown as code in its description and never in the field", async () => {
    const container = await openTheReader()
    const dialog = await openSettings(container)
    const field = schemeField(dialog)

    expect(field.value).toBe("")
    expect(field.placeholder).toBe("")
    expect(dialog.querySelector(".setting-description code")?.textContent).toBe("vscode://file{path}:{line}")
    expect(localStorage.getItem(SCHEME_KEY)).toBeNull()
  })

  test("is not saved while it is being typed, only once the field is left", async () => {
    const container = await openTheReader()
    const field = schemeField(await openSettings(container))

    await type(field, "idea://open?file={path}&line={line}")
    expect(localStorage.getItem(SCHEME_KEY)).toBeNull()

    await leave(field)
    expect(localStorage.getItem(SCHEME_KEY)).toBe("idea://open?file={path}&line={line}")
  })

  test("is still set on the next page load", async () => {
    const container = await openTheReader()
    const field = schemeField(await openSettings(container))
    await type(field, "subl://open?url=file://{path}&line={line}")
    await leave(field)

    unmountAll()
    const reopened = await openTheReader()

    expect(schemeField(settingsDialog(reopened)).value).toBe("subl://open?url=file://{path}&line={line}")
  })

  test("is refused without a {path} in it, keeping the one saved before and saying why until it is fixed", async () => {
    localStorage.setItem(SCHEME_KEY, "vscode://file{path}")
    const container = await openTheReader()
    const field = schemeField(await openSettings(container))

    await type(field, "vscode://file{line}")
    await leave(field)

    expect(localStorage.getItem(SCHEME_KEY)).toBe("vscode://file{path}")
    expect(field.getAttribute("aria-invalid")).toBe("true")
    expect(errorShown(container)).toContain("{path}")

    await type(field, "vscode://file{path}:{line}")
    await leave(field)

    expect(localStorage.getItem(SCHEME_KEY)).toBe("vscode://file{path}:{line}")
    expect(field.getAttribute("aria-invalid")).toBeNull()
    expect(errorShown(container)).toBeNull()
  })

  test("reads a stored scheme with no {path} in it as unset", async () => {
    localStorage.setItem(SCHEME_KEY, "vscode://file{line}")
    const container = await openTheReader()

    expect(schemeField(await openSettings(container)).value).toBe("")
  })

  test("goes back to unset when the field is emptied", async () => {
    localStorage.setItem(SCHEME_KEY, "vscode://file{path}")
    const container = await openTheReader()
    const field = schemeField(await openSettings(container))

    await type(field, "  ")
    await leave(field)

    expect(localStorage.getItem(SCHEME_KEY)).toBeNull()
    expect(errorShown(container)).toBeNull()
  })

  test("reads as unset, and still opens, when site data is blocked and storage throws", async () => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError")
    }
    Storage.prototype.getItem = blocked
    Storage.prototype.setItem = blocked

    try {
      const container = await openTheReader()
      const field = schemeField(await openSettings(container))
      expect(field.value).toBe("")

      await type(field, "vscode://file{path}")
      await leave(field)
      expect(field.value).toBe("vscode://file{path}")
    } finally {
      Storage.prototype.getItem = getItem
      Storage.prototype.setItem = setItem
    }
  })
})

describe("each setting's description", () => {
  function descriptions(dialog: HTMLDialogElement) {
    return [...dialog.querySelectorAll(".setting")].map((setting) => ({
      label: setting.querySelector(".setting-label")?.textContent,
      description: setting.querySelector(".setting-description")?.textContent ?? null,
    }))
  }

  async function onPlatform(platform: string) {
    const own = Object.getOwnPropertyDescriptor(navigator, "platform")
    Object.defineProperty(navigator, "platform", { value: platform, configurable: true })
    try {
      return descriptions(await openSettings(await openTheReader()))
    } finally {
      if (own === undefined) delete (navigator as { platform?: string }).platform
      else Object.defineProperty(navigator, "platform", own)
    }
  }

  test("is Ctrl-worded off macOS, and absent for the Theme", async () => {
    expect(await onPlatform("Linux x86_64")).toEqual([
      { label: "Theme", description: null },
      {
        label: "Editor scheme",
        description: "URI your editor opens files with, like vscode://file{path}:{line}. Ctrl-click a file location in the Detail column to open it.",
      },
    ])
  })

  test("is ⌘-worded on macOS", async () => {
    const [, scheme] = await onPlatform("MacIntel")

    expect(scheme?.description).toBe(
      "URI your editor opens files with, like vscode://file{path}:{line}. ⌘-click a file location in the Detail column to open it.",
    )
  })
})

function errorShown(container: HTMLElement) {
  return container.querySelector("[role='alert']")?.textContent ?? null
}
