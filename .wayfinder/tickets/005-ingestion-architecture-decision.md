---
id: 005
title: Decide how the Reader receives correlated Rails log events
type: grilling
status: open
parent: map
assignee:
blocked_by: [001, 004]
---

## Question

**The load-bearing decision of this map.** The user named it as the choice that most
determines whether the project succeeds, and explicitly declined to settle it from a
recommendation without research behind it.

The constraint that rules out the obvious answer: `log/development.log` must stay
byte-for-byte as readable as it is today, because collaborators who don't use the Reader
will keep using `tail -f`. `log_bench` fails exactly here — it swaps in a JSON formatter
and the file becomes unreadable to humans.

Weigh at least these, against ticket 001's findings:

- **(a) Tag-only, parse the human log.** Set `config.log_tags = [:request_id]` and
  `config.active_record.query_log_tags`. The file stays readable — lines gain an
  `[a1b2c3]` prefix. The Reader parses Rails' standard text output. Cost: a text-parsing
  layer that must track Rails' format across versions.
- **(b) Sidecar structured file.** An initializer broadcasts a second stream to
  `log/development.jsonl`. `development.log` is untouched. `ActiveSupport::BroadcastLogger`
  (Rails 7.1+) makes "same events, two sinks, different formats" first-class rather than
  a hack. Cost: a second file, and a `.gitignore` entry.
- **(c) Live socket.** A subscriber pushes events over a socket or HTTP to the Reader.
  Nothing on disk, nothing to parse. Loses history on restart — the user judged
  "the tool must be running" acceptable, so this is a genuine rival, not a fallback.
- **(d) Hybrid.** Subscriber emits to a socket when the Reader is listening and falls
  back to a sidecar file when it isn't.

Judge each against: `development.log` untouched; opt-in per developer via env var so
non-users notice nothing; installable as a single copy-paste initializer, no gem; Rails 8
(Rails 7 a bonus); emits in-flight request state, not just completions; supports the
ordering key that *dual-homing* requires; history on open is nice-to-have, not required;
and behaviour when the Rails process and the Reader start in either order.

Record the decision, the rejected options, and the reason each lost — this is the choice
future sessions will be most tempted to relitigate.
