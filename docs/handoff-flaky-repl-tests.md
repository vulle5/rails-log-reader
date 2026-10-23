# Handoff: flaky REPL tests on `195-load-earlier`

A working note for the next agent. Delete this file before the branch merges.

## Already fixed: the Memory bound CI failure (`5acf8e5`)

CI failed `the Memory bound > gives up its oldest rows once it holds more events than it
opened on` in `reader/test/activity-table.test.ts`, with 2510 rows where 2500 were expected.
It was a real race, not a flaky test.

- **Cause:** `appendFile` creates the Sidecar and then writes to it. A watcher tick between
  the two made `read()` in `reader/src/server/sidecar.ts` attach to a 0-byte file: it
  announced `onHistoryStart(0)` and delivered no batch. Both consumers
  (`reader/src/ui/hooks/live.ts` and the harness in `activity-table.test.ts`) take the batch
  after a history announcement for the opening batch. So the next live burst went through
  `foldOpen`, which raised the ceiling and evicted nothing. In the app, this happens on a
  re-attach after Rails truncates the Sidecar at boot.
- **Fix:** an attachment always delivers the batch it opened on, even an empty one.
- **Tests:** `sidecar.test.ts` "delivers the batch an attachment opened on, empty when it
  opened on nothing" (fails every time without the fix). `activity-table.test.ts` "still
  bounds a burst that arrives after the Reader attached to an empty Sidecar" (fails about 60%
  of runs without the fix).

## Still open: the REPL timing tests

The feature's agents reported intermittent failures that passed on re-run, in
`repl-session`, `reader-repl`, `reader-repl-history`, and once a status-strip test in
`reader-transcript-entries`. No cause found yet.

### What was observed

1. **Quiet machine, full `bun test`:** 1 failure in 8 runs, `the REPL session > boots
   bin/rails console with the eval loop on the first attachment that asks, and says booting,
   then ready`. One other one-off failure: `the REPL session's multi-line check > checks a
   complete input as complete, and one with an open block as incomplete`. The error output
   of neither was captured.
2. **Under CPU contention:** the four files run as 4 parallel `bun test` runs, 3 rounds, on 20
   cores. Round one had 2 failures, both `the REPL session's console process ending > closes
   its stdin, then sends it SIGTERM, when the session closes` (`reader/test/repl-session.test.ts`,
   near line 409). Two errors were printed: `gave up waiting, at
   {"state":{"kind":"booting"},"sandbox":false,"capabilities":[],"transcript":[],"consoles":[]}`.
   That is the 5 s deadline in `listen().until` near the top of the same file.
   - **Inconsistent:** bun reported that test at about 12.6 ms, which does not fit a 5 s
     wait. The `gave up waiting` error may belong to a different test, or a session may be
     leaking across tests. Not checked.
3. **Rerun with full output saved:** 0 failures in 12 more runs. The rate is low and depends
   on load.

### Leads, none investigated yet

- `afterEach` in `repl-session.test.ts` calls `session.close()` without waiting for the
  console process to exit, then removes the root. A console from one test may still be
  running, or still writing `log/stub-console.log`, when the next test starts.
- `reader/test/stub-console.ts`:
  - The SIGTERM handler waits up to 100 ms for stdin `end` before noting `SIGTERM`.
  - The `channel.on("end")` handler exits after 100 ms.
  - Under load, either timer could reorder `["stdin closed", "SIGTERM"]` or end the process
    before it notes anything.
- `reader/test/repl.fixtures.ts`: `bin/rails` is a shell script that `exec`s bun on the
  stub. Starting a bun process is slow under contention, so check for any wait that is
  shorter than a slow boot.
- `reader/src/server/repl-session.ts`: how `close()`, and the order of stdin close and
  SIGTERM, interact with a console that is still booting.

### How to reproduce

Run the four files as several parallel `bun test` runs, from `reader/`, with the full output
of each sent to its own file (not filtered through grep). Repeat until one fails, then read
the whole failure block, including which test the `gave up waiting` error belongs to.

```sh
for j in 1 2 3 4; do
  (bun test test/repl-session.test.ts test/reader-repl.test.tsx \
    test/reader-repl-history.test.tsx test/reader-transcript-entries.test.tsx \
    > /tmp/flaky-$j.log 2>&1) &
done; wait
grep -l "(fail)" /tmp/flaky-*.log
```
