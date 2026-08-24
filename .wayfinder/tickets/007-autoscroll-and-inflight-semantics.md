---
id: 007
title: Settle auto-scroll, ordering, and in-flight behaviour
type: grilling
status: open
parent: map
assignee:
blocked_by: [002, 004]
---

## Question

Auto-scroll is one of the two features the user named as essential, and it is far
subtler than it sounds once requests complete out of order.

Settled already: rows are ordered by request **start** time, and in-flight requests are
rendered and updated live rather than appearing only on completion. This ticket settles
what follows from that.

Decide:

- **What auto-scroll follows.** New requests appear at a stable position by start time,
  but an in-flight request higher up the list keeps growing as its queries arrive. Does
  the viewport follow the newest request, the most recently active one, or the bottom of
  the list? What happens when a request that started earlier is still emitting?
- **How the user escapes and returns.** Scrolling up must pause auto-scroll — decide how
  that is signalled and how the user resumes, and whether there is a "N new requests"
  affordance while paused.
- **Expansion under motion.** If the user has a request expanded and new events stream in
  above and below it, does the view hold that request steady? Does expansion pause
  auto-scroll implicitly?
- **When a request is declared dead.** A hanging request is the most valuable thing on
  screen; it is also indistinguishable from one whose finish event was lost. Decide the
  timeout, the visual treatment, and whether a late finish can revive it.
- **Clock skew and reordering.** What the Reader does with an event that arrives out of
  order relative to its ordering key — hold, insert in place, or append.

Grounded in whatever layout ticket 002 produced.
