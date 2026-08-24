---
id: 001
title: What can Rails 8 tell us about a request, and through which hooks?
type: research
status: open
parent: map
assignee:
blocked_by: []
---

## Question

Pure fact-finding. Before we can choose an ingestion architecture, we need an accurate
inventory of what a Rails 8 process can be made to emit, and when.

Establish:

1. **The `ActiveSupport::Notifications` surface.** Which events fire for an HTTP
   request (`start_processing.action_controller`, `process_action.action_controller`,
   `sql.active_record`, and any others relevant), what payload fields each carries, and
   critically **when** each fires — specifically whether anything fires at request
   *start*, or only on completion. In-flight display is a hard requirement, so if no
   start event exists, identify what does mark a request's beginning.
2. **Request id availability.** How `request_id` is generated, where it lives
   (`ActionDispatch::RequestId`, `ActiveSupport::CurrentAttributes`), and whether it is
   reliably readable from inside an `sql.active_record` subscriber under concurrent
   requests. Puma runs multi-threaded — confirm the propagation is thread-safe and
   survives into whatever executes the query.
3. **Capturing bare `Rails.logger` calls.** How to intercept arbitrary
   `Rails.logger.info/debug/warn` calls from application code, attribute them to the
   current request when there is one, and stamp them with an ordering key that
   interleaves correctly with SQL events from the same request. Cover
   `ActiveSupport::BroadcastLogger` (Rails 7.1+), custom `Logger` subclasses, and
   `ActiveSupport::TaggedLogging`.
4. **Ordering.** What timestamp resolution is available, and whether timestamps alone
   are sufficient to order events within a request or a monotonic sequence counter is
   needed. See *dual-homing* in `CONTEXT.md`.
5. **Rails 7 delta.** Which of the above differ or are absent on Rails 7.x. Rails 8 is
   the target; Rails 7 is a nice-to-have, so this is about sizing the gap, not solving it.

Deliver a written inventory with code-level specifics and citations. Do **not** pick an
architecture — that is a separate decision ticket.
