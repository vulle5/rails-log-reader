import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { compile } from "tailwindcss"

const ENTRY = Bun.fileURLToPath(new URL("../src/ui/reader.css", import.meta.url))

/** The Reader's stylesheet compiled for exactly the classes given, the way the plugin compiles it. */
async function compiledFor(candidates: string[]) {
  const compiler = await compile(await readFile(ENTRY, "utf8"), {
    base: dirname(ENTRY),
    async loadStylesheet(id, base) {
      const path = id === "tailwindcss" ? Bun.resolveSync("tailwindcss/index.css", base) : join(base, id)
      return { path, base: dirname(path), content: await readFile(path, "utf8") }
    },
  })
  return compiler.build(candidates)
}

/** Every declaration of the first rule whose selector is exactly `selector`. */
function declarationsOf(css: string, selector: string) {
  const at = css.indexOf(`${selector} {`)
  if (at === -1) throw new Error(`no ${selector} rule in the stylesheet`)
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at))
  return body
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== "")
    .map((declaration) => declaration.slice(0, declaration.indexOf(":")).trim())
}

describe("the Reader's stylesheet", () => {
  test("compiles a Reader colour and nothing for one off its palette", async () => {
    const css = await compiledFor(["bg-sunken", "bg-blue-500", "text-red-600"])

    expect(css).toMatch(/\.bg-sunken\s*\{/)
    expect(css).not.toContain("blue-500")
    expect(css).not.toContain("red-600")
  })

  test("has a dark theme that is token values and nothing else", async () => {
    const css = await compiledFor([])
    const light = declarationsOf(css, ":root, :host")
    const dark = declarationsOf(css, '[data-theme="dark"]')

    expect(dark).toContain("color-scheme")
    for (const property of dark.filter((each) => each !== "color-scheme")) {
      expect(property).toStartWith("--color-")
      expect(light).toContain(property)
    }
  })
})
