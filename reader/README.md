# Reader

A Bun program: a server that tails the Sidecar and a React SPA that reads it. No build
step, no bundler config, no `dist/` — Bun serves `src/ui/index.html` directly.

```
src/server   the Bun server
src/ui       the SPA
src/shared   the wire contract both halves are built against
rails/       the Initializer: the Rails half, distributed by copy-paste
```

## Running it

```sh
bun dev     # http://localhost:5273, with hot reload
bun start
```

Both commands run the Reader against the Example app next door, because the Reader is
always started from inside a Rails root and auto-detects it — there is no config file and
no flag for the host or the path. To point it at another app, start it from inside that
app:

```sh
cd ~/work/my-app && bun ~/src/rails-log-reader/reader/src/server/index.ts
```

Started anywhere that is not a Rails root, it says so and exits.

The port is 5273 and there is nothing to configure, which is the point: one URL to
remember. Two Rails apps open at once want two Readers, though, and only one of them can
have 5273 — so `RAILS_LOG_READER_PORT` moves the second one, and `0` asks the OS for a
free port, which is what the tests here use. The Reader prints the URL it bound either
way. Start it on a port something else is holding and it says so and exits, rather than
throwing.

## Checks

```sh
bun test
bunx tsc --noEmit
```
