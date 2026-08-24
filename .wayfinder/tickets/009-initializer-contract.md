---
id: 009
title: Write the copy-paste initializer contract for the work app
type: task
status: open
parent: map
assignee:
blocked_by: [005]
---

## Question

The MVP is only reached when the user can point the Reader at their real Rails 8 work
app. That happens through exactly one artifact: a file a teammate can read, understand,
and approve in a pull request in under a minute.

Produce:

- **The canonical initializer file** implementing whatever ticket 005 chose, written to
  be read by a skeptical colleague — short, commented, no metaprogramming games, no
  monkey-patching that would alarm a reviewer.
- **The opt-in mechanism.** Confirm and implement the env-var gate so the file is fully
  inert for developers who never set it. Verify inertness: with the flag unset, no extra
  subscribers, no extra file handles, no measurable request overhead, and
  `log/development.log` byte-identical to what it was before the file existed.
- **Install documentation** — where the file goes, what to add to `.gitignore` if the
  chosen architecture writes a sidecar, what to set to enable it, and how to confirm it
  is working.
- **The uninstall path** — deleting one file leaves no trace.
- **A stated compatibility range**, with Rails 7 behaviour explicitly either supported or
  documented as unsupported, per ticket 001's findings.

This is a *task* ticket: the work is mechanical once ticket 005 lands, but no
implementation of the Reader can be validated against the real work app until it exists.
