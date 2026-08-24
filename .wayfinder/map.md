---
labels: [wayfinder:map]
tracker: local-markdown
---

# Map: Web-based Rails log reader

## Destination

A working local MVP the user runs at work daily: one command boots a web UI that shows
each HTTP request with its SQL queries and `Rails.logger` calls nested underneath,
live and auto-scrolling, ordered by request start time with in-flight requests visible
— all without altering what a collaborator sees when they `tail -f log/development.log`.

Reached when the Reader runs against the in-repo example Rails app under parallel
request load and the user can point it at their real Rails 8 work app by copying in one
initializer file.

## Notes

**Domain:** Rails logging internals, local dev tooling, React + TypeScript UI.
See `CONTEXT.md` for the glossary — especially *dual-homing*, *attribution*, *in-flight*.

**Skills every session should consult:** `/grilling` and `/domain-modeling` for any
decision ticket; `/prototype` for UI tickets; `/research` for research tickets.

**Standing preferences for this effort:**
- Prior art is `log_bench` (silva96/log_bench) — a TUI that correlates via `request_id`
  but achieves it by replacing the Rails logger with a JSON formatter. We want its
  correlation and none of its collateral damage.
- Rails-side code ships as a **copy-paste initializer**, not a gem. Gem packaging is fog.
- The Reader is one package (`reader/`); the Rails fixture is a sibling (`example-app/`).
  No workspace tooling until a second JS package exists.
- Node is the baseline runtime; Bun and Deno should work too.
- Update `CONTEXT.md` whenever a ticket sharpens or adds a domain term.

## Decisions so far

<!-- one line per closed ticket; the detail lives in the ticket -->

_None yet — the map was charted 2026-08-24._

## Not yet specified

- **History and retention.** How much of the past the Reader shows on open, how long it
  holds events, and what bounds memory. The user rated history a nice-to-have, not a
  requirement ("many dev tools don't work unless you open them"). Sharpens once
  [Decide how the Reader receives correlated Rails log events](tickets/005-ingestion-architecture-decision.md)
  lands, since a pure live transport and a file-backed one give very different answers.
- **Where the Reader holds state** — in-memory ring buffer vs. SQLite vs. re-reading the
  source. Downstream of the ingestion decision and of retention.
- **Behaviour under volume.** A busy Rails app emits thousands of SQL lines a minute;
  a mobile client hammering endpoints is the stated use case. Backpressure, dropped
  events, and UI virtualisation all live here.
- **Exception and backtrace rendering.** A 500 with a 40-line backtrace is a distinct
  display problem from a request row. Sharpens after the UI prototype.
- **Testing strategy for the Reader** — how to drive it from synthetic or recorded event
  streams without booting Rails.
- **Distribution beyond copy-paste** — publishing the Reader to npm for `npx`, and
  possibly a gem for the Rails half, once the initializer contract is stable.
- **Multiple simultaneous log sources** — pointing one Reader at two Rails apps at once.

## Out of scope

Ruled beyond this map's destination. These return only if the destination is redrawn.

- **Remote, staging, or production log reading.** Drags in auth, transport security, and
  production log volume; would distort every architecture decision beneath it. The stated
  pain is local dev with a mobile client hitting the user's own machine.
- **A REPL in the Console pane** (`rails c` inside the web UI). Genuinely appealing, but
  it requires a live connection *into* the Rails process rather than a read of its
  output — a different product with a different security model.
- **Background jobs as first-class groups.** ActiveJob/Sidekiq work would get its own
  grouping alongside requests. Real value, but a second grouping domain and not the
  stated pain. In v1 these lines surface as unattributed Console entries.
- **Advanced structured filtering** by method/status/controller, **N+1 detection**, and
  **allocation/duration performance insights**. All are `log_bench` features the user
  explicitly rated as not important for v1.
- **A terminal/TUI interface.** The whole premise is that the tool is web-based.
