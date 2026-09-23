#!/usr/bin/env bun

/**
 * Starts the Reader, from wherever it is run: inside the Host app, which is where the server
 * looks for its Rails root.
 *
 * Bun reads `bunfig.toml` from the working directory, and that is never the Reader's own, so
 * the server is run with `--config` pointing at it. Without that, the Tailwind plugin
 * registered there never loads and the Reader serves its stylesheet uncompiled, with no
 * error.
 *
 * Every argument is a Bun runtime flag, placed before the server's entry — `bun dev` passes
 * `--hot`.
 */

const bunfig = Bun.fileURLToPath(new URL("../bunfig.toml", import.meta.url))
const server = Bun.fileURLToPath(new URL("../src/server/index.ts", import.meta.url))

const reader = Bun.spawn([process.execPath, `--config=${bunfig}`, ...process.argv.slice(2), server], {
  stdio: ["inherit", "inherit", "inherit"],
})

// Handed on and waited for, so that stopping this process stops the Reader too rather than
// leaving it running with nothing in front of it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => reader.kill(signal))
}

process.exit(await reader.exited)
