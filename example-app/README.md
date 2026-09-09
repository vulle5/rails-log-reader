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
Puma — every worker its own Run — is an env var rather than an edit:

```sh
WEB_CONCURRENCY=2 bin/dev
```

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

# 9 — A request flood at ~20 concurrent.
for i in $(seq 20); do curl -s http://localhost:3000/scenarios/flood & done; wait
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
