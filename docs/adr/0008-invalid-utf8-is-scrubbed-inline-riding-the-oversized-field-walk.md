# Invalid UTF-8 is scrubbed inline, riding the oversized-field walk

`JSON.generate` raises on a String that is `BINARY`-encoded or not `valid_encoding?`, and it
raised *inside* `emit`'s own rescue — so one bad byte anywhere in any payload did not cost
the Run one event, it cost every event after it, with nothing in the Sidecar or
`development.log` to say why. `cut_oversized_fields` now scrubs every String it visits,
wherever nested inside an Array or a Hash, before a payload reaches `JSON.generate`. Settled
in [#33](https://github.com/vulle5/rails-log-reader/issues/33), generalizing a fix
[#20](https://github.com/vulle5/rails-log-reader/issues/20) first made for one field alone.

## Why the scrub rides an existing walk instead of a new one

`cut_oversized_fields` already walks every payload recursively to compute byte sizes for the
field cap. Scrubbing there costs nothing beyond what that walk already pays for: the
ordinary event, none of whose fields need scrubbing, is still one walk and no allocation. A
second, dedicated scrubbing pass over the same payload would double the walk for the common
case to guard against the uncommon one.

## Why the check is unconditional rather than scoped to large fields

The alternative — scrub only a field that happens to be large — was rejected:
[#13](https://github.com/vulle5/rails-log-reader/issues/13) already showed that a bad byte
cannot be relied on to correlate with field size, so "this field happened to be large" is not
a proxy for "this field might carry a bad byte." Every String is checked, regardless of size.

## Two replacement policies, not one

- A `BINARY`-encoded string, or one tagged UTF-8 that fails `valid_encoding?` and cannot be
  re-tagged as valid UTF-8, is opaque: it becomes `<N bytes of binary data>`, the same answer
  `development.log` itself gives for a redacted bind (the precedent #20 set for that one
  field).
- A string merely tagged UTF-8 that picked up a handful of bad bytes — a gem's exception
  message, a query string ActionDispatch never validated — is not opaque, and is
  `scrub("")`'d in place instead: the same answer `cut_string` already gives a byte-slice
  that lands mid-character. Discarding the whole string would lose an otherwise-legible log
  line.

## Consequences

- `SqlSubscriber`'s own `utf8` method (#20's original, bind-only fix) is retired: its one job
  happens for every payload in `emit` now, not binds alone.
- Neither replacement is recorded in `truncated`: that field means an original byte length
  before a *shrink*, and a scrub is not a length change in either replacement's own text.
- A payload with more String values now costs marginally more per event (a `valid_encoding?`
  check on every String), traded for a Run that never silently stops mid-stream.
