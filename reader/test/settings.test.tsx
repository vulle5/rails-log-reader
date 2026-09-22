import { describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"

import { openTheReader } from "./reader.harness"

function settingsDialog() {
  return screen.getByRole("dialog", { hidden: true })
}

async function openSettings(user: UserEvent) {
  await user.click(screen.getByRole("button", { name: "Settings" }))
  return screen.getByRole("dialog", { name: "Settings" })
}

function schemeField(dialog: HTMLElement) {
  return within(dialog).getByRole("textbox", { name: "Editor scheme", hidden: true })
}

/** Typed as a person types it, replacing what was there. */
async function type(user: UserEvent, field: HTMLElement, text: string) {
  await user.clear(field)
  // `{` opens a key descriptor in `user.type`; doubled, it is the character itself.
  await user.type(field, text.replaceAll("{", "{{"))
}

/** Leaving the field is what commits it: focus moving on to the next control. */
async function leave(user: UserEvent) {
  await user.tab()
}

describe("the Settings dialog", () => {
  test("is closed until its trigger in the reader bar is clicked", async () => {
    const { user } = openTheReader()

    expect(settingsDialog()).not.toHaveAttribute("open")

    const dialog = await openSettings(user)

    expect(dialog).toHaveAttribute("open")
  })

  test("closes on its Close button", async () => {
    const { user } = openTheReader()
    const dialog = await openSettings(user)

    await user.click(within(dialog).getByRole("button", { name: "Close" }))

    expect(dialog).not.toHaveAttribute("open")
  })

  test("closes on a click on the backdrop, and not on a click inside it", async () => {
    const { user } = openTheReader()
    const dialog = await openSettings(user)

    await user.click(within(within(dialog).getByRole("group", { name: "Theme" })).getAllByRole("button")[0]!)
    expect(dialog).toHaveAttribute("open")

    // The dialog's own box is what the stylesheet leaves showing as the backdrop.
    await user.click(dialog)
    expect(dialog).not.toHaveAttribute("open")
  })

  test("stays open when a drag that began inside it is released over the backdrop", async () => {
    const { user } = openTheReader()
    const dialog = await openSettings(user)

    await user.pointer([
      { keys: "[MouseLeft>]", target: schemeField(dialog) },
      { target: dialog },
      { keys: "[/MouseLeft]", target: dialog },
    ])

    expect(dialog).toHaveAttribute("open")
  })

  test("holds the Theme control, which the reader bar no longer does", () => {
    openTheReader()

    const themes = screen.getAllByRole("group", { name: "Theme", hidden: true })

    expect(themes).toHaveLength(1)
    expect(settingsDialog()).toContainElement(themes[0]!)
  })
})

const SCHEME_KEY = "rails-log-reader.editor-scheme"

describe("the Editor scheme setting", () => {
  test("is empty until set, with the VS Code template shown as code in its description and never in the field", async () => {
    const { user } = openTheReader()
    const dialog = await openSettings(user)
    const field = schemeField(dialog)

    expect(field).toHaveValue("")
    expect(field).not.toHaveAttribute("placeholder")
    const setting = within(dialog).getByRole("listitem", { name: "Editor scheme" })
    expect(within(setting).getByRole("code")).toHaveTextContent(/^vscode:\/\/file\{path\}:\{line\}$/)
    expect(localStorage.getItem(SCHEME_KEY)).toBeNull()
  })

  test("is not saved while it is being typed, only once the field is left", async () => {
    const { user } = openTheReader()
    const field = schemeField(await openSettings(user))

    await type(user, field, "idea://open?file={path}&line={line}")
    expect(localStorage.getItem(SCHEME_KEY)).toBeNull()

    await leave(user)
    expect(localStorage.getItem(SCHEME_KEY)).toBe("idea://open?file={path}&line={line}")
  })

  test("is still set on the next page load", async () => {
    const { user, unmount } = openTheReader()
    const field = schemeField(await openSettings(user))
    await type(user, field, "subl://open?url=file://{path}&line={line}")
    await leave(user)

    unmount()
    openTheReader()

    expect(schemeField(settingsDialog())).toHaveValue("subl://open?url=file://{path}&line={line}")
  })

  test("is refused without a {path} in it, keeping the one saved before and saying why until it is fixed", async () => {
    localStorage.setItem(SCHEME_KEY, "vscode://file{path}")
    const { user } = openTheReader()
    const field = schemeField(await openSettings(user))

    await type(user, field, "vscode://file{line}")
    await leave(user)

    expect(localStorage.getItem(SCHEME_KEY)).toBe("vscode://file{path}")
    expect(field).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("alert")).toHaveTextContent("{path}")

    await type(user, field, "vscode://file{path}:{line}")
    await leave(user)

    expect(localStorage.getItem(SCHEME_KEY)).toBe("vscode://file{path}:{line}")
    expect(field).not.toHaveAttribute("aria-invalid")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  test("reads a stored scheme with no {path} in it as unset", async () => {
    localStorage.setItem(SCHEME_KEY, "vscode://file{line}")
    const { user } = openTheReader()

    expect(schemeField(await openSettings(user))).toHaveValue("")
  })

  test("goes back to unset when the field is emptied", async () => {
    localStorage.setItem(SCHEME_KEY, "vscode://file{path}")
    const { user } = openTheReader()
    const field = schemeField(await openSettings(user))

    await type(user, field, "  ")
    await leave(user)

    expect(localStorage.getItem(SCHEME_KEY)).toBeNull()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
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
      const { user } = openTheReader()
      const field = schemeField(await openSettings(user))
      expect(field).toHaveValue("")

      await type(user, field, "vscode://file{path}")
      await leave(user)
      expect(field).toHaveValue("vscode://file{path}")
    } finally {
      Storage.prototype.getItem = getItem
      Storage.prototype.setItem = setItem
    }
  })
})

describe("each setting's description", () => {
  /** What the description says, read off the text it is described by. */
  function description(setting: HTMLElement | undefined) {
    expect(setting).toHaveAccessibleDescription()
    return within(setting!).getByText(/^URI your editor/)
  }

  async function settingsOn(platform: string) {
    const own = Object.getOwnPropertyDescriptor(navigator, "platform")
    Object.defineProperty(navigator, "platform", { value: platform, configurable: true })
    try {
      const { user } = openTheReader()
      return within(await openSettings(user)).getAllByRole("listitem")
    } finally {
      if (own === undefined) delete (navigator as { platform?: string }).platform
      else Object.defineProperty(navigator, "platform", own)
    }
  }

  test("is Ctrl-worded off macOS, and absent for the Theme", async () => {
    const [theme, scheme, ...others] = await settingsOn("Linux x86_64")

    expect(others).toEqual([])
    expect(theme).toHaveAccessibleName("Theme")
    expect(theme).not.toHaveAccessibleDescription()
    expect(scheme).toHaveAccessibleName("Editor scheme")
    expect(description(scheme)).toHaveTextContent(
      "URI your editor opens files with, like vscode://file{path}:{line}. Ctrl-click a file location in the Detail column to open it.",
    )
  })

  test("is ⌘-worded on macOS", async () => {
    const [, scheme] = await settingsOn("MacIntel")

    expect(description(scheme)).toHaveTextContent(
      "URI your editor opens files with, like vscode://file{path}:{line}. ⌘-click a file location in the Detail column to open it.",
    )
  })
})
