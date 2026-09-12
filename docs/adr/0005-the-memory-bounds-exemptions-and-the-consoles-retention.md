# The Memory bound's three exemptions stay, and the Console borrows its retention

#27 built the *Memory bound* — a ring holding the load-on-open figure and evicting the
oldest rows once exceeded — and along the way made a handful of decisions nobody had
actually granted: what the ring refuses to take, what it forgets about what it took, and
whether the *Console* is bounded by it at all. [#12](https://github.com/vulle5/rails-log-reader/issues/12)
said "one number, not two"; #27 wrote five or six numbers' worth of behavior into
`CONTEXT.md` as though that sentence had settled them. [#44](https://github.com/vulle5/rails-log-reader/issues/44)
grilled each one individually. This records what survived.

## Why the three refusals stay

The ring will not take a request still *in flight*, whatever a `load-earlier` pull brought
in, or the one row left standing over the bound. All three were re-examined and all three
hold, for reasons already written into `CONTEXT.md`'s Memory bound entry: no timeout, ever;
a control that could be emptied out from under the developer who clicked it would be
useless; an empty table is worse than one row over budget. #44 didn't find better answers —
it found that these answers had never actually been asked for, and asking them now got the
same answers back, on purpose rather than by accident.

## Why the forked-worker gap is named, not fixed

Never-evict-in-flight has one real gap: a forked Puma worker writes no `run_header` of its
own, so it can never be *Interrupted*, so a request killed inside one without a clean
restart leaves an in-flight row nothing will ever conclude. A bound that swept this up on a
timer would be the exact rule this project refuses everywhere else, wearing a different
name. Left alone and written down in `CONTEXT.md` as a known edge case, because a timer that
only fires in the case nobody can name is not a smaller timer.

## Why the Console borrows the fold's retention

The Console read the envelope stream independently of `activityTable` and was left
unbounded when #27 landed — every App log event the session ever saw, regardless of whether
its row had long since been evicted. That was two problems wearing one shrug: a click on an
old Console line could land on a row that no longer existed, and the caption built for a
different kind of missing row (`NOT_SHOWN_CAPTION`, for a tab filter) was reporting the
wrong reason.

Two ways to close it: give the Console its own bound, sized by the same
`LOAD_ON_OPEN_EVENTS` constant, or make its retention derive from the Activity fold's own
eviction with no counter of its own. The first keeps "one number" in name only — it is
still a second ring, just tuned to match the first. The second is one ring driving both: a
Console line's lifetime is exactly its owning row's, so a row's eviction takes its lines
with it. That is what was chosen, and it dissolves the dangling-click problem as a
consequence rather than as a second fix — a line can no longer outlive the row it points at.

## Considered options

- **A per-session cap, or a decaying ceiling, on what `load-earlier` exempts.** Rejected: a
  developer clicking the control often enough for its ceiling growth to matter is already a
  self-limiting, manual action, and a decaying ceiling would make the control useless for
  the exact case it exists for.
- **Trimming the last row standing instead of exceeding the bound.** Rejected already by
  #27 — a count of 20,000 beside a timeline holding three is a lie a table may not tell.
- **An independent bound for the Console, sized by the same constant.** Rejected: still a
  second counter, and still capable of diverging from the fold's rows in edge cases a shared
  bound cannot.

## Consequences

- *Partial request* is no longer permanently marked: it clears once its own `load-earlier`
  pull recovers the `request_start` it was missing, because the events are then recovered
  rather than lost.
- A Run row evicted and later reopened by more unattributed traffic is marked `reopened`,
  distinguishing it from a Run the Reader only ever attached inside.
- The Console's definition changes from "everything the session ever saw" to "everything
  its rows still hold" — a real narrowing, traded for a Console that never points at a row
  that is gone.
- The "↓ N new" pill switches from a count to a floor ("5,000+ new") once its column is
  paused at the cap, rather than silently freezing while traffic runs past underneath.
