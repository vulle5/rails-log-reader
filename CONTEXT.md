# Context

A web-based reader for Ruby on Rails development logs. Two projects, one repo: the
reader tool, and an example Rails app tailored for testing it.

## Glossary

**Reader** — the tool being built. A local Bun process that serves a React + TypeScript
SPA and streams Rails log events to it. Never deployed; never remote. See
`docs/adr/0001-bun-is-the-runtime.md`.

**Example app** — a Rails 8 app living in this repo purely to exercise the Reader. Not
the product; a test fixture that happens to be a Rails app.

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

**Attribution** — binding an SQL or App log event to the Request event it occurred
within, via `request_id`. The core problem: with parallel requests, an unattributed log
is unreadable.

**Unattributed** — an event with no owning request (boot lines, background jobs, rake
tasks). Not dropped; shown in the Console.

**Dual-homing** — an App log event appears in *two* places at once: inline within its
request's timeline, interleaved in emission order with that request's SQL events, and
in the global Console stream. This is why every event needs an **ordering key**, not
just a parent id: a `request_id` alone cannot interleave logs with queries.

**Console** — a global, dev-tools-style stream of every App log event, attributed or
not, in emission order.

**In-flight** — a Request event that has started but not finished. Must be visible and
must accumulate its SQL and App log events live. A request that hangs is the single
most valuable thing to see.

## Standing constraints

1. **`log/development.log` stays pristine.** A collaborator running `tail -f` must see
   exactly what they see today. This is the defining failure of `log_bench`, which
   replaces the Rails logger with a JSON formatter and makes the file unreadable.
2. **Opt-in per developer.** Inert unless explicitly enabled. A teammate who never uses
   the Reader notices nothing.
3. **Strictly local.** No remote, staging, or production log reading.
4. **Rails 8+** is the target. Rails 7 support is welcome, not required.
5. **Dark and light mode** both required.
