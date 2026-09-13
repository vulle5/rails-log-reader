# Bun-only runtime

The Reader requires Bun installed; it does not run on Node, Deno, or any other
JavaScript runtime.

## Why this is out of scope

Settled by [ADR-0001](../docs/adr/0001-bun-is-the-runtime.md) when the repo skeleton was
built. The original map assumed a Node baseline with Bun and Deno expected to work too,
but that was overturned once it came time to actually settle the skeleton: Bun's
fullstack dev server bundles TypeScript, JSX and CSS and provides hot module replacement
and React Fast Refresh with no build tooling at all — deleting Vite, its plugins, a
second dev server, a proxy, a `dist/` folder, and the staleness check that would have
guarded it. Bun also runs TypeScript directly and ships a test runner, so the Reader
needs no build step in either development or production.

A tri-runtime-compatible design was explicitly considered and rejected: "Bun builds it,
any runtime runs it" would keep the promise by writing the server as a web-standard
`(Request) => Response` handler and serving pre-built static assets, but that forks the
code path — development would use Bun's bundler-server and production would serve
built files, so the development path would only ever be exercised on Bun anyway. That
pays for a split that buys nothing.

**The Reader is a Bun program.** Users install Bun; that is the accepted cost, since the
Reader is a local developer tool, never deployed and never remote.

Reversing this decision means replacing the dev server and the asset-serving layer, not
just the request-handling code (which stays portable in shape, per ADR-0001's
consequences) — this is a real ADR reversal, not a small config change.

## Prior requests

- #34 (bullet point), split out as #75 — "Make the Reader usable without Bun installed"
