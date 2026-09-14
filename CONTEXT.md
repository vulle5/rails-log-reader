# Context

A web-based reader for Ruby on Rails development logs. Two projects, one repo: the
reader tool, and an example Rails app tailored for testing it.

## Glossary

**Reader** — the tool being built. A local Bun process that serves a React + TypeScript
SPA and streams Rails log events to it. Never deployed; never remote. See
`docs/adr/0001-bun-is-the-runtime.md`.

**Example app** — a Rails 8 app living in this repo purely to exercise the Reader. Not
the product: its purpose is to *emit* Events, not to be used. It is a test fixture in the
plain sense of the word, but never call it "the fixture" — Rails already owns that word
for `test/fixtures/*.yml`, and the Example app has seed data of its own.
_Avoid_: fixture (as a name), demo app, sample app.

**Initializer** — the Rails half of the product: one Ruby file the developer copies into
their Host app's `config/initializers/`, where Rails runs it once at boot. It hooks Rails
and forwards Events to the Reader. Distributed by copy-paste, not as a gem.
_Avoid_: plugin, agent, shim.

**Marker file** — `log/rails_log_reader.enabled`, the git-ignored file whose *presence*
turns the Initializer on. Content is never read: presence is the whole gate, so `touch`
is the entire act of enabling and the file never becomes a config file. Read once, at
boot, so enabling needs a restart. Chosen over an env var because the Host app runs under
puma-dev — there is no shell to export from, and a variable is per terminal, so it would
miss the `rake` and `rails c` Runs. Never created by the Reader, which only ever reads the
Host app's files. See `docs/adr/0004-a-marker-file-gates-the-initializer.md`.
_Avoid_: flag file, lock file, config.

**Host app** — the user's real Rails 8 application at their job. The Reader must work
against it with only the Initializer added, opt-in per developer. Its display name, shown in
the Reader's tab title and `reader-bar` header, is the wire's own `app_name` — the first
`run_header`'s, latched for the rest of the session and never reconsidered against a later
Run — unless `RAILS_LOG_READER_APP_NAME` overrides it, which always wins. See
`docs/adr/0009-the-app-name-override-is-a-reader-side-env-var.md`.

**Event** — a single thing the Rails process emitted. Three kinds in v1:
- **Request event** — an HTTP request. Has a start and a finish; is *in-flight* between them.
- **SQL event** — one database query, attributed to a request.
- **App log event** — one `Rails.logger.*` call, whoever made it. The developer's own and
  Rails' own alike, kept and labelled apart by a `source` of `app` or `rails` rather than
  one of them dropped: `Started GET` is all a request that died before reaching a
  controller ever says about itself. Which one it is, is read from `caller_locations` —
  a frame inside a gem is not the developer — and never from the message's shape.

**Scenario** — a named, reproducible traffic pattern the Example app generates on demand:
parallel in-flight requests, an N+1-shaped request, a slow query, a request that hangs, a
rake-task query burst. Triggered from the Example app's own `/scenarios` page or by `curl`
against the same endpoint. A Scenario is a *shape of traffic*, never a feature of the
Reader — the Reader detects nothing and is never told which Scenario is running.
_Avoid_: test, demo, case.

**Attribution** — binding an SQL or App log event to the Request event it occurred
within, via `request_id`. The core problem: with parallel requests, an unattributed log
is unreadable.

**Unattributed** — an event with no owning request (boot lines, background jobs, rake
tasks). Not dropped, and no longer homeless: its *Run* owns it, so it appears in that
Run's *Run row*, and — if it is an App log event — in the *Console* as well.

**Run** — one boot-to-shutdown lifetime of the Rails process. Every Event belongs to
exactly one Run. In development a Run is short: any restart of `rails s` ends one and
begins the next. Ordering keys and elapsed times are only comparable *within* a Run, so
the Reader treats a Run boundary as a visible event, not a seam to hide.

