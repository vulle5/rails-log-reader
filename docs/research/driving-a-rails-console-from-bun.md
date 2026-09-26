# Driving a Rails console from Bun

Research for **Research: Driving a Rails console from Bun** (issue #138), under the map
**Map: Rails log reader V2 — a developer tool** (#137). The decision itself belongs to the
grilling ticket (#144); nothing here settles it.

**Settled before this research:** the REPL is a separate `bin/rails console` process the
Reader spawns from the Host app's Rails root, never code running inside the server. The
question is *how* the Reader drives that process and what each way hands back.

**Evidence levels used below.**
**[verified]** means observed by experiment in this repo (scripts under
[`driving-a-rails-console-from-bun/`](driving-a-rails-console-from-bun/)).
**[source]** means read from the cited source or doc and not exercised.
Experiments ran on Linux only (WSL2, kernel 6.6), with Bun 1.4.2, Ruby 3.4.10, irb 1.18.0,
reline 0.7.0 and Rails 8.1.3.1 (the Example app). **Nothing was run on macOS.**

---

## The short version

| | A. IRB over a PTY | B. IRB over pipes | C. Custom eval loop over stdio |
| --- | --- | --- | --- |
| What comes back | A terminal byte stream with ANSI escapes, cursor movement, Reline's completion dialog and stdout and stderr merged | Plain text. It is only framed if you inject sentinel prompts with a `-r` file | JSON frames: `result`, `error` (class, message, backtrace), streamed `stdout` and `completions`, each tagged with a request id |
| Browser side it implies | A terminal emulator (e.g. xterm.js). The Reader *is* a terminal | A text REPL the Reader builds | A REPL the Reader builds. It can feed the value viewer |
| Incomplete-input detection | Reline does it, in the child | IRB does it and says so through `PROMPT_C` (with a sentinel prompt) | Ask the child (`check`). IRB's own lexer is reusable, but it is internal API |
| Completion | Reline's own dialog, drawn in escapes | None. Only inf-ruby-style hidden evals | A `complete` request calling `IRB::RegexpCompletor` (internal API) |
| SIGINT | Write `\x03` to the PTY **[verified]** | `proc.kill("SIGINT")` **[verified]** | `proc.kill("SIGINT")` plus the loop's own trap **[verified]** |
| `reload!` | Works **[verified]** | Works **[verified]** | You define it (one line) **[verified]** |
| Reaches the Sidecar as a `console` Run | Yes. It is `bin/rails console` | Yes **[verified]** | **Only when launched through `bin/rails console -- -r loop.rb`** **[verified]**. Under `bin/rails runner` it reports `unknown` **[verified]** |
| Fidelity to "my usual `rails c`" | Highest: the user's `.irbrc`, IRB commands, `binding.irb` and `debug` all work | Middling. IRB commands work, the line editor does not | Lowest. It is not IRB, so `ls`, `show_source` and `edit` go unless reimplemented |
| Coupling | Bun ≥ 1.3.5 PTY; Reline's escape protocol | IRB's prompt, verbose and `-r` behaviour | IRB internals, if reused. Otherwise Prism and reflection |

The three findings with the most weight:

1. **The Run question has a clean answer.** Anything started as `bin/rails console` is a
   `console` Run, because the Initializer's `run_kind` checks `defined?(Rails::Console)`.
   Even a fully custom loop can ride on that: it is `require`d through IRB's `-r` flag and
   never returns. `bin/rails runner` does not get there without an Initializer change.
2. **Pipes need three fixes before IRB is usable.** Ruby block-buffers stdout on a pipe, so
   *nothing* arrives until exit. IRB prints no prompt on a non-TTY, so the end of an
   evaluation is invisible. With `--verbose` it echoes every input line back. All three are
   fixable from a `-r` file plus flags **[verified]**.
3. **A PTY hands back a terminal, not results.** Reline stalls about 0.5 s on every prompt
   waiting for a cursor-position reply, unless the Reader answers `ESC[6n` or sets
   `TERM=dumb`. It draws completion as a dialog out of escape sequences, and it merges
   stderr into the same stream **[verified]**. That is fine if the REPL is a terminal
   widget, and hopeless if the Reader wants to parse results out of it.

---

## Common ground: facts that hold for every approach

### How `bin/rails console` hands arguments to IRB

- `ConsoleCommand#initialize` takes everything after `--` and puts it in `ARGV` for IRB.
  So `bin/rails console -- --nomultiline -r /abs/file.rb` reaches IRB's option parser
  **[source]**: railties 8.1.3.1
  [`console_command.rb` L70–82](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/console/console_command.rb#L70-L82).
  Rails 7.1 has the same code **[source]**:
  [v7.1.5 `console_command.rb`](https://github.com/rails/rails/blob/v7.1.5/railties/lib/rails/commands/console/console_command.rb).
  **[verified]** by every IRB experiment below.
- Rails 7.2+ start IRB through `Rails::Console::IRBConsole#start`, which calls
  `IRB.setup(nil)` and then `IRB::Irb.new.run(IRB.conf)`. It swaps in the Rails prompt only
  when `PROMPT_MODE` is still `:DEFAULT`
  **[source]**: [`irb_console.rb` L81–114](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/console/irb_console.rb#L81-L114).
  Rails 7.1 calls `IRB.start` instead, which also parses `ARGV` **[source]**.
- `app.config.console` can replace IRB with any object that responds to `start`
  ([L26–29](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/console/console_command.rb#L26-L29)).
  That is Host-app config, though, so the Reader cannot set it without touching the Host
  app **[source]**.
- `Rails.application.load_console` runs every railtie's `console do` block before IRB
  starts ([L24](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/console/console_command.rb#L24)).
  Active Record's block adds a logger that broadcasts to **STDERR** and turns on
  `attributes_for_inspect = :all`
  ([activerecord `railtie.rb` L66–76](https://github.com/rails/rails/blob/v8.1.3.1/activerecord/lib/active_record/railtie.rb#L66-L76)).
  So every console-launched approach gets coloured SQL log lines on stderr
  **[verified]**, alongside the same queries arriving in the Sidecar.
- `--sandbox` (roll back on exit) belongs to `bin/rails console`
  ([L17–22, L67–68](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/console/console_command.rb#L17-L22)).
  `bin/rails runner` has no equivalent **[source]**.

### Does the console's work reach the Sidecar as a `console` Run?

The Initializer decides the Run kind once, at boot, in
[`reader/rails/rails_log_reader.rb` `run_kind`](../../reader/rails/rails_log_reader.rb)
(`return "console" if defined?(Rails::Console)` comes first). `Rails::Console` is defined by
`console_command.rb` before the app boots, so:

| Launch | `run_header.kind` | Evidence |
| --- | --- | --- |
| `bin/rails console` (over pipes or a PTY) | `console` | **[verified]** over pipes. The PTY path boots the same way |
| `bin/rails console -- -r /abs/reader_repl.rb` (custom loop takes over) | `console` | **[verified]** |
| `bin/rails runner --skip-executor /abs/reader_repl.rb` | `unknown` | **[verified]** |

In every case the evaluated code's SQL and `Rails.logger` lines reached the Sidecar
(`sql`, `app_log`), followed by a `run_end` on exit **[verified]**. The runner route would
need either an Initializer change (e.g. an explicit kind override) or a preload trick to be
labelled `console`. Neither is needed on the console route.

### Signals and lifecycle

- `bin/rails` runs the command in its own process. `Bun.spawn(...).kill("SIGINT")` reaches
  the Ruby process running IRB or the loop **[verified]**. Caveat: if a Host app's
  `bin/rails` is a Spring binstub, the process is a Spring client and this was not tested.
- IRB traps SIGINT in `Irb#run`
  ([`irb.rb` L182–184](https://github.com/ruby/irb/blob/v1.18.0/lib/irb.rb#L182-L184)).
  During evaluation, `signal_handle` raises `IRB::Abort` into the evaluating thread. During
  input, it prints `^C` and discards the pending (possibly multi-line) input
  ([L514–533](https://github.com/ruby/irb/blob/v1.18.0/lib/irb.rb#L514-L533),
  [`irb_abort` L72–74](https://github.com/ruby/irb/blob/v1.18.0/lib/irb.rb#L72-L74)).
  `IGNORE_SIGINT` defaults to true
  ([`init.rb` L87](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/init.rb#L87)).
  **[verified]**: `sleep 30` is interrupted, the session survives, and the next input evaluates.
- IRB exits on `exit` or on stdin EOF. The custom loop exits on stdin EOF. Both run
  `at_exit`, so the Initializer's `run_end` is written **[verified]**. If Bun dies, the
  child's stdin pipe closes, so it exits after its current evaluation **[source: inferred
  from the EOF behaviour, not tested with a killed parent]**.
- Boot takes about 0.45 s to the first prompt in the Example app (bootsnap warm)
  **[verified]**. A real Host app will be slower. Restart means kill and respawn: none of
  the approaches can re-boot a Rails process in place.

### The environment the console inherits

The spawned console inherits **the Reader's** environment, not puma-dev's. puma-dev sources
`~/.powconfig`, `.env`, `.powrc`, `.powenv` and `.pumaenv` before starting the app
([puma-dev README, "Advanced Configuration"](https://github.com/puma/puma-dev/blob/db9ec15c986ec978c2534d628e8694a8e5efc250/README.md#advanced-configuration)).
A console the Reader spawns gets none of that unless the app loads it itself (e.g.
`dotenv-rails`) **[source]**. The same is true of a `rails c` typed into a terminal, so this
is parity with what the developer already has, not a regression. It does mean the Reader
must be started from a shell where `bin/rails console` works (Ruby version manager on
`PATH`).

### Bun's side

- **Pipes**: `Bun.spawn` with `stdin: "pipe"` exposes a `FileSink` (`write` and `flush`).
  `stdout` and `stderr` come back as `ReadableStream`s. `proc.kill(signal)` sends a signal to
  the pid. Indices ≥ 3 of `stdio` accept extra pipes or `"socket-fd"` **[source]**:
  `bun-types` 1.4.1 `bun.d.ts` (`stdio?: [In, Out, Err, ...(Readable | "socket-fd")[]]`).
  **[verified]** for stdin, stdout, stderr and kill.
- **PTY**: `Bun.spawn(cmd, { terminal: { cols, rows, name, data } })` attaches a pseudo-terminal.
  `proc.terminal.write()`, `.resize()`, `.setRawMode()` and termios flag accessors are
  available, and `stdin`, `stdout` and `stderr` become `null`. It was introduced in
  **Bun v1.3.5** ([release notes](https://bun.com/blog/bun-v1.3.5)) for Linux and macOS via
  `openpty()`. The current docs also list Windows via ConPTY
  ([Bun docs: Child processes → terminal](https://bun.com/docs/runtime/child-process)). The
  1.4.1 JSDoc still says "Only available on POSIX systems (Linux, macOS)". Linux is
  **[verified]**, macOS **[source]**.

---

## A. IRB over a pseudo-terminal

**How:** `Bun.spawn(["bin/rails", "console"], { cwd: railsRoot, terminal: {...} })`, then
write keystrokes to `proc.terminal`. See
[`irb-over-pty.ts`](driving-a-rails-console-from-bun/irb-over-pty.ts).

**What IRB picks.** On a TTY with `TERM` ≠ `dumb`, IRB chooses `RelineInputMethod`
([`context.rb` L88–125](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/context.rb#L88-L125),
[`term_interactive?` L708–711](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/context.rb#L708-L711)).
The prompt mode defaults to `:DEFAULT`, which Rails then turns into its own prompt
([`init.rb` L141](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/init.rb#L141)).

**What comes back [verified]** (full log reproducible with the script):

- The Rails prompt `example-app(dev):001> `, coloured, wrapped in cursor-hide/show
  (`ESC[?25l` / `ESC[?25h`), column moves (`ESC[1G`, `ESC[23G`) and line clears (`ESC[K`).
- Bracketed paste toggled around every input (`ESC[?2004h` / `ESC[?2004l`)
  ([reline `ansi.rb` L301–308](https://github.com/ruby/reline/blob/v0.7.0/lib/reline/io/ansi.rb#L301-L308)).
- **A cursor-position query `ESC[6n` before every prompt.** Reline waits up to 0.5 s for the
  terminal to answer
  ([`cursor_pos` L189–211](https://github.com/ruby/reline/blob/v0.7.0/lib/reline/io/ansi.rb#L189-L211)).
  With nothing answering, each prompt appeared about 0.5 s late (startup took two
  timeouts, 0.45 s → 1.48 s). When the script answered `ESC[1;1R`, the prompts were
  immediate. A real terminal emulator in the browser answers this itself.
- Syntax-highlighted echo of the input line and the result (`=> ESC[34mESC[1m2ESC[0m`).
  Multi-line input is re-rendered in place with `ESC[2A` cursor-up moves when the
  expression completes.
- **Completion as a dialog**: typing `Post.cou` then Tab drew a boxed candidate list out of
  background-coloured escape runs (`ESC[30;47m`, `ESC[97;100m`) under the input line.
- stdout and stderr merge into one stream, with `\n` turned into `\r\n` by the TTY.
- **SIGINT**: writing `\x03` to the PTY interrupted `sleep 30` (`IRB::Abort`, session
  alive). Reline enters raw mode with `intr: true`, so ISIG stays on and the line
  discipline sends the signal
  ([`with_raw_input` L108–114](https://github.com/ruby/reline/blob/v0.7.0/lib/reline/io/ansi.rb#L108-L114)).

**Other hazards [source]:**

- IRB pages long output through `less` when `USE_PAGER` is set and STDIN is a TTY with
  `TERM` ≠ `dumb` ([`pager.rb` L60–62](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/pager.rb#L60-L62)).
  The way out is `--no-pager` or `PAGER=cat`. inf-ruby sets `PAGER=cat` for the same reason.
- `TERM=dumb` changes the picture completely. Reline switches to `Reline::Dumb`
  ([`io.rb` L5–8](https://github.com/ruby/reline/blob/v0.7.0/lib/reline/io.rb#L5-L8)),
  IRB no longer considers the terminal interactive, so it falls back to
  `StdioInputMethod` with prompts still printed (STDIN is a TTY). The pager and colour
  switch off too ([`color.rb` L119–125](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/color.rb#L119-L125)).
  That is inf-ruby's world: a PTY for signals, with no line editor.

**What it hands back:** everything IRB does, exactly as a terminal shows it. It keeps the
user's `.irbrc`, IRB commands (`ls`, `show_source`, `edit`, `measure`), history, the Rails
prompt, `binding.irb` and the `debug` gem. It hands back no *results*: the value is
colourised `inspect` text inside a screen-drawing protocol. This approach pairs with a
browser terminal emulator such as [xterm.js](https://github.com/xtermjs/xterm.js). It makes
the REPL a terminal pane that cannot feed the value viewer, and whose input (highlighting,
completion, multi-line editing) belongs to Reline rather than to the Reader.

## B. IRB over plain pipes

**How:** `Bun.spawn(["bin/rails", "console", "--", ...flags], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })`.
See [`irb-over-pipes.ts`](driving-a-rails-console-from-bun/irb-over-pipes.ts).

**What IRB picks.** STDIN is not a TTY, so IRB picks `StdioInputMethod` and prompt mode `:NULL`
([`init.rb` L102–107, L141](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/init.rb#L102-L107)).
Rails then leaves the prompt alone, because it only replaces `:DEFAULT`.

**Run 1: no flags [verified].**

- **stdout arrived all at once, at exit.** Ruby block-buffers `$stdout` when it is a pipe,
  so every result and every `puts` sat in the buffer. The only live output was stderr: the
  `$stderr.puts` and Active Record's coloured SQL lines.
- IRB defaults to verbose when STDIN is not a TTY
  ([`verbose?` L434–447](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/context.rb#L434-L447)),
  so it **echoed every input line** back
  ([`read_input` L244–247](https://github.com/ruby/irb/blob/v1.18.0/lib/irb.rb#L244-L247))
  and printed `Switch to inspect mode.`
- Results use the `:NULL` return format `"%s\n"`: a bare `2`, with no `=>`. So `printed`
  (from `puts`) and `:value` (the result) are indistinguishable lines. Exceptions are also
  printed to **stdout** with `puts`
  ([`handle_exception` L404–459](https://github.com/ruby/irb/blob/v1.18.0/lib/irb.rb#L404-L459)).
- Multi-line `def foo … end` worked. IRB accumulates lines until its lexer says the code is
  terminated ([`read_input_nomultiline` L263–281](https://github.com/ruby/irb/blob/v1.18.0/lib/irb.rb#L263-L281)).
  `reload!`, SIGINT and `exit` all worked.

**Run 2: making it frameable [verified].** Flags:
`--nomultiline --nosingleline --nocolorize --verbose --prompt READER -r irb-sentinel-prompt.rb`.
The [`-r` file](driving-a-rails-console-from-bun/irb-sentinel-prompt.rb) sets
`$stdout.sync = true` and `AUTO_INDENT = false`, and defines a prompt mode out of NUL-wrapped
sentinels. The `-r` modules are required inside `IRB.setup`, after option parsing and
before the prompt mode is validated
([`init.rb` L50–62, L275–277, L471–478](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/init.rb#L50-L62)),
so a mode defined there can be selected with `--prompt`.

- `--verbose` is **required**. Without it, `prompting?` is false on a pipe
  (`StdioInputMethod#prompting?` is `STDIN.tty?`,
  [`input-method.rb` L102–104](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/input-method.rb#L102-L104);
  [`generate_prompt` L608–636](https://github.com/ruby/irb/blob/v1.18.0/lib/irb.rb#L608-L636)).
  The only prompt output is auto-indent padding (a run of spaces). The price of `--verbose`
  is the input echo, which is deterministic and can be dropped.
- The result is a clean frame per statement:
  `<echo>` · any `puts` output · `\0result\0<value>\n` · `\0ready\0`.
  An incomplete expression answers `\0continue\0` instead of `ready`. **That is IRB's own
  incomplete-expression detection, readable by the Reader**: send a line, and `continue`
  means "needs more", `ready` means "evaluated".
- The result can even be structured. A custom inspector
  (`IRB::Inspector.def_inspector`,
  [`inspector.rb` L55–77](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/inspector.rb#L55-L77))
  selected with `--inspect reader_json` turned the RETURN line into
  `{"class":"Integer","inspect":"2"}` **[verified]**
  ([`irb-json-inspector.rb`](driving-a-rails-console-from-bun/irb-json-inspector.rb)).

**What stays hard [verified or source as marked]:**

- An exception has no marker. It is text on stdout followed by `ready` with no `result`.
  So is a command, and so is an assignment when echo is off. Telling "printed output" from
  "the error message" means pattern-matching IRB's message format **[verified]**.
- stdout and stderr are separate pipes, so their relative order is only arrival order
  **[verified]**.
- **No completion.** Reline is off, so there is no completion API on the wire. inf-ruby's
  answer is to send a hidden Ruby snippet through the REPL and scrape its printed output.
  That consumes an IRB line number and sets `_` like any other statement **[source]**
  (see Prior art).
- `binding.irb` in evaluated code opens a nested IRB on the same pipes. It works as text
  but changes prompt state mid-stream **[source, not tested]**.
- Coupling: the framing relies on IRB's verbose echo, prompt formatting and `-r` ordering
  staying as they are in 1.18. Rails 7.1 hosts may carry a much older IRB (railties 7.1
  depends on `irb` unpinned; 7.2+ pins `~> 1.13`).

## C. A custom eval loop over stdio

**How:** a Ruby file shipped with the Reader (never copied into the Host app) that reads
one JSON request per line and writes JSON frames. See
[`reader_repl.rb`](driving-a-rails-console-from-bun/reader_repl.rb) and
[`custom-loop.ts`](driving-a-rails-console-from-bun/custom-loop.ts). It was tried two ways:

1. `bin/rails runner --skip-executor /abs/reader_repl.rb`
2. `bin/rails console -- -r /abs/reader_repl.rb`. The file is `require`d inside
   `IRB.setup` ([`load_modules`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/init.rb#L471-L478)),
   runs the loop, and calls `exit` so control never returns to IRB.

**What comes back [verified, both ways]:**

```
{"event":"ready","run_kind_hint":"console"}
{"id":5,"event":"stdout","text":"printed\n"}       <- live, 0.5 s before the next one
{"id":5,"event":"stdout","text":"later\n"}
{"id":5,"event":"result","inspect":"{a: [1, 2]}","class":"Hash"}
{"id":8,"event":"error","class":"RuntimeError","message":"boom","backtrace":["(reader):1:in '<main>'"]}
{"id":2,"event":"check","complete":false}          <- "def foo"
{"id":11,"event":"completions","candidates":["Post.counter_cached_association_names", …, "Post.count","Post.count_by_sql"]}
{"id":14,"event":"error","class":"Interrupt",…}   <- SIGINT during `sleep 30`; next eval fine
```

- **Results, printed output and exceptions come back as separate parts**, tied to a request
  id. `$stdout` is swapped for an object that turns each write into a frame, so output
  streams live **[verified]**. The result could carry a structure for the value viewer
  instead of (or beside) `inspect`. That is a design choice for the "REPL results" fog,
  not a constraint.
- Locals persist across evaluations (`x = 5`, then `x * 2` gave `10`) through one reused
  binding **[verified]**.
- **Incomplete-expression detection** reused IRB's lexer:
  `IRB::RubyLex#check_code_state(code, local_variables:)` returns `terminated`
  ([`ruby-lex.rb` L48–56](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/ruby-lex.rb#L48-L56)).
  It is Prism-based and marked `:stopdoc:` (internal) **[source]**. The fallback is Prism
  directly, which ships with Ruby ≥ 3.3; older Rubies would need the `prism` gem.
- **Completion** reused `IRB::RegexpCompletor#completion_candidates(preposing, target, postposing, bind:)`
  ([`completion.rb` L157–233](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/completion.rb#L157-L233)).
  `BaseCompletor` is `:nodoc:` (L34) **[source]**. IRB's richer `TypeCompletor` needs the
  `repl_type_completor` gem in the Host app's bundle and silently falls back to regexp
  otherwise ([`context.rb` L713–752](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/context.rb#L713-L752)).
  The public-API alternative is web-console's approach: evaluate `obj.methods` and
  `obj.constants` in the binding.
- **SIGINT**: the loop traps `INT` and raises `Interrupt` into the main thread only while
  evaluating. Idle SIGINTs are ignored **[verified]**.
- **`reload!`** is an IRB helper registered by railties
  ([`irb_console.rb` L54–67](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/console/irb_console.rb#L54-L67)).
  Outside IRB, the loop defines the same one line, `Rails.application.reloader.reload!`
  **[verified]**.
- **Executor wrapping is a choice the loop has to make.** `bin/rails runner` wraps the whole
  script in `Rails.application.executor.wrap` unless `--skip-executor`
  ([`runner_command.rb` L35–44, L68–72](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/runner/runner_command.rb#L35-L44)).
  A REPL-long executor run would keep Active Record's query cache on for the whole session
  (`install_executor_hooks`,
  [`query_cache.rb` L58–60](https://github.com/rails/rails/blob/v8.1.3.1/activerecord/lib/active_record/query_cache.rb#L58-L60))
  **[source]**. The experiment wrapped *each* evaluation instead. Two consecutive
  `Post.count` evaluations both hit the database **[verified]**. Plain `rails console`
  wraps nothing, and `Rails.application.reloader.wrap` per evaluation would add request-like
  auto-reloading. See the
  [Threading and Code Execution guide](https://guides.rubyonrails.org/threading_and_code_execution.html).

**Launch route matters for the Run [verified]:** the runner route's `run_header` says
`kind: "unknown"`. The console `-r` route says `kind: "console"`, keeps `--sandbox`, runs
the `console do` hooks (so SQL lines also appear on stderr) and prints Rails' banner line
before the first frame. The Reader then has to skip non-JSON lines until `ready`.

**What is lost:** IRB itself. That means the user's `.irbrc` customisations of prompt and
inspect, IRB commands (`ls`, `show_source`, `edit`, `help`), history, and the `debug`
integration. `binding.irb` or `debugger` inside evaluated code would start an interactive
session on the protocol pipe and wedge it **[source, not tested]**.

---

## Prior art

### Rails `web-console` (in-process; ruled out by the map, but its protocol is instructive)

[rails/web-console @ 90e3474](https://github.com/rails/web-console/tree/90e3474306f2367cfeaf2875e91e2bc2d71b5f0f)

- **Protocol:** `PUT /__web_console/repl_sessions/:id` with `input=<line>` returns
  `{ output: "<text>" }`. With `context=<expr>` it returns a completion list
  ([`middleware.rb` `update_repl_session`](https://github.com/rails/web-console/blob/90e3474306f2367cfeaf2875e91e2bc2d71b5f0f/lib/web_console/middleware.rb#L101-L109)).
- **Results are text:** `Evaluator#eval` returns `"=> #{value.inspect}\n"`, or the exception
  formatted as `"Class: message\n\tfrom …"`, both as one string
  ([`evaluator.rb`](https://github.com/rails/web-console/blob/90e3474306f2367cfeaf2875e91e2bc2d71b5f0f/lib/web_console/evaluator.rb)).
  It does not capture `$stdout`: a `puts` goes to the server's output, not the console.
- **Completion by reflection:** `Context#extract` evaluates `instance_variables`,
  `local_variables`, `methods`, `Object.constants`, or `"#{input}.methods"` /
  `"#{input}.constants"`, in the binding
  ([`context.rb`](https://github.com/rails/web-console/blob/90e3474306f2367cfeaf2875e91e2bc2d71b5f0f/lib/web_console/context.rb)).
  Public Ruby only, no IRB internals.
- **Single-line input:** Enter sends the current line
  ([`console.js.erb` `onEnterKey` / `commandHandle`](https://github.com/rails/web-console/blob/90e3474306f2367cfeaf2875e91e2bc2d71b5f0f/lib/web_console/templates/console.js.erb)).
  There is no incomplete-expression detection.

It is the closest precedent for approach C's *shape* (request, then text or JSON back), and
it shows the minimal version is useful. It is also the cautionary example of what C loses
without effort: printed output and multi-line input.

### Emacs `inf-ruby` (IRB driven as a subprocess)

[nonsequitur/inf-ruby @ 274398a, v2.9.0](https://github.com/nonsequitur/inf-ruby/blob/274398a24288a7db430a656b580ffbf889ca02aa/inf-ruby.el)

- **Launch:** `bin/rails console -e <env> -- --nomultiline --noreadline` (`inf-ruby-console-rails`),
  and `irb --prompt default --noreadline -r irb/completion` for plain Ruby. It sets
  `PAGER=cat` and `RUBY_DEBUG_NO_RELINE=true` in the child's environment (`inf-ruby`,
  around L446–451).
- **Transport:** comint's `make-comint-in-buffer`, which uses a **PTY** because
  `process-connection-type` is non-nil by default (`Vprocess_connection_type = Qt` in
  [Emacs `src/process.c`](https://github.com/emacs-mirror/emacs/blob/master/src/process.c);
  [Elisp manual](https://www.gnu.org/software/emacs/manual/html_node/elisp/Asynchronous-Processes.html)).
  So inf-ruby is **"PTY for signals and prompts, line editor switched off"**, the hybrid
  between A and B.
- **End of evaluation:** detected by matching prompts with a regexp that covers IRB, Pry and
  RVM prompt shapes (`inf-ruby-prompt-pattern`, L180–186).
- **Completion:** sends a hidden snippet that calls `IRB::InputCompletor::CompletionProc`
  (or Pry's completer) and `puts` the candidates. A temporary process filter collects the
  output up to the next prompt (L940–990). In irb 1.18, `IRB::InputCompletor` is a
  **deprecated constant**
  ([`completion.rb` L506–520](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/completion.rb#L506-L520)).
  This shows how brittle scraping completion from a live IRB is.

---

## What the decision still has to weigh (for the grilling ticket)

- **What is the REPL, to the user: a terminal or a panel?** If it is a terminal (xterm.js,
  full IRB fidelity), A is the obvious fit and the "REPL results in the value viewer" fog
  closes as "no". If it is a panel with the Reader's own editor, highlighting and value
  viewer, C is the fit and B is a cheaper, weaker C.
- **How much of IRB is the user owed?** `.irbrc`, IRB commands, `binding.irb` and `debug`
  are all free under A, partly kept under B, and gone under C.
- **Coupling budget.** A couples to Bun's PTY (≥ 1.3.5) and Reline's escape protocol, but
  only the browser terminal interprets it. B couples to IRB's non-TTY output quirks. C
  couples to IRB internals (`RubyLex`, `RegexpCompletor`) if it reuses them, or to nothing
  if it uses Prism and reflection. That matters across the Rails 7.1+ range, whose IRB
  versions vary widely.
- **Launch route for C.** `bin/rails console -- -r` gets a `console` Run, `--sandbox` and
  the console hooks for free, with no Initializer change. `bin/rails runner` is simpler to
  explain but reports `unknown` unless the Initializer learns a new signal.
- **Tying an evaluation to its events** (the "an evaluation's own events" fog). Only C runs
  Reader-owned code around each evaluation inside the Host process. So only C *could* mark
  "evaluation 14 starts and ends here" in the Sidecar, whether through its own events or an
  executor wrap the Initializer recognises. A and B leave evaluations' SQL unattributed in
  the console's Run row.
- **macOS** has not been exercised at all. The PTY path is the one most likely to differ
  (termios defaults, `openpty`). Pipes and signals are the least likely.

**Leaning (not a decision):** the evidence favours **C launched through
`bin/rails console -- -r`** if the REPL is meant to feed the value viewer and have
Reader-owned input. It is the only option whose output is results rather than a screen,
and the launch trick keeps the `console` Run and `--sandbox` without touching the
Initializer. **A** is the honest alternative if "it's just my `rails c`, in the browser" is
the goal, and it is the least code on the Ruby side. B looks like the worst of both: it
gives up the line editor without gaining structured output.

---

## Reproducing the experiments

From the repo root, after `example-app/bin/setup` and `touch example-app/log/rails_log_reader.enabled`:

```sh
# B, raw
bun docs/research/driving-a-rails-console-from-bun/irb-over-pipes.ts
# B, framed (absolute -r paths)
bun docs/research/driving-a-rails-console-from-bun/irb-over-pipes.ts --nomultiline --nosingleline --nocolorize --verbose --prompt READER \
  -r "$PWD/docs/research/driving-a-rails-console-from-bun/irb-sentinel-prompt.rb"
#   …add  --inspect reader_json -r "$PWD/docs/research/driving-a-rails-console-from-bun/irb-json-inspector.rb"  for JSON results
# A
bun docs/research/driving-a-rails-console-from-bun/irb-over-pty.ts               # Reline's 0.5 s DSR stalls visible
bun docs/research/driving-a-rails-console-from-bun/irb-over-pty.ts --answer-dsr  # stalls gone
# C
bun docs/research/driving-a-rails-console-from-bun/custom-loop.ts runner    # run_header kind: unknown
bun docs/research/driving-a-rails-console-from-bun/custom-loop.ts console   # run_header kind: console
```

Check the Run kind with `grep -o '"kind":"[a-z]*"' example-app/log/rails_log_reader.jsonl`.

## Sources

- ruby/irb v1.18.0: [`lib/irb.rb`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb.rb),
  [`lib/irb/init.rb`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/init.rb),
  [`lib/irb/context.rb`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/context.rb),
  [`lib/irb/input-method.rb`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/input-method.rb),
  [`lib/irb/ruby-lex.rb`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/ruby-lex.rb),
  [`lib/irb/completion.rb`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/completion.rb),
  [`lib/irb/inspector.rb`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/inspector.rb),
  [`lib/irb/pager.rb`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/pager.rb),
  [`lib/irb/color.rb`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/color.rb),
  [`lib/irb/lc/help-message`](https://github.com/ruby/irb/blob/v1.18.0/lib/irb/lc/help-message)
- ruby/reline v0.7.0: [`lib/reline/io.rb`](https://github.com/ruby/reline/blob/v0.7.0/lib/reline/io.rb),
  [`lib/reline/io/ansi.rb`](https://github.com/ruby/reline/blob/v0.7.0/lib/reline/io/ansi.rb)
- rails/rails v8.1.3.1: [`railties/lib/rails/commands/console/console_command.rb`](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/console/console_command.rb),
  [`irb_console.rb`](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/console/irb_console.rb),
  [`runner_command.rb`](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/runner/runner_command.rb),
  [`activerecord/lib/active_record/railtie.rb`](https://github.com/rails/rails/blob/v8.1.3.1/activerecord/lib/active_record/railtie.rb),
  [`activerecord/lib/active_record/query_cache.rb`](https://github.com/rails/rails/blob/v8.1.3.1/activerecord/lib/active_record/query_cache.rb);
  rails/rails v7.1.5 [`console_command.rb`](https://github.com/rails/rails/blob/v7.1.5/railties/lib/rails/commands/console/console_command.rb)
- Bun: [v1.3.5 release notes](https://bun.com/blog/bun-v1.3.5),
  [Child processes docs](https://bun.com/docs/runtime/child-process), `bun-types` 1.4.1 `bun.d.ts`
  (`SpawnOptions.terminal`, `stdio`, `Bun.Terminal`)
- [rails/web-console @ 90e3474](https://github.com/rails/web-console/tree/90e3474306f2367cfeaf2875e91e2bc2d71b5f0f)
- [nonsequitur/inf-ruby @ 274398a](https://github.com/nonsequitur/inf-ruby/blob/274398a24288a7db430a656b580ffbf889ca02aa/inf-ruby.el);
  [Emacs `process.c`](https://github.com/emacs-mirror/emacs/blob/master/src/process.c) and the
  [Elisp manual on asynchronous processes](https://www.gnu.org/software/emacs/manual/html_node/elisp/Asynchronous-Processes.html)
- [puma-dev README @ db9ec15](https://github.com/puma/puma-dev/blob/db9ec15c986ec978c2534d628e8694a8e5efc250/README.md)
- This repo: [`reader/rails/rails_log_reader.rb`](../../reader/rails/rails_log_reader.rb) (`run_kind`),
  [`CONTEXT.md`](../../CONTEXT.md), [ADR-0003](../adr/0003-a-sidecar-jsonl-file-is-the-transport.md)
