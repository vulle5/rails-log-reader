---
id: 008
title: Decide search, syntax highlighting, and theming
type: grilling
status: open
parent: map
assignee:
blocked_by: [002]
---

## Question

The user rated structured filters as unimportant for v1 but named search, SQL syntax
highlighting, log colouring, and both themes as things that matter.

Decide:

- **Search.** The user's own question was whether the browser's `Ctrl+F` is enough.
  Decide it — and note that `Ctrl+F` only ever finds what is currently rendered, which
  collides directly with collapsed requests, virtualised lists, and auto-scrolling
  content. If a built-in search is needed, decide its scope (request paths only? SQL
  text? Console lines? all events including collapsed ones?), whether it filters the list
  or highlights in place, and how it interacts with auto-scroll.
- **SQL syntax highlighting.** Which approach, and how much weight it adds to the bundle.
  Whether queries are pretty-printed/reformatted or shown exactly as Rails emitted them.
- **Log colouring.** Rails writes ANSI colour codes to `development.log`. Decide whether
  the Reader interprets those, strips them, or ignores the question entirely because the
  chosen ingestion path never carries them — this depends on which architecture won in
  ticket 005, so check before assuming.
- **Theming.** Dark and light are both required. Decide whether the toggle is manual,
  follows the OS, or both, and whether the choice persists.

Deliberately out of scope: structured filtering by method, status, or controller, which
this map rules out of v1 entirely.
