# Wayfinder tracker (local-markdown)

No issue tracker was configured for this repo, so the map lives here as files.

- `map.md` — the map. Labelled `wayfinder:map`. Load this first, every session.
- `tickets/NNN-slug.md` — child tickets. Frontmatter carries `type`, `status`,
  `assignee`, and `blocked_by`.

## Operations

**Frontier** (what's takeable now) — open, unassigned tickets whose every `blocked_by`
entry is `status: closed`:

```sh
grep -L 'status: closed' .wayfinder/tickets/*.md
```

then check each one's `blocked_by` ids against the closed set.

**Claim** — set `assignee:` in the ticket's frontmatter *before* doing any work.

**Resolve** — append a `## Resolution` section to the ticket body, set `status: closed`,
and add a one-line pointer to the map's *Decisions so far*.

If this repo later adopts GitHub Issues or Linear, each file becomes an issue and
`blocked_by` becomes a native dependency edge.
