# rails-log-reader

A web-based reader for Ruby on Rails development logs, plus an example Rails app used to
test it. See `CONTEXT.md` for the domain glossary and standing constraints.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `vulle5/rails-log-reader`, driven via the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root, ADRs under `docs/adr/`.
See `docs/agents/domain.md`.

### Comments

Code comments document behavior, not history. See `docs/agents/comments.md`.

### Testing

Reader UI tests query by accessibility through React Testing Library. See `docs/agents/testing.md`.

### Styling

Reader Tailwind classes live in `className`, joined by `cn`. See `docs/agents/styling.md`.
