# A marker file gates the Initializer

The Initializer is inert unless `log/rails_log_reader.enabled` exists. Presence is the
whole gate: the file's content is never read. The gate is evaluated once, at boot, and
only in the `development` environment on Rails 7.1 or newer. Settled in
[#10](https://github.com/vulle5/rails-log-reader/issues/10).

This **overturns** ADR-0003's "opt-in by one env var", which
[#6](https://github.com/vulle5/rails-log-reader/issues/6) settled without naming the
variable and — more importantly — before the deciding constraint was on the table: the
Host app runs under **puma-dev**, not `rails s`.

## Why not an environment variable

There is no shell to export from. puma-dev starts the process itself, so the variable has
to arrive through puma-dev's own chain (`~/.powconfig`, `.env`, `.powrc`, `.powenv`,
`.pumaenv`) or `dotenv-rails`. Two costs follow:

- **It is not one step for the target user.** The developer must learn which file in that
  chain their setup actually reads, and half of those files live inside the repo, where
  standing constraint 2 (opt-in *per developer*) forbids committing them.
- **It misses the non-server Runs.** An environment variable is per terminal. A *Run* is
  any boot-to-shutdown lifetime of a Rails process, and the Reader exists to correlate
  `rake` and `rails c` alongside the server — the rake-task burst *Scenario*
  ([#7](https://github.com/vulle5/rails-log-reader/issues/7)) depends on it. The developer
  would have to export the variable again in every terminal.

A file in the app root has neither problem: `touch log/rails_log_reader.enabled` needs no
knowledge of puma-dev, and every Run started in that directory sees it.

## Considered options

- **A git-ignored marker file** (chosen). Rails' generated `.gitignore` already carries
  `/log/*` — the same fact ADR-0003 leaned on for the *Sidecar* — so the marker is
  un-committable by construction, per-checkout and per-developer.
- **An environment variable.** Rejected above.
- **The Initializer file's own presence is the switch.** No gate code at all: copy it in to
  turn on, delete it to turn off. Genuinely simpler, and rejected on its failure mode.
  `config/initializers/` is a committed directory, so the developer must keep the file
  untracked (`.git/info/exclude`) or a stray `git add .` enables the Reader for the whole
  team, breaking constraint 2. Under the marker file the same stray commit is **safe**: the
  Initializer ships to everyone and stays inert, because no teammate has a marker.
- **A config file.** Never on the table, but worth naming: a marker whose *content* mattered
  would be one, and [#4](https://github.com/vulle5/rails-log-reader/issues/4) settled that
  the Reader has no config file and auto-detects instead.

## The contract

- **The developer creates the marker; the Reader never writes into the Host app.**
  [#7](https://github.com/vulle5/rails-log-reader/issues/7) put the *Scenario* launcher in
  the Example app precisely so the Reader stays a read-only tail of a file. Creating the
  marker on `bun start` buys nothing — the Reader still cannot restart Rails, so the
  developer must act regardless — and removing it on exit is worse: a crashed Reader leaves
  the app opted in, and a clean exit silently opts it out mid-`rake`.
- **Both paths are fixed contract**, `config/initializers/rails_log_reader.rb` and
  `log/rails_log_reader.enabled`, which is what lets the Reader distinguish *not installed*
  from *not enabled* from *enabled but idle* using only reads.
- **Read once, at boot.** Not a matter of taste: a mid-Run toggle would require the
  middleware and the *BroadcastLogger* sink to be installed at all times, which is exactly
  what the inertness promises below forbid. Enabling therefore requires a restart
  (`touch tmp/restart.txt` under puma-dev).
- **`development` only.** ADR-0003 already refused production unconditionally; `staging` is
  refused too, because a deployed staging box is the remote log reading this map ruled out
  of scope. `test` is refused for now — see Consequences.
- **Rails `>= 7.1`, refused below.** `BroadcastLogger#broadcast_to` is simultaneously the
  only capture mechanism that leaves `development.log` pristine and the one thing Rails 7.0
  lacks ([#2](https://github.com/vulle5/rails-log-reader/issues/2)). Its 7.0 substitute,
  `ActiveSupport::Logger.broadcast`, is `:nodoc:`, deprecated, removed by 8.1 and
  **un-detachable** — so it contradicts standing constraints 1 *and* 2 rather than costing a
  port. Tested on 8.x; 7.1 and 7.2 are accepted with their absent `sql.active_record` fields
  (`:transaction`, `:row_count`) treated as absent rather than as an error.

## What "inert" promises

Standing constraint 2 — "a teammate who never enables the Reader notices nothing" — is not
testable as written. When the marker is absent, four statements are **promises**, which the
Example app keeps testing:

1. No middleware is inserted into the stack. Stronger than it used to be:
   [#14](https://github.com/vulle5/rails-log-reader/issues/14) moved `request_start` onto the
   Initializer's own middleware, which is a far more visible stack change than a subscriber.
2. No notification subscribers are registered.
3. No sink is attached to the `BroadcastLogger`.
4. No file is opened, so a disabled checkout has no *Sidecar* at all.

**Proof is structural, not audited:** the entire Initializer body sits below a single
`return unless enabled?` at the top of the file. One test in the Example app boots with the
marker absent and asserts the middleware stack, our subscriber list and the sink count match
a baseline, and that no Sidecar exists.

Two statements are deliberately **not** promises:

- **"No measurable request overhead."** True, but only as a consequence of 1–4, and as a test
  it is a benchmark that fails on a loaded CI box for reasons unrelated to the product.
- **"`log/development.log` is byte-identical."** The constraint that matters most, and it
  cannot break while disabled, because nothing of ours is loaded. It is tested in the
  **enabled** state, where it can actually break.

## Boot refusals warn once

The gate can be open and the Initializer still decline: Rails is 7.0, `log/` is unwritable,
or the Sidecar is past ADR-0003's 64 MB cap. Those emit **one `Rails.logger.warn` line**,
naming the reason — for the version refusal, naming `broadcast_to` rather than complaining
generically about a version.

This knowingly adds a line to `development.log`, and constraint 1 still holds: the line
cannot exist without a marker file that only the opting-in developer created. The
constraint protects the collaborator who never opted in.

Rejected alternatives: `$stderr` lands in puma-dev's own log, which the developer may never
open; writing a refusal Event into the Sidecar fails in the case that matters most, since an
unwritable `log/` cannot report that `log/` is unwritable; and raising is out of the question
— a log reader must never stop the Host app from booting. Mid-Run write failures are
unchanged from ADR-0003: rescue and disable silently.

## Consequences

- ADR-0003's "opt-in by one env var" is superseded. No environment variable is defined, and
  none is added as a second gate — two gates mean two truth tables and a precedence rule.
- Standing constraint 4 in `CONTEXT.md` is rewritten: "Rails 7 support is welcome, not
  required" is not something a user can read. The range is now stated.
- The Reader gains an empty state with three distinguishable causes (not installed, not
  enabled, idle). _Settled by [#28](https://github.com/vulle5/rails-log-reader/issues/28):
  each names the one command that resolves it, and the Marker file is only ever checked for
  presence — see *Empty state* in `CONTEXT.md`._
- **`test`-environment logging is out of scope, deferred rather than rejected.** It is
  wanted at work, and it is not one line of `if Rails.env`: parallel test workers,
  transactional rollback and thousands of sub-millisecond requests all press on what a *Run*
  is and what the *request table* is for. Nothing here makes it harder later — the gate is
  one environment check at boot.
