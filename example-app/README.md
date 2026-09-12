# Example app

A Rails 8 app that exists to be *read*, not used. Its job is to emit genuine SQL events and
App log events for the Reader next door to be developed against — real models,
real associations, real migrations, and a seed that is the same every time.

It is not the product. See `../CONTEXT.md` for what "Example app" means here, and what it
is deliberately not.

## Setup

```sh
bin/setup
```

That checks for Ruby and for a C toolchain — several gems build native extensions — and
tells you the one command that gets each. It never installs either. Then it installs the
gems and prepares the database.

The Ruby version is pinned twice, because the two files are read by different things:
`.ruby-version` for rbenv, rvm, chruby and asdf, and `mise.toml` for mise, which ignores
`.ruby-version` unless you turn idiomatic version files back on. If you use mise, note
that `mise use` only writes config — it does nothing to your `PATH` until mise is hooked
into your shell with `mise activate`. `bin/setup` says so when that is what is wrong.

Then:

```sh
bin/dev            # http://localhost:3000
bin/reset          # restore the seed
```

## What is in it

`Author`, `Post` and `Comment`, with the associations you would expect. `db/seeds.rb`
plants twelve authors, sixty posts and three hundred comments, all of them written down
rather than generated — no `Faker`, no `Random`, seeded or otherwise — so `bin/reset`
restores the same rows rather than fresh rows of the same shape.

The web side is three actions: `posts#index`, `posts#show`, and `comments#create`. Leaving
a comment is a plain GET → POST → redirect → GET, with the write in the middle. ERB and
Propshaft, no Hotwire — so what the log shows for those pages is what the browser did. The
one exception is `/scenarios`, below, where a little vanilla `fetch()` is the point.

SQLite, so there is no service to start and nothing to install.

## Puma

`config/puma.rb` fixes the pool at `threads 8, 8` and runs a single worker, because
several requests genuinely in flight at once is the case the Reader exists for. Clustered
Puma — every worker its own Run (Scenario 12) — is an env var rather than an edit:

```sh
WEB_CONCURRENCY=2 bin/dev
```

`force_shutdown_after 5` is also set there, for Scenario 10: without it, a plain `TERM`
against a hanging request waits forever rather than forcing it, which is not something a
Scenario can demonstrate by hanging the terminal that ran it.

## The Initializer

`bin/setup` copies `../reader/rails/rails_log_reader.rb` into `config/initializers/`. A
copy rather than a symlink, because copy-paste is how the product is distributed and this
app has to install it the way a human does; CI diffs the copy against its master and fails
on any difference.

The copy is inert until you turn it on for yourself:

```sh
touch log/rails_log_reader.enabled
bin/dev
```

Events then land in `log/rails_log_reader.jsonl`, one JSON object per line, for the Reader
to tail. Both files are git-ignored already — Rails' generated `.gitignore` covers
`/log/*`, which is why the marker lives there. Delete it and restart to turn the
Initializer off again: it is read once, at boot, so enabling and disabling both take a
restart.

## Scenarios

`/scenarios` has one button per Scenario — the traffic shapes the Reader exists to make
readable. Every button is also a plain `curl` line, listed below, because the endpoints
are the interface: an agent can drive the same traffic the page does, no `bin/scenarios`
CLI required, and there is no launcher in the Reader either. This page's own requests are
not excluded from capture.

```sh
# 1 — Parallel in-flight requests with interleaving queries. One request is nothing special;
# fire several at once for the shape this Scenario is named for.
for i in 1 2 3 4; do curl -s http://localhost:3000/scenarios/parallel & done; wait

# 2 — An N+1-shaped request: one query for the comments, one more per comment for its author.
curl -s http://localhost:3000/scenarios/n_plus_one

# 3 — A slow query: a recursive CTE, genuinely slow inside SQLite. No Ruby `sleep`.
curl -s http://localhost:3000/scenarios/slow_query

# 4 — A hanging request. Never responds; Ctrl-C to give up on it.
curl -s http://localhost:3000/scenarios/hang

# 5 — A 500 with a real backtrace.
curl -s http://localhost:3000/scenarios/error

# 6 — A Rails.logger call sandwiched between two queries: the dual-homing case.
curl -s http://localhost:3000/scenarios/dual_homing

# 7 — A raw connection.execute: no model, no binds, a nil name.
curl -s http://localhost:3000/scenarios/raw_sql

# 9 — A request flood at ~20 concurrent. Only 8 are ever truly mid-flight at once — Puma's
# pool above is fixed at `threads 8, 8` — but each is cheap enough that the rest drain from
# the queue in milliseconds, so the Activity table still sees it as a burst. For a wider one,
# `WEB_CONCURRENCY=2 bin/dev` first.
for i in $(seq 20); do curl -s http://localhost:3000/scenarios/flood & done; wait
```

