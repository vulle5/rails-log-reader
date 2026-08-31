# Context

A web-based reader for Ruby on Rails development logs. Two projects, one repo: the
reader tool, and an example Rails app tailored for testing it.

## Glossary

**Reader** — the tool being built. A local Bun process that serves a React + TypeScript
SPA and streams Rails log events to it. Never deployed; never remote. See
`docs/adr/0001-bun-is-the-runtime.md`.

**Example app** — a Rails 8 app living in this repo purely to exercise the Reader. Not
the product: its purpose is to *emit* Events, not to be used. It is a test fixture in the
plain sense of the word, but never call it "the fixture" — Rails already owns that word
for `test/fixtures/*.yml`, and the Example app has seed data of its own.
_Avoid_: fixture (as a name), demo app, sample app.

**Initializer** — the Rails half of the product: one Ruby file the developer copies into
their Work app's `config/initializers/`, where Rails runs it once at boot. It hooks Rails
and forwards Events to the Reader. Distributed by copy-paste, not as a gem.
_Avoid_: plugin, agent, shim.

**Work app** — the user's real Rails 8 application at their job. The Reader must work
against it with only the Initializer added, opt-in per developer.

**Event** — a single thing the Rails process emitted. Three kinds in v1:
- **Request event** — an HTTP request. Has a start and a finish; is *in-flight* between them.
- **SQL event** — one database query, attributed to a request.
- **App log event** — a bare `Rails.logger.*` call from application code.

**Scenario** — a named, reproducible traffic pattern the Example app generates on demand:
parallel in-flight requests, an N+1-shaped request, a slow query, a request that hangs, a
rake-task query burst. Triggered from the Example app's own `/scenarios` page or by `curl`
against the same endpoint. A Scenario is a *shape of traffic*, never a feature of the
Reader — the Reader detects nothing and is never told which Scenario is running.
_Avoid_: test, demo, case.

**Attribution** — binding an SQL or App log event to the Request event it occurred
within, via `request_id`. The core problem: with parallel requests, an unattributed log
is unreadable.

**Unattributed** — an event with no owning request (boot lines, background jobs, rake
tasks). Not dropped; shown in the Console.

**Run** — one boot-to-shutdown lifetime of the Rails process. Every Event belongs to
exactly one Run. In development a Run is short: any restart of `rails s` ends one and
begins the next. Ordering keys and elapsed times are only comparable *within* a Run, so
the Reader treats a Run boundary as a visible event, not a seam to hide.

**Ordering key** — what puts every Event of a Run into one true order, including across
kinds: a sequence number taken at the moment the Rails process *observes* the Event, not
when the Event completes. Because observation happens inline on the request thread, this
reproduces causal order by construction. See *dual-homing* for why a `request_id` alone
cannot do this.

**Partial request** — a Request event the Reader pieced together without having observed
its start, because the Reader attached mid-flight or started after the request did. It is
promoted as its finish arrives, gaining method, path, status and duration — but it stays
Partial for its whole life, because the events emitted before the Reader attached are lost
and their number is unknowable. Distinct from *unattributed*: a Partial request's children
are correctly correlated; it is the parent that was missed.
_Avoid_: orphan, stub, inferred.

**Interrupted request** — a Request event whose Run ended before it finished: the process
was reaped, restarted or killed while the request was still in flight. Concluded from
evidence — a `run_end`, or a `run_header` bearing a new `run_id` — never from a timer, since
in-flight requests are given no timeout, ever. The mirror of a *Partial request*: that one
missed a start, this one will never get a finish.
_Avoid_: dropped (a *dropped event* is a volume concern and unrelated), abandoned, cut off.

**Dual-homing** — an App log event appears in *two* places at once: inline within its
request's timeline, interleaved in emission order with that request's SQL events, and
in the global Console stream. This is why every event needs an **ordering key**, not
just a parent id: a `request_id` alone cannot interleave logs with queries.

**Console** — a global, dev-tools-style stream of every App log event, attributed or
not, in emission order.

**In-flight** — a Request event that has started but not finished. Must be visible and
must accumulate its SQL and App log events live. A request that hangs is the single
most valuable thing to see.

**Sidecar** — `log/rails_log_reader.jsonl`, the append-only file the Initializer writes one
Event per line to and the Reader tails. The transport between the two halves, and the only
file the product creates. Rails' generated `.gitignore` already covers it. Never confused
with `log/development.log`, which the Reader only ever leaves alone. See
`docs/adr/0003-a-sidecar-jsonl-file-is-the-transport.md`.

**Trailing event** — an SQL or App log event whose `seq` places it *after* its request's
`request_finish`. Attribution is not in doubt — the `request_id` is right there — only the
position is. The Reader appends it to a visibly separate **trailing section** at the end of
the request row, never silently inside the timeline, because a log line arriving after its
request finished is genuinely surprising and hiding it would read as a Reader bug. There is
no time limit and no buffering: the row accepts trailing events for as long as the Reader
still holds it, and once the row is evicted under the memory bound the event is simply
*unattributed*. Positional, never temporal — "late" would imply a clock, and `at_wall` is
never sorted on. Structurally rare: the request boundary is the Initializer's own middleware,
so almost nothing can outlive it. See
`docs/adr/0002-the-event-envelope-and-ordering-key.md`.
_Avoid_: late arrival, straggler, orphan.

## Standing constraints

1. **`log/development.log` stays pristine.** A collaborator running `tail -f` must see
   exactly what they see today. This is the defining failure of `log_bench`, which
   replaces the Rails logger with a JSON formatter and makes the file unreadable.
2. **Opt-in per developer.** Inert unless explicitly enabled. A teammate who never uses
   the Reader notices nothing.
3. **Strictly local.** No remote, staging, or production log reading.
4. **Rails 8+** is the target. Rails 7 support is welcome, not required.
5. **Dark and light mode** both required.
