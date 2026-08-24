---
id: 004
title: Define the event and attribution model
type: grilling
status: open
parent: map
assignee:
blocked_by: [001]
---

## Question

Nail the domain model that both halves of the system agree on — the wire contract
between whatever Rails emits and whatever the SPA renders. Use `/domain-modeling` and
update `CONTEXT.md` with the result.

Decide:

- **The event kinds and their fields.** Request start, request finish, SQL, app log —
  and whether request start/finish are two events or one mutable record. What each
  carries, and what is required vs. optional.
- **The ordering key.** *Dual-homing* means an app log event must interleave correctly
  with SQL events inside a request while also appearing in the global Console. Decide
  whether that ordering is by timestamp, by a monotonic per-process sequence, or both —
  informed by what ticket 001 found to be actually available.
- **Attribution edge cases.** What happens to an SQL query with no `request_id`
  (background job, console session, boot-time query). What happens to events that arrive
  for a request the Reader never saw start — because it was opened mid-flight, or the
  request began before the tool did. What happens to a request that never finishes:
  when, if ever, does the Reader give up and mark it dead?
- **Identity and stability.** Whether `request_id` alone is a sufficient key, or events
  need their own ids for deduplication if a source is re-read.
- **Versioning.** How the Rails-side initializer and the Reader agree on a schema version,
  given they are installed separately and will drift.

The output is a written schema precise enough that the Rails half and the TypeScript half
could be built by different agents without talking to each other.