## Process lifecycle Scenarios

The Scenarios above all assume a `bin/dev` already running and press on the *shape* of
traffic. These six (#31) press on process *lifetime* instead — a second Run sharing the
Sidecar, a process dying mid-request, the Reader attaching after a request has already
started, two Puma workers — so several of them start or kill the server themselves rather
than assuming one is already up, and none of them is a single `curl` line.

```sh
# 8 — A rake-task burst: bulk unattributed queries from a second concurrent Run appending to
# the same Sidecar as the server — the only Scenario that tests ADR-0003's O_APPEND claim.
# Run it alongside ordinary traffic, not alone, or there is nothing for it to interleave with.
bin/rake scenarios:rake_burst &
for i in 1 2 3 4; do curl -s http://localhost:3000/scenarios/parallel & done
wait

# 10a — Interrupted via SIGKILL: no at_exit runs, so no run_end is ever written for the
# killed Run. Nothing on the wire says so directly — the Reader has to conclude the
# interruption from the next Run's own run_header, so this restarts the server once more:
# that second run_header is the evidence, not a separate step to remember later.
bin/dev & SERVER_PID=$!
sleep 1
curl -s http://localhost:3000/scenarios/hang &
sleep 1
kill -9 $SERVER_PID
bin/dev & SERVER_PID=$!
sleep 1
kill -TERM $SERVER_PID
wait $SERVER_PID

# 10b — Interrupted via TERM, the "clean" path: config/puma.rb sets `force_shutdown_after 5`,
# so a plain TERM — which would otherwise deadlock forever against a hanging request — instead
# forces the hung request's thread after 5s. In this app's own development settings that
# lands the request in ActionDispatch::DebugExceptions, so it actually finishes, naming
# Puma::ThreadPool::ForceShutdown as its exception; either way the process then exits
# normally and its at_exit runs, so the Reader reads a real run_end rather than inferring
# one, unlike 10a above.
bin/dev & SERVER_PID=$!
sleep 1
curl -s http://localhost:3000/scenarios/hang &
sleep 1
kill -TERM $SERVER_PID
wait $SERVER_PID

# 11 — Partial request: attach the Reader mid-flight. Fire the request, then — while it is
# paused between its two queries — replace the Sidecar out from under it, the same as
# ADR-0003's boot-time truncation firing under a live Run. request_start, and the query
# ahead of the swap, are gone; the query on the far side survives with no start the Reader
# can ever trace it back to — a genuine Partial request rather than a race reproduced by hand.
curl -s http://localhost:3000/scenarios/partial_request &
sleep 1
: > log/rails_log_reader.jsonl
wait

# 12 — Clustered Puma at WEB_CONCURRENCY=2, the only test of the pid-keyed run_id. Puma
# preloads the app by default in cluster mode, so the one run_header on boot belongs to the
# master; each worker gets a run_id of its own — with no run_header — the first time it
# handles anything, keeping (run_id, seq) from colliding between them.
WEB_CONCURRENCY=2 bin/dev &
sleep 2
for i in $(seq 20); do curl -s http://localhost:3000/scenarios/flood & done; wait

# 13 — A middleware outside Rails::Rack::Logger logs a line and runs a query in its
# Rack::BodyProxy close block, after the response has already been sent — a genuine
# Trailing event, visibly in the Sidecar rather than in anything this request's own
# response shows.
curl -s http://localhost:3000/scenarios/trailing_event

# 14 — A long-lived rake task that outlives a server restart. Start it, restart the server
# beside it however you like (bin/dev again, or `touch tmp/restart.txt` under puma-dev), and
# it keeps its own run_id and its own climbing seq throughout. Runs until you stop it.
bin/rake scenarios:long_task
```

## Tests

```sh
bin/rails test     # or bin/ci for the full local run
```

The suite is local by design: the repo's CI never boots Rails.

`test/initializer/` is the Rails half's own seam, and it works differently from the rest:
the Initializer refuses every environment but `development`, so those tests boot the app as
a real development Run in a throwaway Rails root — `test/support/development_run.rb` — and
read the Sidecar and `log/development.log` it wrote. Nothing there touches this app's own
`log/` or `config/`.
