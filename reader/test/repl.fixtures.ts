import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RubyNode } from "../src/shared/repl"

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

/** Makes every start of the stub console in `root` say it has no multi-line check. */
export async function stubConsoleUncheckable(root: string) {
  await writeFile(join(root, "log", "stub-console.uncheckable"), "")
}

type Noted = { started: string[] } | { heard: string }

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
