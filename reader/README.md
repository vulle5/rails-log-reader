# Reader

A Bun program: a server that tails the Sidecar and a React SPA that reads it. No build
step, no bundler config, no `dist/` — Bun serves `src/ui/index.html` directly.

```
src/server   the Bun server
src/ui       the SPA
src/shared   the wire contract both halves are built against
```

## Running it

```sh
bun dev     # http://localhost:5273, with hot reload
bun start
```

Both commands run the Reader against the Example app next door (which arrives with
[#17](https://github.com/vulle5/rails-log-reader/issues/17)), because the Reader is
always started from inside a Rails root and auto-detects it — there is no config file and
no flag for the host, the port or the path. To point it at another app, start it from
inside that app:

```sh
cd ~/work/my-app && bun ~/src/rails-log-reader/reader/src/server/index.ts
```

Started anywhere that is not a Rails root, it says so and exits.

## Checks

```sh
bun test
bunx tsc --noEmit
```
