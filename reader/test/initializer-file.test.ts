import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  INITIALIZER_RELATIVE_PATH,
  MARKER_RELATIVE_PATH,
  initializerFileStatus,
  repairInitializerFile,
} from "../src/server/initializer-file"

/**
 * #29 at the filesystem seam: a real `config/initializers/` directory standing in for a
 * Work app's, compared against and repaired from the repo's own `reader/rails/rails_log_reader.rb`
 * — the one file this suite never writes to, only ever reads.
 */

const MASTER_PATH = join(import.meta.dir, "..", "rails", "rails_log_reader.rb")

const temporary: string[] = []

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function aWorkApp() {
  const root = await mkdtemp(join(tmpdir(), "initializer-file-"))
  temporary.push(root)
  await mkdir(join(root, "config", "initializers"), { recursive: true })
  return root
}

function initializerPath(root: string) {
  return join(root, INITIALIZER_RELATIVE_PATH)
}

/** What the Reader answers, with the Marker file absent unless a test says otherwise. */
function answer(said: { installed: boolean; current: boolean; enabled?: boolean }) {
  return { enabled: false, masterPath: MASTER_PATH, ...said }
}

describe("initializerFileStatus", () => {
  test("is not installed when the path does not exist at all", async () => {
    const root = await aWorkApp()

    expect(await initializerFileStatus(root)).toEqual(answer({ installed: false, current: false }))
  })

  test("is installed and current when the copy is byte-identical to the master", async () => {
    const root = await aWorkApp()
    await writeFile(initializerPath(root), await readFile(MASTER_PATH))

    expect(await initializerFileStatus(root)).toEqual(answer({ installed: true, current: true }))
  })

  test("is installed and not current when the copy has drifted, by even one byte", async () => {
    const root = await aWorkApp()
    const master = await readFile(MASTER_PATH, "utf8")
    await writeFile(initializerPath(root), `${master}\n# a stray edit`)

    expect(await initializerFileStatus(root)).toEqual(answer({ installed: true, current: false }))
  })

  test("is enabled when the Marker file exists, whatever is in it", async () => {
    // #28's *not enabled* against *enabled but idle*, told apart by one read of the second
    // fixed-contract path — presence is the whole gate, so content is never looked at.
    const root = await aWorkApp()
    await writeFile(initializerPath(root), await readFile(MASTER_PATH))
    await mkdir(join(root, "log"), { recursive: true })
    await writeFile(join(root, MARKER_RELATIVE_PATH), "anything at all")

    expect(await initializerFileStatus(root)).toEqual(answer({ installed: true, current: true, enabled: true }))
  })

  test("reads the Marker file without the Initializer beside it, and without writing either", async () => {
    const root = await aWorkApp()
    await mkdir(join(root, "log"), { recursive: true })
    await writeFile(join(root, MARKER_RELATIVE_PATH), "")

    expect(await initializerFileStatus(root)).toEqual(answer({ installed: false, current: false, enabled: true }))
    expect(await readdir(join(root, "config", "initializers"))).toEqual([])
    expect(await readdir(join(root, "log"))).toEqual(["rails_log_reader.enabled"])
  })

  test("is not enabled when there is no log/ directory at all — a checkout that has never booted Rails", async () => {
    const root = await aWorkApp()

    expect(await initializerFileStatus(root)).toEqual(answer({ installed: false, current: false }))
  })
})

describe("repairInitializerFile", () => {
  test("overwrites the Work app's copy with the master, byte for byte", async () => {
    const root = await aWorkApp()
    await writeFile(initializerPath(root), "# an old copy of the Initializer\n")

    await repairInitializerFile(root)

    expect(await readFile(initializerPath(root))).toEqual(await readFile(MASTER_PATH))
    expect(await initializerFileStatus(root)).toEqual(answer({ installed: true, current: true }))
  })

  test("touches only the file itself — a missing config/initializers/ fails rather than being created", async () => {
    // #29: "overwrites exactly that one path... never touches any other path in the Work
    // app." Every real Rails root already has this directory (`rails new` creates it), so
    // the only app this can happen to is one nowhere near real, and failing honestly beats
    // quietly creating a path the spec never named.
    const root = await mkdtemp(join(tmpdir(), "initializer-file-"))
    temporary.push(root)

    await expect(repairInitializerFile(root)).rejects.toThrow()
    expect(await initializerFileStatus(root)).toEqual(answer({ installed: false, current: false }))
  })

  test("touches no other path in the Work app — the Marker file included", async () => {
    const root = await aWorkApp()
    await mkdir(join(root, "log"), { recursive: true })
    await writeFile(join(root, "log", "rails_log_reader.enabled"), "")
    await writeFile(join(root, "config", "initializers", "other_initializer.rb"), "# untouched\n")

    await repairInitializerFile(root)

    // Still exactly what this suite wrote, never read or removed by the repair.
    expect(await readFile(join(root, "log", "rails_log_reader.enabled"), "utf8")).toBe("")
    expect(await readFile(join(root, "config", "initializers", "other_initializer.rb"), "utf8")).toBe(
      "# untouched\n",
    )
    // And no leftover staging file from the write-then-rename.
    const entries = await readdir(join(root, "config", "initializers"))
    expect(entries.sort()).toEqual(["other_initializer.rb", "rails_log_reader.rb"])
  })
})
