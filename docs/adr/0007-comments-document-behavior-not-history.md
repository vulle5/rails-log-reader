# Comments document behavior, not history

Code comments had drifted into the same dense, narrative voice as `CONTEXT.md` and the
ADRs — citing GitHub issue numbers as load-bearing rationale, restating trade-offs already
recorded elsewhere, sometimes running longer than the code change beside them. Settled in
[#69](https://github.com/vulle5/rails-log-reader/issues/69), split from
[#34](https://github.com/vulle5/rails-log-reader/issues/34).

A code comment documents non-obvious **behavior** only — an invariant, a gotcha, something
the code does that isn't apparent from reading it. It never restates rationale or history.
Rationale lives in exactly one of three places, and a comment never cites or duplicates any
of them:

- An **ADR**, for decisions that are hard to reverse, surprising, and the result of a real
  trade-off — the existing bar, applied sparingly.
- **`CONTEXT.md`**, for domain-glossary terms.
- **The commit message**, for everything else, including ordinary bug fixes.

No raw GitHub issue numbers, no ADR file paths, no commit SHAs appear in code. `git blame`
is how a reader reaches a line's history; a citation string copied into a comment is a
second copy of that history, and one that can rot across a rebase or squash-merge in a way
`git blame` against the current tree cannot.

This narrows **code comments only** — `CONTEXT.md` and the ADRs (including this one) keep
the voice they already have. Their whole job is holding this reasoning; the review pain
this settles is specifically about diffs being a third comments, not about reading the
glossary.

Applies uniformly across the repo, including `reader/rails/rails_log_reader.rb` — the one
file that leaves the repo by copy-paste into a Host app's `config/initializers/`. It gets
no exception: not a longer leash for travelling without `CONTEXT.md`/`docs/adr/`, and not a
shorter one for landing in someone else's codebase.

## Considered options

- **Keep citing issues or commits inline as a cheap footnote** for decisions too small for
  a full ADR. Rejected: this is the direct cause of tying comments' meaning to whichever
  issue tracker is in use, which [#34](https://github.com/vulle5/rails-log-reader/issues/34)
  already named as unwanted.
- **Apply the same terseness to `CONTEXT.md` and the ADRs.** Rejected: those documents exist
  specifically to hold this reasoning; collapsing them into the same rule as code comments
  would just move the verbosity problem, not solve it.
- **A hard length or density ceiling** (max lines per comment, a comment:code ratio).
  Rejected in favor of the behavior/history split above — once a comment can't restate
  rationale, there's usually nothing left long enough to need a ceiling.

## Consequences

- The files already flagged in [#69](https://github.com/vulle5/rails-log-reader/issues/69)
  get swept to the new standard as a dedicated follow-up, rather than left to convert
  opportunistically.
- The standard is written down for agents at `docs/agents/comments.md`, linked from
  `AGENTS.md`.