**Ordering key** — what puts every Event of a Run into one true order, including across
kinds: a sequence number taken at the moment the Rails process *observes* the Event, not
when the Event completes. Because observation happens inline on the request thread, this
reproduces causal order by construction. See *dual-homing* for why a `request_id` alone
cannot do this. Exact *within* a Run and meaningless across Runs — it restarts at 1 in
every process — so it orders a request's own timeline and nothing wider. See *append
order* for what orders the rest.

**Partial request** — a Request event the Reader pieced together without having observed
its start, because the Reader attached mid-flight or started after the request did. It is
promoted as its finish arrives, gaining method, path, status and duration — and stays
Partial until its own **load-earlier** pull turns up the `request_start` it missed, because
that is the one thing that changes what the mark actually records: not "the Reader never
saw this," but "the Reader does not currently hold this." A pull that reaches back far
enough clears it outright — the events are recovered, not lost, and a mark that kept saying
otherwise would be false in the one direction this project never allows itself, even the
safe one. Distinct from *unattributed*: a Partial request's children are correctly
correlated; it is the parent that was missed.
_Avoid_: orphan, stub, inferred.

**Interrupted request** — a Request event whose Run ended before it finished: the process
was reaped, restarted or killed while the request was still in flight. Concluded from
evidence — a `run_end`, or a `run_header` bearing a new `run_id` — never from a timer, since
in-flight requests are given no timeout, ever. The mirror of a *Partial request*: that one
missed a start, this one will never get a finish.

Only a header of kind `server` concludes it, and only for the *other* Runs: `rails s` and
puma-dev each run one process in development, so a second server booting is a restart —
while a `rake` task, a `rails c` session or a Sidekiq worker boots beside a server that
keeps serving, and `unknown` is the kind the Initializer declined to classify, which is not
a thing to conclude a restart from. A forked Puma worker cannot fire it either: it inherits
a boot that already happened and writes no header of its own. And a `request_finish` that
arrives afterwards takes the row back, because the inference was that a Run had ended and
the finish is the file saying outright that it had not.
_Avoid_: dropped (a *dropped event* is a volume concern and unrelated), abandoned, cut off.

**Dual-homing** — an App log event appears in *two* places at once: inline within its
owner's timeline in the *detail column*, interleaved in emission order with that owner's
SQL events, and in the global *Console* stream. True of **every** App log event, not just
attributed ones — an unattributed line is dual-homed against its *Run row* exactly as an
attributed one is against its request. This is why every event needs an **ordering key**,
not just a parent id: a `request_id` alone cannot interleave logs with queries.
The one qualification is the *Echo*, which is homed in the Console alone.

**Echo** — an App log event that is ActiveRecord's own rendering of an SQL event the
Reader already holds. Rails logs every query twice by design: once through
`sql.active_record`, which is where the structured SQL event comes from, and once as a
`debug` line for `development.log` to print. The *detail column* shows the SQL event and
drops the Echo — the same query said again and worse, with no binds, no row count, a
rounded duration and no highlighting — while the *Console*, being the log, keeps it. An
Echo is recognised by **containment**: a `rails`-sourced line holding the previous query's
SQL verbatim. Never by the message's shape, and never further back than the query directly
before it, because Rails writes the line there and then. What that deliberately cannot
prove, it leaves alone: the `↳` callsite `verbose_query_logs` prints under a query is the
one thing in those two lines the SQL event does not carry, and it stays.

**Console** — a dev-tools-style stream of every App log event its owning row still holds,
attributed or not, in *append order*. Rendered as the **Console rail**, the leftmost of the
Reader's three columns. **App log events only** — never SQL, attributed or not. The Console
exists so that a `Rails.logger` call you wrote is findable and one click from the request
that ran it; queries outnumber log lines and would bury it. Every line is clickable and
sets *Selection*.

