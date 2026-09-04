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
Propshaft, no Hotwire, no JavaScript at all — so what the log shows is what the browser
did.

SQLite, so there is no service to start and nothing to install.

## Puma

`config/puma.rb` fixes the pool at `threads 8, 8` and runs a single worker, because
several requests genuinely in flight at once is the case the Reader exists for. Clustered
Puma — every worker its own Run — is an env var rather than an edit:

```sh
WEB_CONCURRENCY=2 bin/dev
```

## Tests

```sh
bin/rails test     # or bin/ci for the full local run
```

The suite is local by design: the repo's CI never boots Rails.
