# A backtrace collapses gem frames into inline markers by default

Opening an exception's Detail column no longer dumps the full framework backtrace on
screen. Gem-frame runs collapse into a per-gap "N frames hidden" marker at their position
in the trace; the raised frame (`backtrace[0]`) and every Host-app frame — `isHostFrame`'s
own definition, the one [#58](https://github.com/vulle5/rails-log-reader/issues/58) already
uses for full-contrast highlighting — render in place, uncollapsed. Settled in
[#90](https://github.com/vulle5/rails-log-reader/issues/90), a follow-on to
[#73](https://github.com/vulle5/rails-log-reader/issues/73) once `isHostFrame` and
`RunIdentity`'s `railsRoot` ([#97](https://github.com/vulle5/rails-log-reader/issues/97))
gave a marker something correct to collapse against.

## Why this and not a truncated list, or a "show more" button at the bottom

A real exception's trace is mostly framework internals — `ActionDispatch`, `ActionPack`,
Rack, the app server — and scanning past forty of them to find the three lines that matter
is exactly the noise this column exists to cut. A truncated list (say, the first ten
frames) or a single "show more" at the bottom both throw away the one fact a stack trace
exists to carry: call order. Either would as easily hide a Host-app frame sitting past the
cutoff as it would the gem noise around it, and the Reader would have quietly decided which
half of the story the developer gets first. Collapsing by *contiguous run of non-Host-app
frames* instead keeps every Host-app frame in its real stack position, with the marker only
ever standing in for the gem frames actually beside it.

## Why `backtrace[0]` is exempt from its own rule

`isHostFrame` says nothing about *where in the stack* a frame sits, and Ruby's most common
exceptions — `NoMethodError`, `ActiveRecord::RecordNotFound` — raise from deep inside a gem
the overwhelming majority of the time. Collapsing the raise site by the same rule that hides
`ActiveSupport`'s dispatch chain would defeat the column on exactly the case it exists for:
open the exception, and the one line that says what broke is missing, folded into "N frames
hidden" like everything else. `backtrace[0]` is Ruby's own guarantee of where the exception
happened, not a heuristic — so it is the one frame this feature does not apply
`isHostFrame` to at all.

## Why reveal is one-way and unpersisted

A marker's reveal survives for the rest of that render and nothing longer: no re-collapse
control, and no state carried into the next selection. Two things this is not:

- **Not a preference.** Nothing here is a judgment about which frames the developer wants
  to see in general — it is a default for *this* trace, right now, and the next exception
  opened (even the same one, reselected) starts from the same default. A remembered
  "expand gems" toggle would need its own UI and its own persistence story for a feature
  whose entire job is to get out of the way until asked.
- **Not reversible.** A re-collapse control invites exactly the wrong question — "did I
  already look at this?" — for a screen whose promise is that nothing is ever dropped,
  only folded. One-way reveal keeps the marker meaning "not shown yet", never "currently
  hidden by a toggle you might have flipped by accident".

Implemented as a plain `useState<ReadonlySet<number>>` inside the `Backtrace` component
(`reader/src/ui/features/detail-column/components/DetailColumn.tsx`), keyed by each gap's
starting index. Selecting a different row (or a row with no exception) unmounts the
component the same way any other conditionally-rendered Detail block does, which is what
makes "starts fully collapsed again" true without any explicit reset code.

## Search reaches into a collapsed gap the same way it reaches everything else

*Search* **highlights and never hides** everywhere else it renders text
([`hooks/search.tsx`](../../reader/src/ui/hooks/search.tsx)). A collapsed gap is exactly the
kind of hiding that promise rules out, so a gap containing an active match renders open
regardless of whether it was ever clicked — computed each render from the current search
term rather than latched into the same reveal state a click sets, since it is describing
what is *currently* true of the term, not something the developer asked for.

## Independent of the wire's own truncation

`cutFrom`/`Cut` describe what the Sidecar had to drop because a field was too large to
carry over the wire — a fact about what was *sent*. Collapsing describes what the Reader
chooses to *show* of what it received in full. `segmentBacktrace`
(`reader/src/ui/features/detail-column/lib/backtrace.ts`) and the `Cut` component never
reference each other, and `exceptionText` (the copy-to-clipboard path) reads `backtrace`
directly rather than anything the UI has collapsed — the paste is always the complete
trace regardless of what is expanded on screen.

## Considered options

- **One marker for the whole non-Host-app trace**, rather than one per contiguous run.
  Rejected: a Host-app frame sitting between two gem runs would either vanish into a single
  blob or force choosing an arbitrary split point — both erase the one thing a stack trace
  is for, showing which frame called which.
- **A "show more" control that keeps expanding gem frames a page at a time.** Rejected:
  invented pagination for a feature whose actual unit of noise is "the gem run between two
  Host-app frames", not "some fixed number of lines" — a run of three collapses exactly as
  legibly as a run of forty already does.
- **Collapsing gem frames only when there is at least one Host-app frame to contrast
  against**, leaving an all-gem trace fully expanded. Rejected: the all-gem case (or
  `railsRoot` still unknown) is precisely when the trace is *longest* relative to what
  matters — the raise site is still one frame, the noise is still the rest — so it is the
  case this feature has the most to say about, not an exception to it.

## Consequences

- `backtrace.ts` gains `segmentBacktrace`, the pure function `Backtrace` renders from —
  unit-tested in `test/backtrace.test.ts` the same way `isHostFrame` already is, apart from
  the React state that makes reveal interactive.
- `reader-detail.test.tsx`'s exception tests now assert a raised frame plus a marker rather
  than every gem frame in place, and gain a dedicated `describe` covering the collapse
  itself: multiple gaps around a Host-app frame, the all-gem case, one-way reveal, the reset
  on reselection, and copy staying unaffected.
- `CONTEXT.md`'s Detail column entry already read "gem frames collapsed by default" ahead
  of this change — written down as the target shape before the code caught up to it.
