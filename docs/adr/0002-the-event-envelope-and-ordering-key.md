# The event envelope carries three time fields, and requests are three events

Everything the Rails half emits is one envelope with a `type` discriminator, and the wire
is strictly append-only: a request is never a mutable record that gets revised, but three
separate events (`request_start`, `request_route`, `request_finish`) that the Reader folds
into one row. Every envelope carries `seq`, `at_mono` **and** `at_wall`, which looks
redundant and is not. Settled in
[#5](https://github.com/vulle5/rails-log-reader/issues/5).

## Why three time fields

Each does a job the other two cannot:

- **`seq`** — a per-Run integer incremented **at the moment of observation**, on the request
  thread, where `instrument` is synchronous and inline. That reproduces causal order *by
  construction* — no races, no ties — and is what makes "nothing ever reorders"
  ([#3](https://github.com/vulle5/rails-log-reader/issues/3)) implementable. It cannot
  survive a process restart and cannot be shown to a human.
- **`at_mono`** — monotonic nanoseconds. Measures duration and places an event at its true
  moment. Boot-relative, so meaningless across Runs and unshowable.
- **`at_wall`** — the only one a human can read. Can jump backwards under NTP, so it must
  **never** be sorted or subtracted.

They disagree in exactly one place: `load_async`, whose events are observed late (replayed
on the request thread). `seq` records replay order; `at_mono` records true issue order.
Carrying both lets the UI choose; carrying one would freeze that choice inside the Rails
half, where it cannot be revisited.

## Why three request events

`request.action_dispatch` was chosen over `start_processing.action_controller` as the
request's boundary so that 404s, bad routes and non-controller requests still get a row —
a typo'd path from a mobile client is exactly what the tool is opened to find. But that
payload knows only method and path. Without a third event carrying `controller` and
`action`, **a hung request would never say which controller it was stuck in** — the single
most valuable thing this product shows. `request_route` fires only when a controller is
entered, so its *absence* is the signal that routing failed.

## Considered options

- **One mutable request record, revised in place.** Reads more naturally as a domain object,
  but forces the transport to support updating a previously-sent thing — which rules out an
  append-only file and pre-empts [#6](https://github.com/vulle5/rails-log-reader/issues/6).
- **A timestamp alone, or a counter alone.** Neither suffices: two capture points originally
  used two different clocks, `load_async` genuinely reorders, and float-milliseconds-since-boot
  loses resolution as uptime grows.
- **Per-event uuids for deduplication.** Unnecessary once `run_id` exists — `(run_id, seq)`
  is already globally unique and stable across a re-read.

## Consequences

- `(run_id, seq)` is the event identity. A `run_id` change is a process restart, which the
  Reader draws as a visible boundary rather than silently interleaving two processes.
- Cross-Run ordering can only ever use `at_wall`, and is therefore approximate. Within a Run
  — where correlation actually matters — ordering stays exact.
- *In-flight*, *Partial request* and Run boundaries are all derived Reader-side and appear
  nowhere on the wire. Rails cannot know whether the Reader was listening, so the identical
  event stream is Partial or not depending only on when the Reader attached.
- The contract is transport-agnostic by construction, which is what lets #6 choose a socket,
  a file, or both without reopening this.

## Amendments

### From #6 (transport): `run_end`, and a pid-keyed `run_id`

Choosing the sidecar file ([ADR-0003](0003-a-sidecar-jsonl-file-is-the-transport.md))
exposed two gaps in the envelope. Both are additions, not reversals.

- **`run_end` joins the `type` union.** A Run announced its beginning (`run_header`) but not
  its end, so a request that was in flight when the process died stayed in flight forever —
  this ADR grants in-flight requests *no timeout, ever*, so nothing would ever resolve it.
  Under puma-dev, which reaps an idle app after 15 minutes by default (the user has raised
  theirs to 60), that is a nightly
  occurrence rather than an edge case. `run_end` is emitted best-effort from `at_exit`
  (`SIGTERM` reaches it; `SIGKILL` does not), and a `run_header` bearing a new `run_id` is an
  implicit end for the previous Run. In-flight requests of an ended Run become **Interrupted**
  — a third fate alongside finished and in-flight, and the mirror of a *Partial request*: that
  one missed a start, this one will never get a finish. Both are concluded from evidence, not
  from a clock.
- **`run_id` is derived lazily, keyed on `Process.pid`.** The Initializer runs once at boot,
  *before* a clustered Puma forks its workers. Every worker would inherit the same `run_id`
  while keeping its own `seq` counter, so two genuinely distinct events would collide on
  `(run_id, seq)` — the identity this ADR relies on for free deduplication — and one would be
  silently eaten. Memoising `[pid, run_id]` and regenerating on mismatch makes each worker its
  own Run, which is accurate: a forked process has its own `seq` space. This covers Spring and
  Passenger for the same reason, without naming them.

### From #14 (events outside the span): the boundary moves to our own middleware

This ADR chose `request.action_dispatch` as the request boundary. Its **start** is instrumented
in `Rails::Rack::Logger#call_app` — middleware #61 — while `ActionDispatch::RequestId` sits at
#54, so a band of middleware exists where a request already has a `request_id` but no row.
[#14](https://github.com/vulle5/rails-log-reader/issues/14) closed that band by moving the start
marker; the finish marker is unchanged.

- **`request_start` is emitted by the Initializer's own middleware**, inserted with
  `insert_after ActionDispatch::RequestId`. This is not a new footprint: the research on
  [#2](https://github.com/vulle5/rails-log-reader/issues/2) established there is no zero-config
  path from `env` to an `sql.active_record` subscriber, so that middleware has to exist anyway
  to write `request_id` into the Initializer's `CurrentAttributes`. Emitting the start from the
  same place makes attribution and the request row begin on the *same line of code* — which is
  what makes an early arrival **structurally impossible** rather than a case to handle. Nothing
  is lost from the payload: the middleware holds `env`, so `ActionDispatch::Request.new(env)`
  yields exactly the `{ request: }` that `request.action_dispatch` carried. 404s and
  non-controller requests still get a row, and `request_route`'s absence still signals a routing
  failure.
- **`request_finish` still comes from `request.action_dispatch`'s finish**, via the object-form
  subscriber — its start is now simply ignored. That finish is deferred to `Rack::BodyProxy`
  close and so fires after every middleware has unwound, which makes it the truest "request over"
  marker available. Its one cost is accepted knowingly: a row stays *in-flight* while a slow
  client is still reading the body, which is a false positive on the product's headline signal.
  In a strictly-local tool the client is a browser on `localhost`, so this is largely imported
  worry; if it bites, `process_action.action_controller`'s finish is already observed and can be
  promoted to a second field, and how it is *displayed* belongs to
  [#8](https://github.com/vulle5/rails-log-reader/issues/8), not here.
- **The asymmetry leaves one hole, accepted rather than closed.** Start and finish no longer come
  from the same handle, so if a middleware in the #55–#60 band raises
  (`ActionDispatch::RemoteIp::IpSpoofAttackError`) or short-circuits with a response without
  calling `@app`, a `request_start` is emitted for which no finish is possible. Ordinary 500s are
  *not* affected — `DebugExceptions` at #63 is well inside the span and those requests finish
  normally. Such a request is never-finishing and resolves as **Interrupted** at `run_end`, which
  is machinery that already exists. Closing the hole properly would need an `ensure` and a
  "did the inner start fire" flag — a second finish path in the one file that has to survive a
  skeptical colleague's one-minute read, spent on a six-slot window containing two default
  middlewares that neither log nor query.
- **A Trailing event is a Reader-side derivation**, like *in-flight*, *Partial* and *Interrupted*
  before it: it appears nowhere on the wire. What survives the new boundary is narrow — a callback
  on a body proxy registered *outside* `Rails::Rack::Logger`, chiefly `ActionDispatch::Executor`'s
  `to_complete`, which runs after the finish and before `CurrentAttributes` is cleared, so
  `request_id` is still readable there. A request row therefore accepts children for as long as
  the Reader holds it, with no timer — the memory bound in
  [#12](https://github.com/vulle5/rails-log-reader/issues/12) is the only thing that ever ends a
  row's life, so the retention policy and the attribution horizon are one rule, not two.

### From #8 (auto-scroll and ordering): append order is the Reader's spine

This ADR says `seq` "reproduces causal order by construction" and calls it what makes
"nothing ever reorders" implementable. That is true **within a Run** and only within a Run.
[#6](https://github.com/vulle5/rails-log-reader/issues/6) put concurrent Runs in one Sidecar
and [#7](https://github.com/vulle5/rails-log-reader/issues/7) made them routine — a clustered
Puma's workers, a rake burst alongside a live server — at which point the envelope offers no
way to order two events at all. `seq` restarts at 1 per Run, `at_mono` is a per-process clock,
and `at_wall` this ADR forbids sorting on. Ordering by `(run_id, seq)` does not dodge the gap,
it hides it: two Puma workers serving concurrently would render as two consecutive blocks of
traffic, and the rake burst as one slab above or below ten seconds of requests it was actually
woven through.

The resolution changes nothing on the wire. **Append order in the Sidecar is the Reader's
global ordering key**; `seq` orders events within a single request's timeline, where they
share a Run and it is exact. `O_APPEND` and ADR-0003's synchronous inline write make the byte
order a real total order across writers, and the Reader already tracks its file offset for
resumption — so this is not a new mechanism, it is noticing that the order it reads lines in
*is* the answer. The honest cost: append order is not observation order, so two processes can
swap by microseconds in the Console. Correcting that would need the cross-Run buffer ADR-0003
refused.

One consequence worth stating, because it removes a special case rather than adding a rule: a
request row sits at the append position of the **earliest event the Reader observed for it**,
not at its start time. For an ordinary request that is `request_start` and nothing changes;
for a *Partial request*, which by definition has no observed start, it is whichever child
arrived first. Every new row is therefore an append at the bottom and never an insert, which
is what makes "nothing ever reorders" true by construction under concurrency too.

### From #45 (a code reload mid-request): the request context leaves `CurrentAttributes`

The #14 amendment above gave the Initializer its own middleware, whose first job is to write
`request_id` into the Initializer's `CurrentAttributes`. That storage was the wrong one, for a
reason neither amendment could see from where it stood: `insert_after ActionDispatch::RequestId`
puts the middleware *above* `ActionDispatch::Reloader`, and Rails clears every
`CurrentAttributes` from `reloader.before_class_unload`. So on the first request after any edit
— a routine moment in a dev tool, and reliably the request the developer is watching most
closely — that reset landed in the middle of a live request instead of at its boundary. The row
lost its `request_id` halfway through, everything it emitted afterwards went to its *Run row*,
and it never got a `request_finish` at all: `duration_ms` subtracted the cleared start, raised a
`TypeError` inside the Initializer's own `guard`, and the finish was dropped in silence. The row
then sat *in-flight* for the rest of the session — and
[#27](https://github.com/vulle5/rails-log-reader/issues/27) exempts an in-flight row from
eviction under the *Memory bound*, which made it immortal.

No event moves and no field changes meaning. What changes is where the context lives, and one
field a finish may now leave off — which is a wire change, and carries a `WIRE_VERSION` bump
with it.

- **The request context moves to `ActiveSupport::IsolatedExecutionState`**, under a key of the
  Initializer's own. Not a new mechanism: a `CurrentAttributes` instance is *itself* kept there,
  and the Initializer already keeps its SQL start stack there — so this is the same
  per-execution-context storage under a key Rails does not clear. What it gives up is the
  automatic reset at the request boundary, and that is a real cost rather than a free win. A
  thread serves one request after another, so a `request_id` left behind on one would attribute
  the next request's events — and every unattributed line in between — to a request that is
  over. The Initializer therefore registers its own reset on `executor.to_complete`: the same
  callback chain Rails clears `CurrentAttributes` from, on a middleware that sits well above
  the Initializer's own and completes from the response body's close — so after the
  `request_finish` that closes the row, whether the request returned a response or raised.

  The *Trailing event* window this ADR described is not narrowed, and the reason is
  registration order. `to_complete` callbacks are `:before` kind, so they run in the order
  they were registered; Rails registers its `CurrentAttributes.clear_all` from a railtie
  initializer, which runs before `config/initializers/`. The Initializer's reset is therefore
  *later* in the chain than the clear it replaces, and the window is as wide as it was or
  wider — never shorter. What is new is that the boundary now depends on that order at all,
  which is worth knowing before anything else registers a `to_complete` that reads a
  `request_id`.
- **`duration_ms` becomes optional on the wire.** The backstop under the above, and worth having
  on its own: a finish is a fact about a request that ended, and the one field it cannot measure
  must not be able to take the whole event down with it — a missing start is also what a
  `run_end` mid-request would leave behind. Where the Initializer never saw a request start, the
  finish carries no duration at all: absence, as with `row_count`, and never a zero that would
  read as an instant request. The Reader shows such a row what it can prove instead — the
  distance in `at_mono` between the request's own first and last events, frozen, exactly as an
  *Interrupted* row reads — and shows nothing at all where it cannot prove even that, which is a
  *Partial request* whose finish carried no duration.
- **`WIRE_VERSION` goes to 2**, which is the first bump this file has taken. The rule it is
  bumped under is "when a field changes meaning", and `duration_ms` means what it always did
  when it is there — so the bump is for the reading half rather than the writing one. A Reader
  built before this amendment has `duration_ms: number` in its own copy of the contract and
  renders straight through the absence; `ms(undefined)` throws inside the row, which is not a
  blank cell but a dead table. That is exactly the case
  [#29](https://github.com/vulle5/rails-log-reader/issues/29) drew `isWireVersionUnderstood`
  for — "guessing through it is how a future field silently renders wrong" — and the bump is
  what gives that check something to see. The cost is named rather than dodged: an older
  Reader now refuses the whole Sidecar over one optional field, and refusing with #29's banner
  is the better of the two failures.

Moving the middleware below `ActionDispatch::Reloader` would have fixed the attribution loss in
one line and was refused: it trades away exactly what the #14 amendment bought, the request row
beginning on the same line of code as attribution, and reopens the band of middleware where a
request has a `request_id` and no row. The storage was the thing that was wrong, not the
position.

### From #47 (a raise above `ShowExceptions`): no response is an explicit absence

A request whose exception escapes the middleware stack still gets its `request_finish`, with
`status: null`, because the Initializer reads the status off what `@app.call` returned and on
that path nothing was returned. That is not the rare path it looks like: `Rails::Rack::Logger`
sits above `ShowExceptions` and `DebugExceptions`, and its `Started GET` line is where
`ActionDispatch::RemoteIp`'s lazy check runs — so a request carrying both `X-Forwarded-For` and
a disagreeing `Client-IP` raises there on default development settings, before routing.

This corrects the #14 amendment above, which named `IpSpoofAttackError` as the example of a
raise in the #55–#60 band with "no finish possible", resolving as **Interrupted**. It is not
in that band. `RemoteIp` only installs a lazy `GetIp`, and the check runs the first time
something asks for `request.remote_ip`, which is Logger's own `Started GET` line, after Logger
has started the handle whose finish closes the row. So that request does finish, from Logger's
`rescue Exception`. The hole the #14 amendment accepted still exists for a middleware in the
band that raises eagerly or answers without calling `@app`. It just no longer has this example.

- **`status` stays `null`.** Puma answers the client with a 500 of its own, but the Initializer
  never observes it, and another server may answer differently. A status it did not see would be
  one it made up — the same reasoning that left `duration_ms` absent rather than zero under #45.
  The field was already `number | null` in the contract, so nothing changes on the wire and
  `WIRE_VERSION` stays at 2.
- **The exception reaches the finish, read from `$!`.** `process_action.action_controller` is
  the only hand-off the Initializer had for an exception, and a request that never reached a
  controller never emits it. The Middleware cannot hand one over either: Logger emits the finish
  from its own `rescue Exception` and only then re-raises, so the raise reaches the Middleware
  after the finish is already written. Inside that rescue, `$!` is the exception. It is read only
  when there is no status, because a request that returned is not to be handed an exception its
  `BodyProxy` close merely happened to run beside.
- **The Reader shows `none` in the error colour** where a finished request has no status, so
  the cell cannot read as one that simply has nothing to say. The row's exception is in the
  *Detail column*, the same as any other.

### From #53 (`Rack::ConditionalGet`'s 304): `status` moves to controller time

`Rack::ConditionalGet` and `Rack::ETag` sit below the Initializer's own middleware in the
default stack — position 90–91 against `Middleware`'s `insert_after ActionDispatch::RequestId`
at 54 — so `Middleware`'s `@app.call(env)` wraps them both. On a client request carrying a
matching `If-None-Match`, which needs no `fresh_when`/`stale?` in the controller at all —
`Rack::ETag` digests a cacheable body into one for free — `ConditionalGet` swaps a controller's
200 for an empty 304 on the way back out, after `ActionController::LogSubscriber` has already
logged `Completed 200 OK` from `process_action.action_controller`'s payload. `Middleware` reads
the later of the two moments, so the row disagreed with development.log about a request that
never raised and rendered exactly what the controller asked for.

Same reasoning as #45's own amendment above: no event moves, and `status` is still
`number | null` — but which moment it names changes for a request that reached a controller,
and that is a meaning change from the reading half's side even though the field says what it
always did.

- **`Current` gains `controller_status`**, written from `process_action.action_controller`'s
  `payload[:status]` alongside the view/db runtime it already read off the same payload.
  `payload[:status]` is not only `response.status` on the ordinary path: this installed
  actionpack's `ActionController::Instrumentation#process_action` rescues whatever the action
  raises, maps it to a status with the same `ActionDispatch::ExceptionWrapper.
  status_code_for_exception` `ActionController::LogSubscriber` reads to print `Completed`, and
  stamps the payload with it before re-raising. So a raise inside a reached controller does
  not leave `controller_status` `nil` either — it ends up whatever development.log's own
  `Completed` line already claimed, matching it even though the exception goes on to escape
  the whole stack. `controller_status` is `nil` only where `process_action.action_controller`
  never fires at all: no controller was reached, and there was nothing to rescue.
- **`request_finish`'s `status` prefers `controller_status` over `Middleware`'s**, falling back
  to `Middleware`'s Rack-final one only for that no-controller-reached case. That is #47's own
  band, untouched: a routing failure or a raise above `ShowExceptions` never fires
  `process_action.action_controller`, so `controller_status` stays `nil` and the fallback is the
  only status there ever was. One #47 regression test moves out of that band as a result: a
  controller-reached exception forced past the whole stack with `show_exceptions: :none` used
  to read `status: null` under the old reasoning ("no response, so no status observed"), and
  now reads the mapped status instead — because development.log already said `Completed 404
  Not Found` for it, whether or not a response ever reached the client, and the row saying
  anything else was the bug this amendment exists to close.
- **`WIRE_VERSION` goes to 3.** A Reader built before this amendment has no reason to expect
  `status` to mean anything but the Rack-final moment, and while nothing here would make it
  render wrong the way an absent `duration_ms` once did, the rule this file bumps under is
  "when a field changes meaning" rather than "when a field could crash an older Reader" — and
  the moment `status` names is exactly what changed.
