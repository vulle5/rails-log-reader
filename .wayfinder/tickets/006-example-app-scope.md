---
id: 006
title: Scope the example Rails app
type: grilling
status: open
parent: map
assignee:
blocked_by: [005]
---

## Question

Decide what `example-app/` is and what it must be able to do on demand. It is a test
fixture that happens to be a Rails app — not a product, and not a demo.

Decide:

- **What scenarios it can generate**, on demand and reproducibly. At minimum the ones
  that motivated this project: N parallel in-flight requests whose queries interleave;
  a slow query; a request with dozens of queries (N+1 shaped); a request that hangs and
  never completes; a 500 with a backtrace; `Rails.logger` calls sandwiched between
  queries inside a request; and unattributed output with no `request_id` at all.
- **How those are triggered** — rake tasks, a seeded load-generator script, a handful of
  controller endpoints hit by a driver script, or an endpoint that fans out into
  parallel requests against itself to simulate the mobile client.
- **How minimal it can be.** Whether it needs a real database (and which), models and
  migrations, or whether raw SQL against SQLite is enough to produce genuine
  `sql.active_record` events.
- **How it is set up and run** by an agent or a new contributor, and whether Ruby/Rails
  installation is assumed or scripted.
- **How the initializer gets in.** The example app must install the same copy-paste
  initializer the work app will use — decide whether it copies the canonical file or
  symlinks it, so the two can never silently drift.

Blocked on the ingestion decision because what the app must be configured to emit
depends entirely on which architecture wins.
