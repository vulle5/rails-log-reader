# A sidecar JSONL file is the transport

The Initializer appends every Event as one JSON line to `log/rails_log_reader.jsonl`, and
the Reader tails that file. `log/development.log` is never touched, never reformatted and
never tagged. The transport is a **file**, not a connection: nothing is negotiated, nothing
reconnects, and the two halves never need to be running at the same time. Settled in
[#6](https://github.com/vulle5/rails-log-reader/issues/6).

## Why a file beats a socket

The live socket was a genuine rival, not a straw man — the user had already accepted "the
tool must be running" as a cost. It lost because every question this decision had to answer
turns into a *protocol* under a socket and **stops existing** under a file:

| Question | Socket | File |
| --- | --- | --- |
| Rails boots before the Reader | buffer, or drop | events are already on disk |
| Reader restarts mid-request | reconnect, resync, detect the gap | re-read from an offset |
| Reader is slow or wedged | backpressure into the request thread | the kernel's page cache |
| Several Runs at once (`rails s` + `rails c`) | a listening server, a connection table, per-connection state | `O_APPEND`, serialised by the inode lock |
| History on open | impossible by construction | free |

The socket's one real advantage is leaving nothing on disk. That advantage is worth almost
nothing here, because Rails' own generated `.gitignore` already contains `/log/*` — so a
sidecar under `log/` costs **no `.gitignore` edit and no user action at all**. The ticket
had listed that edit as a cost of this option; it was wrong.

The hybrid (socket when available, file otherwise) was rejected for the same reason: hybrids
earn their complexity when the fallback is *worse*, and here the fallback is the better
mechanism. It would have bought single-digit milliseconds in exchange for two capture paths,
two failure modes, and a cutover between them.

## Why tag-and-parse was never live

The ticket offered parsing Rails' own human-readable output, tagged with
`config.log_tags = [:request_id]`. Two independent kills:

1. `log_tags` prefixes **every line** of `development.log` with `[uuid]`, and
   `query_log_tags` writes a comment into the SQL itself. That is standing constraint 1.
2. More fundamentally, [ADR-0002](0002-the-event-envelope-and-ordering-key.md) defines `seq`
   as a counter taken **at the moment of observation**. No parser can recover a number that
   was never written down. Neither can it recover `at_mono`. Tag-and-parse cannot produce
   the envelope this project already committed to — it is not a weaker transport for the
   same contract, it is a different contract.

## The shape of the file

- **One shared file**, `log/rails_log_reader.jsonl`, written by every opted-in process.
  Per-Run files (`<run_id>.jsonl`) would make cleanup trivial, but push a directory watcher,
  an fd per Run, a stream merge and a crashed-process sweeper onto the Reader. Nothing on the
  map needs to open Runs selectively. Cross-Run ordering is not lost by sharing a file,
  because `seq` is per-Run by definition — there was never a global order to preserve.
- **Concurrent writers are supported by construction.** `O_APPEND` writes to a regular file
  are serialised by the kernel under the inode lock, so whole lines from `rails s`, `rails c`
  and a rake task interleave cleanly with no coordination, and `run_id` separates them.
  "Which of my four terminals is this query from" is the case where correlation hurts most.
- **Strictly one-way.** The Reader never talks back. Version-mismatch *repair* already works
  through the filesystem and a restart (ADR-0002), and the REPL is out of scope — so a file,
  which cannot carry a back-channel, loses nothing.
- **Synchronous append**, one mutex, `sync = true`, no background thread. `seq` must be taken
  inline on the request thread regardless; a drain thread would add a queue bound, a drop
  policy and a flush-at-exit problem, and would lose events precisely at shutdown, which is
  when they matter most. An append to a page-cached file is sub-microsecond.

## Bounds, and why each one is a bound rather than an assumption

The user runs work apps under **puma-dev**, which idles an app out after 15 minutes by
default (`-timeout`; they have raised theirs to 60). So Runs are short and frequent, and it
is the *file* that accumulates across dozens of Runs a day, not any single Run. Every limit
below is therefore a bound, unaffected by how long a Run happens to live:

- **Disk: 64 MB, checked once at boot**, truncating if exceeded. One `File.size` call, no
  runtime cost, no rotation, no `.1` files, no sweeper. Truncating at *every* boot would
  fire every idle cycle and destroy the history we just decided to replay.
- **Load-on-open: the last ~5,000 events**, read backwards from EOF, rendering whatever whole
  Runs that covers. One seek, no configuration, and it degrades into "the whole Run" in the
  common case. Retention proper stays fog; this bounds only what the UI ingests.
- **Line: 256 KB.** ADR-0002 truncates at 64 KB *per field* but keeps backtraces full and
  uncleaned, so one 500-error event can run to several hundred KB — large enough that a
  single `write(2)` may be split, at which point a concurrent writer's line can land inside
  it. Over the cap, the largest field is truncated further and recorded in `truncated`, the
  mechanism ADR-0002 already built. The Reader also **skips any unparseable line silently**.

## Opting in, and failing quietly

- **One environment variable, read once at boot.** Unset, the Initializer returns before
  subscribing to anything, opening any file, or touching `Rails.logger`: a teammate who never
  sets it pays nothing and sees nothing. **Production is refused unconditionally** — a rail,
  not a setting, because this file gets copy-pasted into a real work app that also boots in
  CI. `test` stays allowed; debugging a flaky system test is a plausible local use.
- **Where the variable is set is the developer's choice, and is documentation, not design.**
  For puma-dev users: `~/.powconfig` is read first and never touches the repo; `.pumaenv` is
  the per-app equivalent; `dotenv-rails` loads `.env.development` at `before_configuration`,
  which runs *before* `config/initializers`, so a gitignored `.env.development` works too.
- **A failed write rescues, disables emission for the rest of the Run, and says nothing.** A
  raised exception inside a subscriber takes down the developer's request. The obvious place
  to complain — `Rails.logger.warn` — would write into the file we promised not to touch, and
  `$stderr` under puma-dev lands in puma-dev's own log, which nobody reads. The complaint had
  nowhere to go.

## How the Reader reads

**Watch the `log/` directory**, not the file: the Reader will routinely start before Rails
has ever booted, so there may be no file to watch yet, and a directory watcher covers
creation, replacement and appends with one watcher. Bun implements `node:fs` fully, so
`fs.watch` is available.

**A 1 Hz `stat` backs the watcher up.** This is not the 100 ms polling that was rejected —
nothing waits on the timer in the normal case. It exists because ADR-0002 grants in-flight
requests **no timeout, ever**: if `fs.watch` drops the notification carrying a
`request_finish`, no timer will ever correct that row, and the request shows as in-flight
until the Reader is restarted. The backstop turns a permanent lie into a one-second delay.

## Consequences

- **`run_end` is added to ADR-0002's type union**, emitted best-effort from `at_exit`. puma-dev
  reaps an idle app with `SIGTERM`, which Puma traps and exits cleanly, so `at_exit` runs. A
  new `run_header` with a different `run_id` is an implicit end for the previous Run.
  In-flight requests of an ended Run become **Interrupted** — resolved by fact (the process
  is gone, so they provably never finished), never by a timer.
- **`run_id` is derived lazily and re-derived when `Process.pid` changes.** The Initializer
  runs before Puma forks, so under `WORKERS > 0` every worker would otherwise inherit one
  `run_id` while keeping its own `seq` counter — two different events colliding on
  `(run_id, seq)`, which ADR-0002 makes the event identity, so dedup would silently eat one.
  Memoising `[pid, run_id]` makes forking a non-event for Puma workers, Spring and Passenger
  alike; each worker becomes its own Run, which is honest, since it has its own `seq` space.
- **Boot-time truncation can fire while another Run is live.** At ~500 bytes an event, 64 MB
  is ~130,000 events — a plausible busy day. Opening `rails c` then truncates the file under
  a still-appending server. `O_APPEND` writers are unharmed, but a watching Reader sees the
  file shrink, resets, and loses that Run's history. Accepted: the alternatives all want a
  liveness protocol (processes announcing themselves, stale announcements reaped), and
  rename-to-`.1` is worse — the live server keeps writing into the renamed inode it holds
  open while the Reader follows the path to the new file and loses that Run entirely. The
  Reader re-attaches mid-stream and its requests become **Partial requests**, which is
  ADR-0002's existing vocabulary describing this situation correctly.
- **History stopped being a nice-to-have and became free**, which retires the "the tool must
  be running" compromise the socket option would have required.
- **The Reader's ingestion is now a file offset**, which makes it drivable from a fixture
  file with no Rails process at all — relevant to the testing-strategy fog.
