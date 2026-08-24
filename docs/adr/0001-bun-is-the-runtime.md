# Bun is the Reader's runtime

The map originally set Node as the baseline runtime, with Bun and Deno expected to work
too. Settling the repo skeleton ([#4](https://github.com/vulle5/rails-log-reader/issues/4))
overturned that: Bun's fullstack dev server bundles TypeScript, JSX and CSS and provides
hot module replacement and React Fast Refresh with no build tooling at all, which deletes
Vite, its plugins, a second dev server, a proxy, a `dist/` folder and the staleness check
that would have guarded it. Bun also runs TypeScript directly and ships a test runner, so
the Reader needs no build step in either development or production. **The Reader is a Bun
program.** Users install Bun; that is the cost.

## Considered options

- **Bun everywhere** (chosen). One runtime, one code path for development and production.
- **Bun builds it, any runtime runs it.** Keeps the tri-runtime promise by writing the
  server as a web-standard `(Request) => Response` handler and serving pre-built static
  assets. Rejected because it forks the code path: development would use Bun's
  bundler-server and production would serve built files, so the development path would
  only ever be exercised on Bun anyway — paying for a split that buys nothing.
- **Node baseline with Vite.** The original plan. Rejected as strictly more moving parts
  for a tool that is only ever run locally by developers.

## Consequences

- `CONTEXT.md`'s definition of Reader no longer says "Node/Bun/Deno".
- No formatter and no linter are configured: Bun has neither built in, and adding one was
  judged not worth a dependency at this size. CI runs `tsc --noEmit` and `bun test`.
- The eventual published command is `bunx rails-log-reader`, not `npx`.
- Because `Bun.serve` handlers take a `Request` and return a `Response`, the server code
  stays portable in shape even though it is not portable in practice — reversing this
  decision means replacing the dev server and the asset serving, not the request handling.
