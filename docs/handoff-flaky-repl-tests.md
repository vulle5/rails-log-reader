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

## Diagnosed, to confirm on WSL2: the REPL timing tests

The failures were seen on Windows under WSL2. They don't reproduce on macOS: 0 failures in 32
runs of `repl-session.test.ts` at 8 runs in parallel. Two causes were found.

### 1. A wall-clock jump ends `until` early (`repl-session`)

`until` in `reader/test/repl-session.test.ts` took its 5 s deadline from `Date.now()`. WSL2's
wall clock can jump forward when Hyper-V resyncs it. A jump of more than 5 s makes `until` give
up on its first check. This fits every oddity in the earlier observations:

- The failing test ran for about 12.6 ms but reported a 5 s `gave up waiting`.
- The snapshot was `booting` with an empty Transcript: the stub had not even printed its boot
  line yet.
- Two parallel runs failed the same test in the same round, which a system-wide jump explains.
- The one-off quiet-machine failures (`boots bin/rails console…` and the multi-line check) also
  wait through `until`.

The WSL2 machine is known to drift. An AI harness on it has reported a session as already 4 s
old just after it started. That's the same fault: the VM's wall clock drifts from Windows', and
something steps it back. Hyper-V time sync does this, and so does WSL resuming after sleep. The
4 s seen there is just under the 5 s that `until` allows, and a resume after sleep can step it
further.

To reproduce on macOS, use a preload that moves `Date.now()` forward 6 s, 20 ms in. It fails
`closes its stdin, then sends it SIGTERM…` with exactly that error and snapshot, in 26 ms.

**Fix:** `until`, and the two deadline loops in `reader-command.test.ts`, use the monotonic
`performance.now()`. The UI tests (`reader-repl`, `reader-repl-history`,
`reader-transcript-entries`) pass with `Date.now()` jumping 6 s every 250 ms, so they don't
depend on the clock.

### 2. Bound-filling status-strip tests run past bun's 5 s limit under load

Four tests in `reader-transcript-entries.test.tsx` fill the Activity table to the Memory bound.
They take up to 1.9 s on a quiet machine, mostly rendering the rows and the `user-event` click
over that DOM; less traffic doesn't make them faster. At 6 runs in parallel on 10 cores, two of
them took 6 to 7.5 s and timed out in every run. After a timeout, the test keeps running and
throws into the next one (`ERR_INVALID_THIS` from jest-dom). That's the same way an orphaned
error can be pinned on an unrelated test.

**Fix:** those four tests get a 15 s limit, `FILLS_THE_BOUND_MS`. After both fixes, the repro
below passed 18 of 18 runs, against 18 of 18 failing before.

### Left to do

- Run the repro on the WSL2 machine. If `repl-session` still fails there, read the whole
  failure block. A test that bun timed out is the first suspect for an error reported on a
  later test.
- Confirm the clock steps on the WSL2 machine. Leave this running while you work or run the
  repro. It prints each time the wall clock moves apart from the monotonic one:

  ```sh
  bun -e 'let w=Date.now(),m=performance.now();setInterval(()=>{const dw=Date.now()-w,dm=performance.now()-m;if(Math.abs(dw-dm)>50)console.log(new Date().toISOString(),"wall clock stepped",Math.round(dw-dm),"ms");w=Date.now();m=performance.now()},250)'
  ```

  Steps of several seconds confirm the cause. `date; powershell.exe -c "Get-Date -Format o"`
  compares the VM's clock with Windows' directly. The tests no longer depend on the clock, but
  the drift itself can be cut down: run `wsl --update`, enable `systemd-timesyncd` in the
  distro, or resync by hand with `sudo hwclock -s`.
- The stub-console leads from before (the 100 ms timers in `stub-console.ts`, `afterEach` not
  waiting for exit) were not needed to explain any observed failure, and stay unexamined.

### How to reproduce

Run the four files as several parallel `bun test` runs, from `reader/`, with the full output
of each sent to its own file (not filtered through grep). Repeat until one fails, then read
the whole failure block.

```sh
for j in 1 2 3 4; do
  (bun test test/repl-session.test.ts test/reader-repl.test.tsx \
    test/reader-repl-history.test.tsx test/reader-transcript-entries.test.tsx \
    > /tmp/flaky-$j.log 2>&1) &
done; wait
grep -l "(fail)" /tmp/flaky-*.log
```