Bounded by the *Memory bound*, and by nothing of its own: a line's retention is exactly its
owning row's, so the moment that row is evicted, the line goes with it. Until #44 the
Console read the envelope stream independently of `activityTable` and outlived every row's
eviction — one honest fact (a `Rails.logger` call you wrote never disappearing) sitting on
top of one dishonest one (a click on an old line landing on a row the fold no longer had, a
gutter rule pointing at nothing). Tying the two folds' retention together was cheaper than
giving the Console a second, independently-counted bound, and keeps "one number, not two"
literally true: there is still exactly one ring, and the Console's memory is derived from
it rather than counted again.

Volume is a **level** and **source** problem, never an attribution one, and the two chip
groups that thin it start from opposite ends because the failure they prevent is the same
one arriving from two directions. All levels show by default: a floor above `debug` would
hide the developer's own calls. Rails' own lines are hidden by default: in a real dev app
they *are* the log — `Started GET`, `Processing by`, `Rendering`, `Completed 200 OK`, and
an *Echo* under every query — so a rail that opens on them buries the handful you wrote
just as surely. Both settings persist, and both are remembered as what is *off*, so a
level the Reader has not met yet arrives shown.

Hidden is never dropped, which is what keeps this a filter rather than the decision the
*App log event* entry refuses. The fold holds every line whatever the chips say, the
*Detail column* renders Rails' own inline with the request's queries regardless, and one
chip brings them back into the rail. `Started GET` is still all a request that died before
reaching a controller ever says about itself — it is one click away rather than in the way.
The rail says so rather than thinning quietly: the `rails` chip wears the struck-through
"off" mark from the first paint, because a Console silently not showing what it holds is
indistinguishable from a broken one.

**In-flight** — a Request event that has started but not finished. Must be visible and
must accumulate its SQL and App log events live. A request that hangs is the single
most valuable thing to see — and is *not a separate state*: because in-flight requests
are given no timeout, ever, the Reader has no threshold to declare a hang. A climbing
elapsed time is the entire signal, and the human draws the conclusion. In-flight ends
only in a finish or in *Interrupted*.

The elapsed is *proven* up to the last event the Reader saw for that request — a distance
within one Run's own `at_mono`, the one clock two events may be subtracted across — and
carried from there by the browser, because a hanging request emits nothing, which is exactly
when the number matters. It is carried from where the proof was taken: the `at_wall` that
last event landed with, plus the time the local clock has counted since. So a request that
had been hanging for ten minutes when the Reader opened says ten minutes, rather than the
fraction of it the file happens to cover — the one case the number exists for, and the one an
anchor taken at load would get wrong.

This is the **one place `at_wall` is subtracted**, and the rule it keeps is the real one:
never against another `at_wall`. Two of them are two processes' opinions, an NTP step apart
in either direction, which is why nothing is ever ordered by them. One of them against the
local clock is a different question — *how long ago was this line written* — asked on the one
machine that wrote it and is reading it, which is the whole premise of a strictly local tool.
Display-grade by construction, and exposed only for the stretch since the last event:
everything the file covers is measured in `at_mono` and immune. A *Partial request* has no
elapsed until a start turns up for it, having nothing to measure from.

**Sidecar** — `log/rails_log_reader.jsonl`, the append-only file the Initializer writes one
Event per line to and the Reader tails. The transport between the two halves, and the only
file the product creates. Rails' generated `.gitignore` already covers it. Never confused
with `log/development.log`, which the Reader only ever leaves alone. See
`docs/adr/0003-a-sidecar-jsonl-file-is-the-transport.md`.

**Memory bound** — the Reader's bounded in-memory fold of *Activity table* rows: a ring
buffer that evicts the oldest rows once exceeded, sized to match the load-on-open figure
(the last ~5,000 events, read backward from EOF over the file offset the Reader already
tracks) so there is one number, not two. Counted in **events** and evicted by whole
**rows**, which is what makes it match the figure it is named by: the fold opens holding
exactly the history that backward scan delivered, and one Run row carrying an all-day
worker's output is bounded by the same number a table full of requests is — while a row
that had half its queries taken away would be a count of 24 beside a timeline showing
three, so a row leaves whole or it stays.

