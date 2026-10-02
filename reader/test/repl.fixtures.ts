import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Candidate, Completion, RubyNode } from "../src/shared/repl"

const STUB = Bun.fileURLToPath(new URL("./stub-console.ts", import.meta.url))

/**
 * A temporary Rails root whose `bin/rails` is the stub console in `stub-console.ts`, so a
 * REPL session can be driven without Rails. The caller removes it.
 */
export async function stubConsoleRoot() {
  const root = await mkdtemp(join(tmpdir(), "repl-session-"))
  await mkdir(join(root, "config"), { recursive: true })
  await writeFile(join(root, "config", "application.rb"), "module ExampleApp\nend\n")
  await mkdir(join(root, "log"), { recursive: true })
  await mkdir(join(root, "bin"), { recursive: true })

  const rails = join(root, "bin", "rails")
  await writeFile(rails, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`)
  await chmod(rails, 0o755)
  return root
}

/** Makes every start of the stub console in `root` fail to boot, printing `stderr` on fd 2. */
export async function stubConsoleFailsToBoot(root: string, stderr: string) {
  await writeFile(join(root, "log", "stub-console.fails"), stderr)
}

/**
 * The stand-ins' multi-line check, the stub console's and the Reader harness's: a text is
 * incomplete while it opens more `do`s and `def`s than it `end`s.
 */
export function stubComplete(text: string) {
  const count = (word: RegExp) => text.match(word)?.length ?? 0
  return count(/\b(do|def)\b/g) <= count(/\bend\b/g)
}

/** What the stand-ins offer after a `.`: the methods of any receiver. */
const STUB_METHODS = ["downcase", "each", "upcase", "upcase!"]

/** What the stand-ins offer where no `.` leads: a local, a constant and a keyword, in that order. */
const STUB_NAMES: Candidate[] = [
  { text: "upload", kind: "local" },
  { text: "Upload", kind: "constant" },
  { text: "unless", kind: "keyword" },
]

/**
 * The stand-ins' completion, the stub console's and the Reader harness's, of the word before
 * `caret`: the methods above after a `.`, named after a quoted receiver as a String and after any
 * other as it was typed, and the names above elsewhere. `zzz` completes to nothing.
 */
export function stubCompletion(text: string, caret: number): Completion {
  const [word = ""] = text.slice(0, caret).match(/[^\s(]*$/) ?? []
  const dot = word.lastIndexOf(".")
  const name = word.slice(dot + 1)
  const candidates: Candidate[] =
    dot === -1 ? STUB_NAMES.filter((each) => each.text.startsWith(name)) : STUB_METHODS.filter((method) => method.startsWith(name)).map((method) => ({ text: method, kind: "method" }))

  if (word === "" || candidates.length === 0) return { kind: "none", reason: word === "" ? "Nothing to complete here." : `Nothing completes “${word}”.` }
  const receiver = dot === -1 ? null : word.startsWith('"') ? "String" : word.slice(0, dot)
  return { kind: "candidates", from: caret - name.length, receiver, candidates }
}

/** Makes every start of the stub console in `root` say it has no completion. */
export async function stubConsoleUncompletable(root: string) {
  await writeFile(join(root, "log", "stub-console.uncompletable"), "")
}

/** Makes every start of the stub console in `root` say it has no multi-line check. */
export async function stubConsoleUncheckable(root: string) {
  await writeFile(join(root, "log", "stub-console.uncheckable"), "")
}

type Noted = { started: string[] } | { heard: string } | { completed: string }

async function stubConsoleLog(root: string): Promise<Noted[]> {
  const log = await readFile(join(root, "log", "stub-console.log"), "utf8").catch(() => "")
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Noted)
}

/** The arguments of each start of the stub console in `root`, in order. */
export async function stubConsoleStarts(root: string) {
  return (await stubConsoleLog(root)).flatMap((noted) => ("started" in noted ? [noted.started] : []))
}

/** The text of each completion the stub consoles in `root` were asked for, in order. */
export async function stubConsoleCompleted(root: string) {
  return (await stubConsoleLog(root)).flatMap((noted) => ("completed" in noted ? [noted.completed] : []))
}

/** What the stub consoles in `root` heard from outside, in order: `stdin closed`, `SIGTERM`, `SIGINT`. */
export async function stubConsoleHeard(root: string) {
  return (await stubConsoleLog(root)).flatMap((noted) => ("heard" in noted ? [noted.heard] : []))
}

/** `{a: 1, "b" => [1.0, nil, :c]}` as the eval loop lays it out. */
export const RUBY_HASH: RubyNode = {
  type: "hash",
  inspect: '{a: 1, "b" => [1.0, nil, :c]}',
  pairs: [
    [{ type: "symbol", inspect: ":a" }, { type: "integer", inspect: "1", step: "[:a]" }],
    [
      { type: "string", inspect: '"b"' },
      {
        type: "array",
        inspect: "[1.0, nil, :c]",
        step: '["b"]',
        items: [
          { type: "float", inspect: "1.0", step: "[0]" },
          { type: "nil", inspect: "nil", step: "[1]" },
          { type: "symbol", inspect: ":c", step: "[2]" },
        ],
      },
    ],
  ],
}

/** `Author.new(id: 1, name: "Ada", email: "ada@example.test")` as the eval loop lays it out, its email filtered. */
export const RUBY_RECORD: RubyNode = {
  type: "record",
  class: "Author",
  inspect: '#<Author id: 1, name: "Ada", email: [FILTERED]>',
  fields: [
    ["id", { type: "integer", inspect: "1", step: "[:id]" }],
    ["name", { type: "string", inspect: '"Ada"', step: "[:name]" }],
    ["email", { type: "filtered", inspect: "[FILTERED]", step: "[:email]" }],
  ],
}
