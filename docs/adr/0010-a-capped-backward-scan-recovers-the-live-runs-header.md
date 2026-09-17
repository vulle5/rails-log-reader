# A capped backward scan recovers the live Run's header outside the load window

On attaching, the Reader looks specifically for the live Run's own `run_header` when it
sits outside the load-on-open window, and feeds it straight to `RunIdentity` the instant it
is found — no manual `load-earlier` click required. Settled in
[#98](https://github.com/vulle5/rails-log-reader/issues/98), built on `RunIdentity` itself
([#97](https://github.com/vulle5/rails-log-reader/issues/97)) and reported against
[#96](https://github.com/vulle5/rails-log-reader/issues/96): a Sidecar with 20,530 events
written after its last `run_header` — four times the load-on-open window — left `railsRoot`
unknown for the entire session, and every backtrace frame unhighlighted with nothing in the
UI suggesting why.

## Why this is not the same problem `load-earlier` already solves

`load-earlier` is the Reader saying "show me more history": a developer's own click, an
unbounded amount of it, evicting and re-opening rows as the ceiling it raises takes in
whatever the pull turned up. A `run_header` outside the window is a different shape
entirely — one small, fixed fact, not a request for more of the file — and answering it the
`load-earlier` way costs the developer several manual round trips (five, at the reported gap
size) for a fact the Reader could simply go and get.

## The scan

A backward chunked read, continuing past where `startOfHistory`'s own scan opened the
load-on-open window — same chunking, same direction, but looking for one line rather than
counting all of them. A cheap substring check (`` line.includes('"type":"run_header"') ``)
runs before any `JSON.parse`, so the common case — a header within the first few MB — is
close to free: most of a Sidecar's lines are never parsed at all.

## Why 64 MB

The same figure `rails_log_reader.rb`'s `MAX_SIDECAR_BYTES` already truncates the whole file
to at boot: how big a Sidecar is supposed to get, so a header not found within that much of
it is not one that could still be sitting further back — the same reasoning that already
justifies treating 64 MB as "the whole Sidecar" everywhere else in this codebase, reused
rather than re-derived.

Benchmarked against a synthetic 300 MB worst-case Sidecar whose header was never found —
every line read, every substring check missing, all the way to the cap — at roughly
2.5 ms/MB. The 64 MB cap's worst case therefore costs on the order of 150-200 ms, and it
never blocks the load-on-open history already streaming to the browser: the scan is fired
off and awaited asynchronously, off the read path `read()` uses to deliver ordinary
envelopes.

Past the cap, the Reader gives up exactly as it does today: `RunIdentity` stays whatever it
was, and the marker/manual `load-earlier` recovery remains available for the developer who
wants to go further than 64 MB by hand.

## A narrow, memoized exception to the stateless server

`index.ts` states the server holds no fold, no rows and no history of its own — every
connection is an independent attachment, which is what makes a second tab or a browser
reconnect free. A capped scan run again on every attachment would undercut exactly that: two
tabs on the same Host app would each pay the scan's cost independently, for the same answer.

The result is memoized per `(inode, run_id)`, invalidated the same way `read()`'s own attach
detection already is — a different inode means a truncation or a replaced file, and a
different `run_id` at the same inode means a Run that itself started after the memoized
scan ran. Either one moving invalidates the cached result without a truncation watcher of
its own. This is a deliberate, single exception: one memoized fact, not a general cache, and
one that a truncation clears the same instant `read()` notices it too.

## Why the result bypasses `activity.fold`/`foldEarlier`

A `load-earlier` pull's envelopes are folded as an ordinary batch because they are one: rows
open, timelines grow, and a pull large enough can even give the *last row standing* company
and make it evictable again. A `run_header` recovered by this scan is not that — it did not
just get appended, and it is not a block of history the developer asked to see. Folding it
would open a row for it, advance `rows.length`, and risk exactly the *Memory bound*
interaction this feature exists to avoid.

Wired instead as a dedicated SSE event (`run-header`), kept apart from the `data:` messages
`onEnvelopes` produces, and read by `live.ts` straight into `latchRunIdentity` — never
`activity.fold` or `stream.fold`. The same function that already latches a header arriving
through the live stream or a `load-earlier` pull latches this one too, because latching a
`run_header` is one operation regardless of which of the three paths found it.

## Considered options

- **Raise `LOAD_ON_OPEN_EVENTS`** so the window reaches the header on its own. Rejected: the
  reported gap was four times the window already, and a Host app that stays up longer still
  would need the window raised again — this is a fact-shaped problem, not a
  more-history-shaped one, and `CONTEXT.md`'s Memory bound is sized by this same figure, so
  raising it moves both at once for a fix that address neither.
- **Make `load-earlier` itself smarter** — auto-continue until a header turns up. Rejected:
  conflates a developer's own request for history with the Reader's own bookkeeping, and
  still opens rows and evicts under the *Memory bound* the way an explicit pull does, which
  is exactly what this feature exists not to do.
- **A synchronous scan, blocking the load-on-open history.** Rejected: even the capped
  worst case is 150-200 ms, and there is no reason to make a browser wait on a fact that is
  usually found in microseconds when the history it actually asked for is already ready to
  stream.

## Consequences

- `openSidecar` gains a fourth callback, `onRunHeader`, alongside `onEnvelopes` and
  `onHistoryStart` — every caller (the server's own `/events` route, and the tests that join
  `sidecar.ts` and `activity.ts` directly) has to be threaded through it.
- The server now holds one piece of state that is not the Reader's own offset bookkeeping: a
  `Map` from Sidecar path to its last memoized scan. Scoped to exactly the fact named above,
  and cleared by the same truncation detection `read()` already performs — not a precedent
  for holding anything else.