Three things this bound will not take, settled by #44 as three separate refusals rather
than one leaky rule. A request still *in flight* is never evicted — there is no timeout,
ever, and a bound that took the hanging request away once five thousand events had gone
past it would be one, measured in other people's traffic; an *Interrupted* row evicts like
any other, having been concluded. (The one gap this leaves: a forked Puma worker writes no
`run_header` of its own and so can never be *Interrupted*, so a request stuck inside a
worker that was killed without a clean restart stays unevictable forever. Known, named, and
left alone rather than given a timer of its own — a timer here is the rule this bound exists
to refuse, wearing a different name.) What a **load-earlier** pull brought in is never
evicted either, and the ceiling it raises never comes back down — the bound is on what the
Reader accumulates by itself, and history the developer went and asked for that evaporated
under the next request to arrive would make the control useless; a developer clicking it
often enough for that to matter is its own natural limit, so nothing further bounds it. Nor
is the one row left standing, and that is where this bound stops being one: a `rake` burst
larger than the figure lands in a single Run row — the ordinary way here, though a lone
Request row with more queries than the figure earns the same mark the same way — and
emptying the table is worse than exceeding the number, so the row stays whole, however far
over the figure it runs, and says so rather than going quiet about it: the row standing over
the bound carries a visible mark that it is holding more than the usual bound, never the
word "trimmed," because nothing in it was.

Forgetting is bounded too, on both sides of it. The bound remembers which requests it has
evicted — kept to the same figure — so a *Trailing event* arriving for one reads as
*unattributed* rather than opening a bogus *Partial request*; that memory is itself capped
to the figure, so a Trailing event arriving five thousand evictions later **does** open a
fresh row, honestly rather than by accident. See *Run row* for the mirror case on the Run
side, which is not remembered as evicted at all.

Doubles as the attribution horizon: a finished request stops accepting *Trailing events*
the instant its row is evicted. Reachable past load-on-open only through the explicit
**load-earlier** control above, which continues the same backward scan — no infinite
scroll, no silent fetch. A live request reset mid-Run by boot-time truncation gets no extra
signal; it surfaces as an ordinary *Partial request*, which already reads honestly on its
own.

The *Console* is bounded by this too, and by nothing of its own — see that entry. See
`docs/adr/0003-a-sidecar-jsonl-file-is-the-transport.md` and
`docs/adr/0005-the-memory-bounds-exemptions-and-the-consoles-retention.md`.

**Trailing event** — an SQL or App log event whose `seq` places it *after* its request's
`request_finish`. Attribution is not in doubt — the `request_id` is right there — only the
position is. The Reader appends it to a visibly separate **trailing section** at the end of
the request row, never silently inside the timeline, because a log line arriving after its
request finished is genuinely surprising and hiding it would read as a Reader bug. There is
no time limit and no buffering: the row accepts trailing events for as long as the Reader
still holds it, and once the row is evicted under the *Memory bound* the event is simply
*unattributed*. Positional, never temporal — "late" would imply a clock, and `at_wall` is
never sorted on. Structurally rare: the request boundary is the Initializer's own middleware,
so almost nothing can outlive it. See
`docs/adr/0002-the-event-envelope-and-ordering-key.md`.
_Avoid_: late arrival, straggler, orphan.

**Append order** — the position of a line in the *Sidecar*, and the Reader's global
ordering key. `seq` restarts at 1 per Run and `at_mono` is a per-process clock, so when
Runs overlap — clustered Puma workers, a rake burst beside a live server — neither can
order two Events against each other, and `at_wall` is never sorted — nor ever subtracted
from another `at_wall`, its one use as a distance being the *In-flight* elapsed's join to the
local clock. One file opened
`O_APPEND` with synchronous inline writes makes byte order a real total order across
every writer. Not observation order: two processes can swap by microseconds, accepted
rather than buffered away.
_Avoid_: arrival order, wire order (the wire has no order of its own).

