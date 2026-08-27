# The event envelope carries three time fields, and requests are three events

Everything the Rails half emits is one envelope with a `type` discriminator, and the wire
is strictly append-only: a request is never a mutable record that gets revised, but three
separate events (`request_start`, `request_route`, `request_finish`) that the Reader folds
into one row. Every envelope carries `seq`, `at_mono` **and** `at_wall`, which looks
redundant and is not. Settled in
[#5](https://github.com/vulle5/rails-log-reader/issues/5).

## Why three time fields

Each does a job the other two cannot:

- **`seq`** — a per-Run integer incremented **at the moment of observation**, on the request
  thread, where `instrument` is synchronous and inline. That reproduces causal order *by
  construction* — no races, no ties — and is what makes "nothing ever reorders"
  ([#3](https://github.com/vulle5/rails-log-reader/issues/3)) implementable. It cannot
  survive a process restart and cannot be shown to a human.
- **`at_mono`** — monotonic nanoseconds. Measures duration and places an event at its true
  moment. Boot-relative, so meaningless across Runs and unshowable.
- **`at_wall`** — the only one a human can read. Can jump backwards under NTP, so it must
  **never** be sorted or subtracted.

They disagree in exactly one place: `load_async`, whose events are observed late (replayed
on the request thread). `seq` records replay order; `at_mono` records true issue order.
Carrying both lets the UI choose; carrying one would freeze that choice inside the Rails
half, where it cannot be revisited.

## Why three request events

`request.action_dispatch` was chosen over `start_processing.action_controller` as the
request's boundary so that 404s, bad routes and non-controller requests still get a row —
a typo'd path from a mobile client is exactly what the tool is opened to find. But that
payload knows only method and path. Without a third event carrying `controller` and
`action`, **a hung request would never say which controller it was stuck in** — the single
most valuable thing this product shows. `request_route` fires only when a controller is
entered, so its *absence* is the signal that routing failed.

## Considered options

- **One mutable request record, revised in place.** Reads more naturally as a domain object,
  but forces the transport to support updating a previously-sent thing — which rules out an
  append-only file and pre-empts [#6](https://github.com/vulle5/rails-log-reader/issues/6).
- **A timestamp alone, or a counter alone.** Neither suffices: two capture points originally
  used two different clocks, `load_async` genuinely reorders, and float-milliseconds-since-boot
  loses resolution as uptime grows.
- **Per-event uuids for deduplication.** Unnecessary once `run_id` exists — `(run_id, seq)`
  is already globally unique and stable across a re-read.

## Consequences

- `(run_id, seq)` is the event identity. A `run_id` change is a process restart, which the
  Reader draws as a visible boundary rather than silently interleaving two processes.
- Cross-Run ordering can only ever use `at_wall`, and is therefore approximate. Within a Run
  — where correlation actually matters — ordering stays exact.
- *In-flight*, *Partial request* and Run boundaries are all derived Reader-side and appear
  nowhere on the wire. Rails cannot know whether the Reader was listening, so the identical
  event stream is Partial or not depending only on when the Reader attached.
- The contract is transport-agnostic by construction, which is what lets #6 choose a socket,
  a file, or both without reopening this.

## Amendments

### From #6 (transport): `run_end`, and a pid-keyed `run_id`

Choosing the sidecar file ([ADR-0003](0003-a-sidecar-jsonl-file-is-the-transport.md))
exposed two gaps in the envelope. Both are additions, not reversals.

- **`run_end` joins the `type` union.** A Run announced its beginning (`run_header`) but not
  its end, so a request that was in flight when the process died stayed in flight forever —
  this ADR grants in-flight requests *no timeout, ever*, so nothing would ever resolve it.
  Under puma-dev, which reaps an idle app after 15 minutes by default, that is a nightly
  occurrence rather than an edge case. `run_end` is emitted best-effort from `at_exit`
  (`SIGTERM` reaches it; `SIGKILL` does not), and a `run_header` bearing a new `run_id` is an
  implicit end for the previous Run. In-flight requests of an ended Run become **Interrupted**
  — a third fate alongside finished and in-flight, and the mirror of a *Partial request*: that
  one missed a start, this one will never get a finish. Both are concluded from evidence, not
  from a clock.
- **`run_id` is derived lazily, keyed on `Process.pid`.** The Initializer runs once at boot,
  *before* a clustered Puma forks its workers. Every worker would inherit the same `run_id`
  while keeping its own `seq` counter, so two genuinely distinct events would collide on
  `(run_id, seq)` — the identity this ADR relies on for free deduplication — and one would be
  silently eaten. Memoising `[pid, run_id]` and regenerating on mismatch makes each worker its
  own Run, which is accurate: a forked process has its own `seq` space. This covers Spring and
  Passenger for the same reason, without naming them.
