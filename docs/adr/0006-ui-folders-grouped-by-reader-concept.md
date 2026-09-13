# `reader/src/ui` is grouped by Reader concept, not by React role

`reader/src/ui` had grown flat to 24 files with no subfolders, which the codebase's own React-shaped
expectations (`components/`, `hooks/`, `lib/`) don't fit either — `sql-highlight.ts` and `grouping.ts`
are pure functions but domain-specific, not generic utilities, so a plain `lib/` bucket would dilute
into "stuff that isn't a component." `CONTEXT.md` and `reader.css`'s own section comments already
split the UI along *Console*, *Activity table*, and *Detail column* — vocabulary the codebase already
uses, not one invented for this restructure.

We grouped by that vocabulary instead: one `features/<concept>/` folder per Reader concept (`console`,
`activity-table`, `detail-column`, plus `setup-status` for the not-installed/not-enabled/idle
onboarding UI, which is cohesive but isn't one of the three columns), each with its own
`components/hooks/lib`. Primitives genuinely shared across ≥2 features (`Chip`, `format`, `theme`,
`auto-scroll`, `search`, `live`) stay in a root `ui/components|hooks|lib`. Composers that reach across
features (`Reader.tsx`, `HoverGrouping.tsx`) stay as bare files at `ui/` root rather than living inside
`components/`, so that folder keeps meaning "reusable primitive," not "anything at the top level."

Scope is `ui/` only — `reader/src/shared` and `reader/src/server` are flat too, but at 5-6 files each
there's no evidence flat is hurting them yet, so they're left alone. `reader.css` is untouched;
splitting it is #74's job, not this one.

## Considered options

- **Conventional React layout** (`components/`, `hooks/`, `lib/` with no domain folders) — rejected:
  the codebase's own domain-specific pure functions don't sort cleanly into a generic `lib/`.
- **Pure domain-concept grouping with no root shared layer** — rejected: `search.tsx`/`Chip.tsx`/etc.
  are used by design across ≥2 features, and forcing them into one feature folder or duplicating them
  would misrepresent them as feature-owned.
