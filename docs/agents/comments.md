# Code comments

A comment documents non-obvious **behavior** — an invariant, a gotcha, something the code
does that a reader can't get from reading it. It never documents rationale or history.

Rationale lives in exactly one place, and a comment never restates or cites it:

- **ADR** (`docs/adr/`) — decisions that are hard to reverse, surprising, and a real
  trade-off.
- **`CONTEXT.md`** — domain-glossary terms.
- **The commit message** — everything else, including bug fixes.

No raw GitHub issue numbers, ADR file paths, or commit SHAs in code. `git blame` is how a
reader reaches a line's history; a citation string in a comment is a second copy of it.

Applies to every file in this repo, `reader/rails/rails_log_reader.rb` included — it
travels without `CONTEXT.md` or `docs/adr/`, but gets no exception for that.

See `docs/adr/0007-comments-document-behavior-not-history.md`.
