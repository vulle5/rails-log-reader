#!/usr/bin/env bun

/**
 * Starts the Reader with the Reader's own `bunfig.toml`, from any working directory — the
 * Host app's, which is where the server looks for its Rails root. Bun reads the working
 * directory's `bunfig.toml` unless `--config` says otherwise, and a server started without it
 * serves its stylesheet uncompiled, with no error.
 *
 * The server runs in the Reader's own directory and is handed the one it was started from.
 * Bun's development server follows a source outside its working directory by the file alone,
 * so a save that writes a new file and renames it over the old one, as editors and agents
 * save, would drop that source from hot reload until a restart.
 *
 * Every argument is a Bun runtime flag, placed before the server's entry — `bun dev` passes
 * `--hot`.
 */

const bunfig = Bun.fileURLToPath(new URL("../bunfig.toml", import.meta.url))
const server = Bun.fileURLToPath(new URL("../src/server/index.ts", import.meta.url))
const own = Bun.fileURLToPath(new URL("..", import.meta.url))

const reader = Bun.spawn([process.execPath, `--config=${bunfig}`, ...process.argv.slice(2), server, process.cwd()], {
  cwd: own,
  stdio: ["inherit", "inherit", "inherit"],
})

// Handed on and waited for, so that stopping this process stops the Reader too rather than
// leaving it running with nothing in front of it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => reader.kill(signal))
}

process.exit(await reader.exited)
