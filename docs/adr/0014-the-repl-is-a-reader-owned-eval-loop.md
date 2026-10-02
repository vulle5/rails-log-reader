# The REPL is a Reader-owned eval loop, not IRB

The REPL drives a `bin/rails console` the Reader spawns, but not through IRB. A loop that ships
with the Reader is loaded with `bin/rails console [--sandbox] -- -r <loop.rb>` and never hands
control back to IRB. It answers JSON frames on file descriptor 3: results, errors (class,
message, backtrace), completions and input checks, each tied to a request id. Structured
results are what the value viewer and the Detail column's backtrace rendering can use, and a
terminal byte stream is not. Settled in
[#144](https://github.com/vulle5/rails-log-reader/issues/144), from the research in
[#138](https://github.com/vulle5/rails-log-reader/issues/138).

## The shape

- **Still a `console` Run.** The Initializer's `run_kind` checks `defined?(Rails::Console)`,
  which `bin/rails console` defines before boot, so the loop's SQL and log lines arrive as that
  process's own Run with no Initializer change. `bin/rails runner` would report `unknown`.
- **The loop file stays with the Reader.** It is passed by absolute path and never copied into
  the Host app, which the Reader only ever reads. It runs under the Host app's Ruby, so it has
  to work on every Ruby that Rails 7.1+ supports.
- **Frames on fd 3, output on fds 1 and 2.** Bun hands the child a fourth pipe. Nothing in the
  Host app knows it exists, so `system`, `STDOUT.puts` or a C extension writing to fd 1 can
  never corrupt a frame. Fds 1 and 2 are read as plain text and credited to the running
  evaluation. The stderr logger Active Record's `console do` block attaches is detached, since
  those queries already reach the Sidecar.
- **Each evaluation runs in `Rails.application.executor.wrap`**, as a request does, so the
  query cache is fresh every time and `reload!` (defined by the loop) is safe. Locals live in
  one long-lived binding.
- **IRB's own pieces, behind feature detection.** The multi-line check uses IRB's lexer, and
  completion uses `TypeCompletor` when `repl_type_completor` is in the bundle and
  `RegexpCompletor` otherwise. Both are internal API. When one is missing, the REPL degrades:
  there is no completion, and Enter always submits.

## Considered options

- **IRB over a pseudo-terminal, shown in a browser terminal (xterm.js).** Refused. It is the
  most faithful: `.irbrc`, `ls`, `show_source`, `binding.irb` and `debug` all work. But what
  comes back is ANSI escape sequences with stdout and stderr merged, so results are text only
  and the REPL is a terminal inside the Reader rather than part of it. `binding.irb` and
  `debug` belong in a real terminal, which the developer still has.
- **IRB over plain pipes.** Refused. It needs `$stdout.sync`, sentinel prompts and `--verbose`
  echo-stripping before it is usable, and it still gives unmarked exceptions and no
  completion.

## Consequences

- IRB commands (`ls`, `show_source`, `edit`) and the developer's `.irbrc` do not exist in the
  REPL unless the loop reimplements them.
- A new IRB release can break completion or the multi-line check without breaking evaluation.
- The console inherits the Reader's environment, not puma-dev's `.powenv` chain, exactly as a
  hand-typed `rails c` does. The Reader has to be started from a shell where `bin/rails
  console` works.
