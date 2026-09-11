import type { EmptyState } from "../shared/initializer-status"

/**
 * #28: an empty Reader names its own cause. A table with no rows in it is otherwise the same
 * picture whether the Initializer was never copied in, was copied in and never enabled, or is
 * running and simply has not been asked anything yet — and "is the tool broken?" is the only
 * question that picture raises.
 *
 * Each cause names **one** command, the one that resolves it, and they chain: copying the
 * Initializer in leaves it not enabled, enabling it leaves it idle, and booting Rails with it
 * enabled writes a `run_header`, which is a row, which is the end of this screen. One command
 * each because a list of setup steps is a page to read, and the screen already knows which
 * step the developer is on.
 *
 * Every command is written from the Rails root — which is where the Reader was started, so it
 * is where the terminal beside it already is.
 */
export function EmptyReader({ state }: { state: EmptyState }) {
  const { heading, why, command } = said(state)

  return (
    <section className="empty-state" role="status" aria-label="Why the Activity table is empty">
      <h3>{heading}</h3>
      <p>{why}</p>
      <code className="empty-command">{command}</code>
    </section>
  )
}

function said(state: EmptyState) {
  switch (state.kind) {
    case "not_installed":
      return {
        heading: "The Initializer is not installed",
        why:
          "This app has no config/initializers/rails_log_reader.rb, so nothing is writing events for the " +
          "Reader to show. Copy this Reader's own in:",
        command: `cp ${shellWord(state.masterPath)} config/initializers/rails_log_reader.rb`,
      }
    case "not_enabled":
      return {
        heading: "The Initializer is not enabled",
        why:
          "config/initializers/rails_log_reader.rb is installed, and does nothing until " +
          "log/rails_log_reader.enabled exists — for you only, since log/ is ignored by git. Create it:",
        command: "touch log/rails_log_reader.enabled",
      }
    case "idle":
      return {
        heading: "Enabled, and nothing has happened yet",
        // `restart` and not `server`: the process most likely to be here is one already running,
        // under puma-dev or `rails s`, that booted before the Marker file existed — and both
        // restart on `tmp/restart.txt`. The sentence says what to do when nothing is running,
        // because this state cannot tell the two apart.
        why:
          "Nothing has been written to log/rails_log_reader.jsonl. Rails reads log/rails_log_reader.enabled " +
          "once, when it boots, so a process started before it existed is not writing — restart it, " +
          "or start one if none is running:",
        command: "bin/rails restart",
      }
  }
}

/**
 * A path as the shell will take it whole. Left bare when it is only characters no shell
 * treats specially — the common case, and the one that reads best — and single-quoted
 * otherwise, since the master copy lives wherever the developer cloned the Reader to, and a
 * `My Code` in that path would otherwise be two arguments to `cp`.
 */
function shellWord(path: string) {
  if (/^[\w@%+=:,./-]+$/.test(path)) return path
  return `'${path.replaceAll("'", `'\\''`)}'`
}
