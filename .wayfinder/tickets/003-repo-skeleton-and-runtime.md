---
id: 003
title: Settle the repo skeleton and the one-command runtime
type: grilling
status: open
parent: map
assignee:
blocked_by: []
---

## Question

Pin down the shape of the repo and how the Reader boots, so later tickets have somewhere
to land code.

Decide:

- **Layout.** Confirmed direction is a single `reader/` package (HTTP server + React SPA
  together) and a sibling `example-app/` (Rails), with no workspace tooling until a
  second JS package exists. Settle the actual directory tree, and where the copy-paste
  initializer lives so it can be both documented and used by `example-app/`.
- **Runtime compatibility.** Node is the baseline; Bun and Deno should also work. Decide
  what that means concretely — which APIs are off-limits (Node-specific file watching,
  `node:` builtins), and whether compatibility is verified by CI or by hand.
- **The one command.** What the user types. `npx rails-log-reader`, a script in the repo,
  or both. How the tool learns where the log source is — CLI argument, config file,
  convention, or auto-detection of a Rails root.
- **Build and dev tooling.** How the SPA is built and served in production mode, and
  what the inner-loop dev experience is when working on the Reader itself.
- **Serving.** How the SPA and the event stream coexist on one port; whether the browser
  is opened automatically.

Deliberately not decided here: the transport carrying events from Rails into the Reader
— that is the ingestion decision ticket. Keep this ticket's answers transport-agnostic.
