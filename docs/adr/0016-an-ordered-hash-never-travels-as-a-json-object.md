# An ordered Hash never travels as a JSON object

A Hash whose order the Reader shows travels as a list of pairs, never as a JSON object.
JavaScript lists an object's integer-like keys (canonical integers up to 2³²−2) first, in
ascending order, whatever order they were written in. `JSON.parse` builds exactly such an
object, so `quantities[42]=1&quantities[7]=2` would reach the *Value viewer* as `7` before `42`,
and a hash mixing `"5"` and `"name"` would put `"5"` first. That breaks the viewer's promise
that it never reorders what it shows. The Initializer's Hash already has the right order, so
the fix is to keep that order on the wire. Settled in
[#189](https://github.com/vulle5/rails-log-reader/issues/189).

## The shape

- **Params are tagged pairs at every Hash level:** `{"pairs": [["quantities", {"pairs":
  [["42", "1"], ["7", "2"]]}]]}`. Arrays stay arrays and scalars stay scalars. The tag is needed
  because a bare `[[k, v], …]` cannot be told apart from a real array of two-element arrays,
  such as `a[][]=x`. Since no untagged object is left, any object in params is a Hash.
- **Response headers are plain `[[name, value], …]`,** with no tag, because headers never nest.
- **A REPL result's hash-like nodes are pairs** of a key's `inspect` and its value. There,
  integer keys are the common case, not the edge case: `group(:post_id).count`, `tally` and
  `group_by(&:id)` all give them.
- **Both shrink walks treat a tagged Hash as a Hash.** The Initializer's `shrink_to_fit` and the
  Sidecar reader's `shrinkToFit` never drop a pair, and shrink the values evenly, just as an
  object's keys are kept today. Otherwise the pair list would be cut like an Array, losing its
  last keys.
- **`WIRE_VERSION` is 4.** An envelope at v3 or below still carries params as a plain object,
  with the order already lost. The Reader draws it as `JSON.parse` gives it, with no note: only
  integer-like keys are affected, and the lines age out of the Sidecar.
- **A response body is text on the wire**, not a JSON object, and is parsed when it is shown
  with a parser that keeps key order. See ADR-0015.

## Considered options

- **An order-keeping parse of the whole envelope.** Refused. The server parses every Sidecar
  line and serializes it again for the browser, so this would mean a custom parser on both hot
  paths plus a custom serializer.
- **Params as one JSON text string, parsed when shown.** Refused. It shares the body's parser
  and needs no special shape. But a params value over 64 KB would be cut like a string, so it
  could no longer be parsed and would show only as raw text. Today such a value keeps every key
  and only its values get shorter, and that rule is deliberate.
- **Accepting it and documenting it in `CONTEXT.md`.** Refused. It would add an exception to the
  Value viewer's "never reorders", and every later adapter would inherit it.
