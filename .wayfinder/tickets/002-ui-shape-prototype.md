---
id: 002
title: Prototype the request / SQL / Console layout
type: prototype
status: open
parent: map
assignee:
blocked_by: []
---

## Question

What does this thing actually look like? The user called out that the UI needs
prototyping, and every downstream display decision is easier to make against something
concrete than in the abstract.

Build a cheap, rough, clickable React + TypeScript prototype driven by **hardcoded
fixture data** — no server, no Rails, no real log parsing. Use `/prototype`.

It must let the user react to:

- A live-updating list of requests ordered by **start** time, with in-flight requests
  visibly distinct from completed ones (see *in-flight* in `CONTEXT.md`).
- Expanding a request to reveal its timeline: SQL events and App log events interleaved
  in emission order, not segregated into separate sections.
- The **Console** pane — the global stream of every `Rails.logger` call, attributed or
  not. Open question the prototype should pose: is this a split pane, a tab, a
  bottom drawer? How does the user get from a Console line to the request it belongs to?
- The parallel-request case that motivates the whole project: four requests in flight at
  once, their queries arriving interleaved. This is the scenario the design must survive.
- Dark and light mode, both.

Fixture data should include at least one hanging request, one request with ~30 queries,
and one request with `Rails.logger` calls sandwiched between queries.

Resolve by linking the prototype and recording which layout the user chose and why.
Deliberately out of scope here: search UI and syntax highlighting, which have their own
ticket.