**Activity table** — the middle of the Reader's three columns, one row per thing that
owns events: a *Request row* or a *Run row*. A row sits at the append position of the
earliest Event the Reader observed for it, so a new row is always an append at the bottom
and never an insert — including a *Partial request*, which has no start to be positioned
by. Rows mutate in place and never move. Tabs filter by **row kind only** — Requests,
Runs, All, each carrying a count — never by method, status or controller, which v1 rules
out; a tab that grows one of those is that exclusion returning and must be decided, not
drifted into.
_Avoid_: request table (it holds more than requests), trace (promises spans and sampling
that are not shipped), feed.

**Request row** — an *Activity table* row for one Request event.

**Run row** — an *Activity table* row holding everything a *Run* emitted with no owning
request. One per Run, always, anchored at that Run's marker — a `rake` burst and a worker
process still alive at the end of the day get the same rule, and no gap threshold splits
either, because a threshold is the timer this project refuses everywhere else. Opened by the
Run's `run_header`, or by the first unattributed event of a Run whose header the Reader never
saw; a Run that emitted nothing unattributed at all — a forked Puma worker, which inherits a
boot and writes no header — has no row, because there is nothing for one to hold. The
division of labour with the *Console*: the Console is where you read **when** something
happened, the Run row is where you read **what**. Groups by *process*, never by job —
every job a worker ever ran lands in one undifferentiated row, which is precisely why
this is not the first-class background-job grouping v1 rules out.

Never remembered as evicted — a Run still running has every right to another row — so a Run
whose row the *Memory bound* took can open a second one, header-less, the next time it says
something unattributed. Marked `reopened` rather than left to read exactly like a Run the
Reader only ever attached inside: those are different facts, and #44 is why they stopped
sharing one look.

**Run marker** — the boundary the *Activity table* draws on a *Run row* where that Run's
`run_header` landed. It means literally *this Run started here*, and never *everything below
belongs to it*: a `rake` burst and a live server write into one file, so the rows under a
marker are as likely to be another Run's. Drawn only for a Run that serves requests — the
same evidence that makes an *Interrupted request*, since a restart is exactly the boundary a
marker is for — so a `rake` or `rails c` Run gets a Run row without one, and so does a Run
the Reader attached inside, because a boundary nobody witnessed is not one to draw. Because
the marker is the only thing the table says about which process wrote what, no row carries a
Run tag of its own. Drawn only on a row the header itself opened: where a Run's row was
already open — the Reader having seen that Run say something before its header reached it —
the boundary belongs above rows the marker would then sit below, so none is drawn.
_Avoid_: separator, divider, restart banner.

**Detail column** — the rightmost of the Reader's three columns, showing one selected
row's timeline: its SQL and App log events in `seq` order — *Echoes* excluded — the
exception it raised if it did — backtrace full and uncleaned, gem frames collapsed by
default — and its *trailing section*.
Pinned once opened, so selecting never reflows the layout. Renders what the Initializer
emitted and nothing derived from it: SQL is never reformatted, and a field the wire had to
cut says so where it is read rather than passing as whole.

`SCHEMA` and `EXPLAIN` queries are hidden by default too, for the mirror-image reason the
Console's `rails` chip is: `ActiveRecord::LogSubscriber::IGNORE_PAYLOAD_NAMES` drops them
before `development.log` is ever written to, while `SqlSubscriber` forwards them
anyway — the rare "why was the first request after a restart the slow one" question only
the dropped ones answer. One chip brings them back, persisted the same way the Console's
chips are. Hidden is never dropped: the timeline still holds every one, and a hidden query
is one click away rather than in the way of the ordinary request beside it.

