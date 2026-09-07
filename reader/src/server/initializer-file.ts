import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { InitializerFileStatus } from "../shared/initializer-status"

/**
 * The two fixed-contract paths ADR-0004 relies on to tell *not installed* from *not
 * enabled* from *enabled but idle* using only reads: this file is the half of that contract
 * that reads and writes `config/initializers/rails_log_reader.rb` itself. The Marker file
 * next door, `log/rails_log_reader.enabled`, is not read or written by anything here —
 * creating and removing it stays the developer's own act (#29).
 *
 * Exported so the tests that exercise this contract read the path from here rather than
 * spelling it out a second time.
 */
export const INITIALIZER_RELATIVE_PATH = join("config", "initializers", "rails_log_reader.rb")

/**
 * The Reader's own master copy. Resolved from this file's own location rather than from
 * `process.cwd()` — which is the Work app's root, the thing being compared *against* — and
 * stable because the Reader has no build step: it runs straight out of `reader/src` (see
 * `reader/README.md`), so `import.meta.dir` is always `reader/src/server`.
 */
const MASTER_PATH = join(import.meta.dir, "..", "..", "rails", "rails_log_reader.rb")

function initializerPath(railsRoot: string) {
  return join(railsRoot, INITIALIZER_RELATIVE_PATH)
}

/**
 * `GET /initializer-status`'s whole implementation: two reads and a byte comparison. No
 * parsing, no version sniffing inside the file — a diff is the only thing that can answer
 * "is the file on disk current?" honestly, because the file's own `WIRE_VERSION` constant
 * only says what a *correctly copied* file would say about itself.
 */
export async function initializerFileStatus(railsRoot: string): Promise<InitializerFileStatus> {
  const workCopy = await readFile(initializerPath(railsRoot)).catch((failure: NodeJS.ErrnoException) => {
    if (failure.code !== "ENOENT") throw failure
    return null
  })
  if (workCopy === null) return { installed: false, current: false }

  const master = await readFile(MASTER_PATH)
  return { installed: true, current: workCopy.equals(master) }
}

/**
 * `POST /initializer-repair`'s whole implementation: overwrite exactly the one path, and
 * nothing else — not even `config/initializers/` itself. #29 says "overwrites exactly that
 * one path" and "never touches any other path in the Work app", so this deliberately does
 * not `mkdir` a missing directory into existence: every real Rails root already has
 * `config/initializers/` (`rails new` creates it), so the only app this could ever matter
 * for is one so far from a real Rails root that failing the repair — surfaced to the
 * developer as an ordinary error — is the more honest answer than quietly creating paths
 * the spec named zero of.
 *
 * Written to a temp file in the same directory and renamed into place, so a Rails process
 * mid-boot — reading this same path at the exact moment a developer clicks Repair — sees
 * either the old bytes or the new ones and never a half-written file: `rename(2)` on the
 * same filesystem is atomic, and a straight `writeFile` is not.
 */
export async function repairInitializerFile(railsRoot: string): Promise<void> {
  const master = await readFile(MASTER_PATH)
  const target = initializerPath(railsRoot)

  const staging = `${target}.rails-log-reader-repair-${process.pid}-${Date.now()}`
  await writeFile(staging, master)
  await rename(staging, target)
}
