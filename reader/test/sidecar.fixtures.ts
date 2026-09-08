import { mkdir, mkdtemp, rm, appendFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SIDECAR_NAME } from "../src/server/sidecar"
import type { AppLogPayload, Envelope, RequestFinishPayload, SqlPayload } from "../src/shared/wire"

/**
 * Seam 1's whole apparatus: a real `log/` directory with a real Sidecar in it, and an
 * emitter that stamps envelopes the way the Initializer does. No Rails process, no
 * browser, no clock — the Reader's ingestion is a file offset, so a temp file drives it.
 */

const temporary: string[] = []

/** Empty, because the Reader is routinely started before Rails has ever booted. */
export async function aLogDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sidecar-"))
  temporary.push(directory)
  await mkdir(join(directory, "log"), { recursive: true })
  return join(directory, "log")
}

/** What a checkout that has never booted Rails has instead of a `log/`: nothing. */
export async function aLogDirectoryThatDoesNotExistYet() {
  const directory = await mkdtemp(join(tmpdir(), "sidecar-"))
  temporary.push(directory)
  return join(directory, "log")
}

export async function forgetLogDirectories() {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
}

/** A line the Initializer would never write: the Sidecar is also written by hand in tests. */
export type Line = Envelope | string

function asLine(line: Line) {
  return typeof line === "string" ? line : JSON.stringify(line)
}

export async function appendToSidecar(logDirectory: string, ...lines: Line[]) {
  await appendFile(join(logDirectory, SIDECAR_NAME), lines.map((line) => `${asLine(line)}\n`).join(""))
}

/** What a boot-time truncation does to a Sidecar another Run is still appending to. */
export async function truncateSidecar(logDirectory: string, ...lines: Line[]) {
  await writeFile(join(logDirectory, SIDECAR_NAME), lines.map((line) => `${asLine(line)}\n`).join(""))
}

/** A Sidecar swapped for another file: same path, different inode, and bytes we have read before. */
export async function replaceSidecar(logDirectory: string, ...lines: Line[]) {
  await rm(join(logDirectory, SIDECAR_NAME), { force: true })
  await appendToSidecar(logDirectory, ...lines)
}

export function sidecarPath(logDirectory: string) {
  return join(logDirectory, SIDECAR_NAME)
}

/** One arbitrary wall clock and one arbitrary boot, shared with the dense seed next door. */
export const EPOCH = 1_756_915_200_000
export const BOOT_MONO = 118_492_300_000

/**
 * One Run, stamping `seq` per Run and both clocks off one tick counter — which is what
 * makes a test that wants `at_wall` to disagree with append order have to say so out loud.
 *
 * `epoch` moves the Run's wall clock without touching anything else, for the one thing a
 * fixed one cannot express: a test about what an in-flight request's elapsed reads *now*,
 * which is a distance from the machine's own clock rather than a number in the file.
 */
export function aRun(runId: string, epoch = EPOCH) {
  let seq = 0
  let tick = 0

  function envelope<T extends Envelope["type"], P>(
    type: T,
    requestId: string | null,
    payload: P,
    at_wall?: number,
  ) {
    seq += 1
    tick += 1
    return {
      v: 1,
      run_id: runId,
      seq,
      at_mono: BOOT_MONO + tick * 100_000_000,
      at_wall: at_wall ?? epoch + tick * 100,
      request_id: requestId,
      type,
      payload,
    } as Extract<Envelope, { type: T }>
  }

  return {
    runId,
    header: (kind: "server" | "console" | "rake" | "worker" = "server", pid = 48_211) =>
      envelope("run_header", null, {
        kind,
        rails_version: "8.0.2",
        app_name: "ExampleApp",
        rails_root: "/home/dev/example-app",
        pid,
      }),
    end: () => envelope("run_end", null, {}),
    start: (requestId: string, method = "GET", path = "/posts/12", at_wall?: number) =>
      envelope("request_start", requestId, { method, path }, at_wall),
    route: (requestId: string, controller = "PostsController", action = "show") =>
      envelope("request_route", requestId, { controller, action, format: "html", params: {} }),
    finish: (requestId: string, finished: Partial<RequestFinishPayload> = {}) =>
      // No view or db runtime unless a test asks for them: a request that died before
      // reaching a controller has neither, and Rails 7.1 and 7.2 carry neither ever.
      envelope("request_finish", requestId, { status: 200, duration_ms: 78.3, ...finished }),
    // The rest of a payload is overridable rather than positional, because what a test about
    // SQL wants to say next is as often `name: null` as it is a duration. The one positional
    // field is `Omit`ted from the bag rather than left in it: two ways to set one field, one
    // of which silently wins, is a fixture lying to the test that used the other.
    sql: (
      requestId: string | null,
      sql = 'SELECT "posts".* FROM "posts"',
      query: Omit<Partial<SqlPayload>, "sql"> = {},
    ) =>
      envelope("sql", requestId, {
        sql,
        name: "Post Load",
        duration_ms: 0.41,
        cached: false,
        async: false,
        row_count: 1,
        binds: [12],
        ...query,
      }),
    log: (
      requestId: string | null,
      message = "Rendering posts/show.html.erb",
      line: Omit<Partial<AppLogPayload>, "message"> = {},
    ) => envelope("app_log", requestId, { severity: "info", message, source: "app", tags: [], ...line }),
  }
}
