import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * `config/application.rb` is the one file that marks a Rails root unambiguously — a
 * `Gemfile` or a `log/` directory could be anything's.
 */
const RAILS_ROOT_MARKER = join("config", "application.rb")

/**
 * The Rails root the Reader was started from, or `null` if it was started somewhere else.
 * Searched upward so that "from inside your Rails root" means anywhere in the app, and
 * never downward: the Reader reads one app's `log/`, and guessing which would be a flag.
 */
export function findRailsRoot(from: string): string | null {
  let directory = resolve(from)

  while (true) {
    if (existsSync(join(directory, RAILS_ROOT_MARKER))) return directory

    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

export { RAILS_ROOT_MARKER }
