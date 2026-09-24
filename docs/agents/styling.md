# Reader styling

Tailwind classes are written where they apply: in the element's `className`, as a string
literal or as arguments to `cn` (`reader/src/ui/lib/cn.ts`). The classes you read on an
element are all of its classes, and the editor completes them where you type.

1. **A static class list is a plain string.** However long; `cn` may split it into groups
   by purpose, each with a comment if it needs one.
2. **A condition goes inside `cn`**: `cn("px-2", selected && "bg-selected")`, or a ternary
   between two literals.
3. **A look used twice is a component**, private to its file until a second feature needs
   it (then `ui/components/`). When a caller adds to its look, it takes a `className` and
   passes it last to `cn`, so the caller's class replaces a conflicting one of its own.
4. **A colour keyed by a `data-*` attribute lives in the component that writes the
   attribute** (`MethodText`), or that reads it off its `group` (`LevelText`).
5. **A class's explanation is a `{/* */}` comment above the element**, or the component's doc.
6. **A new name in `@theme` that `cn` must tell apart from another** — a radius, a shadow, a
   leading — is added to `cn.ts` and `test/cn.test.ts`.

See `docs/adr/0012-styles-are-tailwind-utilities-on-the-element-they-style.md`.