A backtrace collapses gem frames by default for the same reason: a real exception's trace
is mostly framework internals, and scanning past forty of them to find the three that
matter is exactly the noise this column exists to cut. Frames outside `isHostFrame`'s
`railsRoot` prefix collapse into an inline "N frames hidden" marker at their position in
the trace — never one marker for the whole thing, because call order is the one fact a
stack trace exists to carry, and flattening it to a single blob would erase which frame
called which. The raised frame — `backtrace[0]`, Ruby's own guarantee of where an
exception happened — stays visible whatever its Host-app status; collapsing away the raise
site by the same rule that hides `ActiveSupport`'s dispatch chain would defeat the column
on its most common case, a `NoMethodError` or `RecordNotFound` several frames inside a gem.
A marker's reveal is one-way and unpersisted: clicking opens its frames for the rest of
that render, and the next render of any exception starts fully collapsed again — no
toggle, nothing survives a reload. A trace with no Host-app frame at all (including while
`railsRoot` is still unknown) is just one marker spanning everything but the raised frame;
the exception's class and message above it are never hidden by this. *Search* reaches into
a collapsed marker exactly as it reaches everywhere else it renders text: a match inside
one force-opens it, because a hidden gap Search silently couldn't find would be the one
place in this column that promise quietly didn't hold. Independent throughout of the cut a
wire-truncated backtrace records: collapsing describes what the Reader chooses to show of
what it holds, cutting describes what the wire sent, and neither reads the other.

**Selection** — which *Activity table* row the *detail column* is showing. Set by clicking
a row in the *Activity table*, or any line in the *Console* — including an unattributed
one, which selects its *Run row*. If a tab filter hides the row being selected, the click
clears that filter first: click means "take me there", and taking you to a row you cannot
see is a broken promise. Purely a detail-column concern: selecting never pauses the
Activity table, because you must scroll up to click a moving row anyway, and that scroll
has already paused it.

**Hover grouping** — hovering a *Console* line draws a gutter rule from that line to its
*Activity table* row. Clicking pins the group lit and jumps: the table scrolls to the row
(clearing a hiding tab filter first, if that's why it's hidden), because clicking means
"take me there" and neither a filter nor a scroll position should be able to break that
promise. Pinning exists because the lit group is lost the moment the mouse moves, and
moving the mouse is exactly what you do next.

The rule assumes both ends are on screen, and at real volume — 58 rows, 145 console
lines — the row usually isn't: it runs to a stub captioned "row is off screen — click to
jump" instead of connecting. Built and measured, not argued away: at low volume the rule
connects and reads fine; it degrades only at the volume the Console exists for, and a
click dissolves the case rather than leaving it dangling. Per-request **colour coding**,
**dimming** the non-matching lines, and **scrollbar markers** (ticks showing every
occurrence, including off screen) were all built and rejected — colour collides long
before a busy dev app runs out of requests, dimming makes everything else unreadable
exactly when you are hovering constantly, and markers tell you *that* something is
elsewhere without letting you read the connection to it.

**Auto-scroll** — a column following new activity: stuck to the bottom, so whatever arrives
is on screen the moment it does. There are three, one per column, and they share the rule and
nothing else — scrolling the *Console* back to find a boot line says nothing about whether the
*Activity table* should keep following new traffic, and pinning a hanging request in the
*Detail column* says nothing about either.

**Scrolling up is the only gesture that pauses one**, and reaching the bottom again is the
only thing that resumes it — silently, because that is the gesture the developer already
expects. Everything else is deliberately neither: *Selection* is not (you had to scroll up to
click a moving row anyway, and that scroll has already paused it), a tab filter and a level
chip are not, and a Run boundary is not — a restart may not yank a reader away from what they
were reading. One rule and no second, hidden pause state, which is a promise about what the
Reader does *not* do rather than a feature it has.

*Hover grouping*'s jump is the one place a column is moved for you, and it is not an exception
to the rule but the plainest case of it: the jump scrolls the *Activity table* to the row, and
where the port ends up is read like any other scroll — so landing on a row above the fold
pauses the table exactly as scrolling to it by hand would. That is the click's doing and not
the selection's, and it is what you wanted: a table that snapped back to the bottom after
taking you somewhere would not have taken you anywhere.

