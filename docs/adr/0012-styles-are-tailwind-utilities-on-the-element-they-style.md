# Styles are Tailwind utilities on the element they style

`reader.css` had grown to one hand-written stylesheet of ~1,600 lines covering every part of
the Reader, so a component's look lived a long way from the component, and any rule could
reach any element. We replaced it with Tailwind v4, written **utility-first**: a style lives as
classes on the element it styles, and a component is the unit of reuse. No `@apply`, and no
semantic class names — nothing reads them, so none are left. The only global CSS is what CSS
itself cannot scope: the theme tokens, the `dark` variant's binding, and base
`html`/`body`/`#root` styles.

**The two themes differ in token values and nowhere else.** Every colour is a semantic token in
`@theme` (`bg-sunken`, `text-muted`, `text-method-post`), overridden under
`[data-theme=dark]` — the same attribute the inline script in `index.html` sets before the first
paint and `theme.tsx` keeps after, neither of which changed. A component never names its dark
colour, so it cannot forget one. `dark:` is rebound to `data-theme` so a stray use obeys the
developer's choice rather than the OS's, and is otherwise not used.

**Uniformity is enforced by absence.** Tailwind's default palette is removed (`--color-*:
initial`), so `bg-blue-500` does not compile and every colour stays themed; the type scale is
replaced by the handful of sizes the Reader uses; the 4px spacing scale is kept. An arbitrary
value (`py-[3px]`) is allowed only where the exact number carries meaning, with a comment
saying why. State the UI already expresses as a `data-*` attribute — method, status, level,
host frame — stays that attribute and is styled with a data variant; those attributes, not
classes, are what tests and the DOM lookups read.

**The Reader is started through a launcher.** Tailwind reaches Bun's HTML bundling through
`bun-plugin-tailwind`, registered in the Reader's `bunfig.toml` — compiled as the page is served,
the same way in development and production, so ADR-0001's "no build step" holds. But Bun reads
`bunfig.toml` from the working directory, and the Reader is always started from inside the Host
app: launched as `bun …/src/server/index.ts`, the plugin silently never loads and the Reader
serves uncompiled CSS with no error. So `bun dev`, `bun start` and the README all start it through
one launcher script that passes `--config` pointing at the Reader's own `bunfig.toml`. Running
the server file directly is not a supported way to start the Reader.

**`tailwindcss` is pinned to the version the plugin bundles.** `bun-plugin-tailwind` ships its own
Tailwind compiler (4.1.14 in 0.1.2, its latest release) but resolves `@import "tailwindcss"` —
Preflight and the default theme — from the installed `tailwindcss` package, which the stylesheet
test also compiles with. Two versions mix into one stylesheet with no error, and utilities newer
than the bundled compiler compile to nothing in the Reader while passing in the test. So the
dependency is pinned exactly, and a command test fails when the served stylesheet's compiler and the
installed package disagree. Upgrading Tailwind means waiting for a plugin release that bundles
the newer compiler, and moving both together.

## Considered options

- **Tailwind with `@apply`** in per-feature stylesheets — rejected: keeps styles away from the
  markup that uses them, which was the problem, and adds a dependency on top.
- **Splitting `reader.css` per feature folder, no Tailwind** — rejected: smaller files, same
  distance between a component and its look, and rules still global.
- **`dark:` variants per element** (`bg-white dark:bg-…`) — rejected: every component carries
  both themes, and forgetting the dark half is silent.
- **Passing `--config` in the scripts only** — rejected: the old `bun …/index.ts` command would
  keep working and serve an unstyled Reader.
- **The server re-executing itself with `--config`**, or **compiling Tailwind itself** through
  its Node API — rejected: a process managing a copy of itself, or code tracking Tailwind's
  internals and losing CSS hot reload, to avoid one launcher script.
