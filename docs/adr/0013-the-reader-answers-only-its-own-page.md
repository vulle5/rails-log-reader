# The Reader answers only its own page

Once the REPL lands, the Reader can run Ruby in the Host app, so a request that reaches it
has to prove it came from the Reader's own page on this machine. The proof is a loopback bind,
a `Host` allowlist on every route, and an exact `Origin` match on every route that acts. There
is no secret token. Settled in [#143](https://github.com/vulle5/rails-log-reader/issues/143),
from the menu in [#140](https://github.com/vulle5/rails-log-reader/issues/140).

## The rules

- **Bind `127.0.0.1` explicitly.** With no `hostname`, `Bun.serve` binds the wildcard and
  every machine on the network can reach it. `"localhost"` is OS-dependent and `"::1"` cannot
  be reached from the Windows browser under WSL. The startup line still prints
  `http://localhost:<port>`, because that is what the README and bookmarks say.
- **A `Host` allowlist on every route**, the HTML included. The hostname must be `localhost`
  or `127.0.0.1`, on any port, so a remapped forward (`ssh -L`, a dev container on
  `localhost:5274`) still works. It may also be a name in `RAILS_LOG_READER_ALLOWED_HOSTS`.
  This is what stops DNS rebinding, and it guards the log's contents (SQL binds, params) as
  well as the REPL.
- **Views and acts.** A route either shows the log or acts on the machine. The REPL and
  Initializer repair act, and so does any future write. Views are served to any allowed host.
  Acts are served to **loopback hostnames only**, and only when `Origin` equals exactly
  `http://` + the request's own `Host`. A missing or `null` `Origin` is refused.
- **An exact `Origin`, not a same-site one.** `localhost:3000` is the same *site* as
  `localhost:5273`, so `Sec-Fetch-Site` cannot tell the Host app from the Reader. It is not
  used. On a GET, `Origin` must match when present. A same-origin `EventSource` or `fetch` GET
  sends none, so a missing one is allowed there.
- **No CORS, ever.** No route sends `Access-Control-Allow-Origin`. Eval requests must be
  `application/json`, which forces a preflight the Reader never approves.
- **Refusals are a bare `403`**, plus one line on the Reader's stdout naming the refused
  `Host` or `Origin`. That line is the only way a developer finds the name to add.
- **The transport checks itself.** Bun accepts a foreign `Origin` on an app-defined WebSocket
  upgrade. So whichever REPL transport is chosen, its opening request passes these checks in
  the Reader's own handler.

## `RAILS_LOG_READER_ALLOWED_HOSTS`

A Reader-side env var, read once at startup the way ADR-0009's override is. It holds
comma-separated hostnames without a port, since tunnels arrive on 443. A leading dot allows
subdomains, as Rails' `config.hosts` does. There is no allow-all value: Vite's
`allowedHosts: true` brings DNS rebinding straight back. Listed hosts are **view-only**. This
is how a third-party tunnel shows the log on another device, and why it never runs Ruby from a
URL on the internet. A page served on one says that acting needs `localhost:<port>`, and it
shows no buttons that would answer `403`.

## Considered options

- **A per-launch secret token** (Jupyter, VS Code). Refused. What it adds beyond the checks
  above is protection from local non-browser clients (other OS users, Windows-side processes
  under WSL) and from a bug in the checks. On a single-user dev laptop those are unlikely, and
  a process already running as the developer can run `bin/rails console` itself. The price is
  paid on every launch: a token in the URL breaks "just open `localhost:5273`" and bookmarks,
  and a cookie would leak it to the Host app, because cookies ignore the port. **Upgrade
  path**: a token for the acting routes only, printed in the startup URL and kept in
  `localStorage`, which is port-scoped, then sent as a header.
- **Opt-in hosts that may also act.** Refused. A tunnel's `Host` and `Origin` are the
  tunnel's own, and running Ruby from a URL reachable on the internet is not worth defending
  whatever the defence.
- **An exact-port `Host` allowlist.** Refused, because it breaks remapped forwards for no
  gain. The attacker's hostname is never loopback, so rebinding fails on the name alone. The
  Host app's page fails the `Origin`-equals-`Host` test on its port.
- **Built-in trust for `.test`.** Refused. `.test` resolves to loopback only while a local
  resolver like puma-dev owns it. A Host app on `.test` is unaffected, because these checks
  only look at the URL the Reader itself is opened on.

## Consequences

- `POST /initializer-repair` can be triggered cross-site until this is built. It is an act, so
  it becomes loopback-only, and it is unavailable through a tunnel.
- Every new route is classified once, as a view or an act.
