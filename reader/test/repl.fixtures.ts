import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

/** The arguments of each start of the stub console in `root`, in order. */
export async function stubConsoleStarts(root: string): Promise<string[][]> {
  const log = await readFile(join(root, "log", "stub-console.log"), "utf8").catch(() => "")
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}