A paused column counts what has arrived below and offers the count as a floating "↓ N new"
pill, which resumes on click. The count is the point of the pill — it is what says when to
stop reading and look — so it counts what the column is *showing*: a line a level chip is
hiding is not something scrolling down would reveal. A chip going off or on is not arrivals at
all, the list having been re-derived rather than appended to, so nothing is counted for it and
what was already counted stands. Neither is chased further than that: a count that stayed
exact across a narrowing list would need a second record of what the reader has already been
shown, which is a second source of truth about the same question — and the number is a prompt
to go and look, not a ledger. With nothing new below there is no pill: "0 new" would send
a reader to look at nothing, over the lines they scrolled up to read.

Neither is a **load-earlier** counted. Its control sits at the top of the *Activity table*,
so reaching it has already paused that column, and the history it prepends went *up* rather
than arriving below — a pill offering to take the reader down to it would be pointing the
wrong way. Under the *Memory bound* the number would otherwise be a silent undercount: a
fold at its cap evicts a row for every row it takes, so the length it is read from stands
still while traffic keeps running past underneath — a paused reader told nothing is
arriving. Rather than let an exact-looking count freeze (#44), the pill switches from a
count to a floor once the column is at the cap — "5,000+ new" rather than a number that has
quietly stopped moving — which costs nothing beyond what the seam above already costs: it
is the same "prompt to go and look, not a ledger" trade, admitted where it applies rather
than worn silently.

All three open pinned to the bottom of the loaded history. The *Detail column* is the one that
starts following again on its own, whenever *Selection* changes — another row's timeline is a
different thing to be at the bottom of, rather than the same stream thinned. Its own SCHEMA
chip is the same stream thinned, exactly the case a Console chip already is, so toggling it
never refollows on its own — only a new Selection does.
_Avoid_: follow mode, tail, live/paused toggle (there is no control to toggle — the scrollbar
is the control).

**Search** — one global, case-insensitive substring, typed once and lit wherever the Reader
renders log text: *Console* lines, SQL, paths, `Controller#action`, and the rest of what the
*Detail column* reads out of an Event. It **highlights and never hides**: v1 filters the
*Activity table* by row kind and nothing else, and a text box that thinned rows or lines would
be that exclusion returning through the one control nobody would think to check it against.
So it is not a filter, it reaches no *Auto-scroll*, and it has neither a regex — a query
language — nor next/prev — navigation. A match is found on the text as rendered, so SQL is
matched whole and lit across the highlighter's own tokens, and never edited to do it.
_Avoid_: filter, find (implies stepping through matches).

**Empty state** — what an *Activity table* with no rows says about why, told apart by reads of
the two fixed-contract paths alone: **not installed** (no Initializer), **not enabled** (no
*Marker file*), or **idle** (both present, nothing written yet). Each names the one command
that resolves it, and they chain — copy the Initializer in, `touch` the Marker file, restart
Rails — because the last step writes a `run_header`, which is a row, which ends the state. Said
only once the load-on-open history has all arrived, so a Sidecar with rows on the way never
flashes a cause it is about to take back; and re-read when the Reader's window regains focus,
since the command is always run somewhere else.

## Standing constraints

1. **`log/development.log` stays pristine.** A collaborator running `tail -f` must see
   exactly what they see today. This is the defining failure of `log_bench`, which
   replaces the Rails logger with a JSON formatter and makes the file unreadable.
2. **Opt-in per developer.** Inert unless explicitly enabled by a *Marker file*. A
   teammate who never uses the Reader notices nothing — which means, precisely: no
   middleware inserted, no subscribers registered, no `BroadcastLogger` sink attached, no
   file opened. Those four are promises the Example app tests; request overhead is not.
3. **Strictly local.** No remote, staging, or production log reading.
4. **Rails 7.1+**, refused below. `BroadcastLogger#broadcast_to` is both the only
   capture mechanism that keeps constraint 1 and the one thing Rails 7.0 lacks. Rails 8
   is what gets tested; 7.1 and 7.2 are accepted, with their absent `sql.active_record`
   fields treated as absent rather than as an error. Development environment only.
5. **Dark and light mode** both required. The OS's by default, a remembered override
   otherwise, and set before the first paint — so the Reader never opens on a frame of the
   wrong one.
