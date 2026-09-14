# The app-name override is a Reader-side env var, not a Host-app one

`RAILS_LOG_READER_APP_NAME`, read once by the Bun server at its own startup, overrides
whatever the wire's `app_name` says — unconditionally, for the life of that process. Settled
in [#95](https://github.com/vulle5/rails-log-reader/issues/95).

## Why not a Host-app env var

The obvious mirror of the wire's own `app_name` is an env var the Initializer reads and
forwards over the Sidecar, the same shape `rails_version` and `pid` already travel in. It is
rejected for the exact reason ADR-0004 rejected one for the Marker file: the Host app runs
under **puma-dev**, not `rails s`, so there is no shell to export from. The developer would
have to learn which file in puma-dev's own chain (`~/.powconfig`, `.env`, `.powrc`,
`.powenv`, `.pumaenv`) or `dotenv-rails` their setup actually reads — for a value that only
ever renames a tool's own label for their app, which is a strange price to pay twice over
for something the wire already sends unasked.

## Why a Reader-side one is different

The Reader itself is not started by puma-dev. `bun start` (or `bun --hot`, for development)
is a command the developer types themselves, from their own shell — the same shell
`RAILS_LOG_READER_PORT` already reads a variable from, with the identical pattern this
reuses: read once, at that process's own startup, namespaced so it is never mistaken for a
variable meant for something else. There is no non-server Run to miss, either: unlike the
Marker file, which every `rake` and `rails c` process has to see independently, the override
belongs to one process — the Reader — that has exactly one boot to read it at, and the wire
carries no `run_header` of its own for that process to have missed.

## Considered options

- **A Bun-process env var** (chosen). `readAppNameOverride` mirrors `readPort`: read once, at
  startup, from `process.env`, with no shell-under-puma-dev problem to solve.
- **A Host-app env var, forwarded over the wire.** Rejected above.
- **A Reader config file.** Never on the table, for the reason ADR-0004 already named: the
  Reader auto-detects and carries no config file of its own.

## The contract

- **Read once, at the Reader's own startup**, exactly as `RAILS_LOG_READER_PORT` is — never
  re-read, and never reachable through any request the browser makes beyond the one fetch
  that learns it.
- **Unconditional precedence.** Set, it wins over every `run_header`'s `app_name` for the
  life of the process. There is no "unless the wire disagrees" case, because unlike the
  Marker file's presence there is nothing on the Host-app side to reconcile it against — the
  override and the wire are simply two different answers to the same question, and the
  override is the one the developer meant.
- **No invalid value.** Any non-empty string names an app, so unlike the port there is
  nothing to refuse — only set-vs-unset, and an empty or whitespace-only setting reads as
  unset.

## Consequences

- The override reaches the browser through a new `GET /app-name-override`, fetched once on
  mount the way `/initializer-status` already is, rather than server-side HTML templating —
  Bun's static HTML-bundle route for `/*` stays untouched.
- A developer running two Readers against two Host apps at once — the same case
  `RAILS_LOG_READER_PORT` exists for — now has a second variable to set alongside the first,
  for the case the wire's own name does not tell the two tabs apart (two apps sharing one
  name, or a Host app whose Initializer predates `app_name` being on the wire).
