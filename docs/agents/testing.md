# Reader UI tests

UI tests render through React Testing Library and reach the Reader the way a user or a
screen reader does. `reader/test/preload/` registers happy-dom, `cleanup` and the jest-dom
matchers once for the whole suite, so a test file holds tests and nothing else.

1. **Query by accessibility.** `*ByRole`, then `*ByLabelText`, then `*ByText`. An element
   with no accessible handle gets the missing ARIA in the Reader's source — only what the UI
   already conveys visually. A visual category with no ARIA meaning (request method, status
   class, log level, host frame, Rails-sourced line, chip off, Hover grouping's lit/pinned)
   is a `data-*` attribute the Reader styles on; assert that attribute. Class names and
   `container.querySelector` are markup, and stay out of tests.
2. **Query through `screen`**, narrowing with `within` to a region, row or dialog.
3. **`const user = userEvent.setup()` before `render`, and `await` every interaction.**
   `fireEvent` only for an event user-event cannot produce, with a comment naming it.
4. **`findBy*` to wait for an element.** `waitFor` holds one assertion and no side effects.
5. **`queryBy*` only to assert absence.**
6. **`render`, user-event and `fireEvent` already run inside `act`.** A manual `act` is for a
   non-DOM update (a stubbed OS theme change, a clock) with nothing to wait for.
7. **An act warning in the output is a failing test**, though the runner passes it.
8. **jest-dom matchers** — `toHaveAttribute`, `toBeDisabled`, `toHaveTextContent`,
   `toHaveAccessibleName` — over reading properties or attributes by hand.
9. **Setup lives in the preload.** A test file registers no DOM and runs no cleanup of its own.
