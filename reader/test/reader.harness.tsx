import type { ComponentProps } from "react"
import { render, screen, within, type Matcher } from "@testing-library/react"
import userEvent, { type UserEvent } from "@testing-library/user-event"

import { activityTable, type ActivityRow } from "../src/shared/activity"
import { consoleStream } from "../src/shared/console"
import { latchRunIdentity, type RunIdentity } from "../src/shared/run-identity"
import type { Envelope } from "../src/shared/wire"
import { Reader } from "../src/ui/Reader"

/**
 * The Reader's UI tests, mounted through one seam: `Reader` over folds seeded from envelopes,
 * exactly what `main.tsx` hands it from a live Sidecar — so what a test renders is what the
 * file would actually produce, and never a second shape of it.
 */

export type ReaderProps = ComponentProps<typeof Reader>

/**
 * Both folds and the *Run identity*, fed one batch at a time the way `useSidecar` feeds them
 * per `EventSource` message — and handing out exactly what `main.tsx` hands `Reader`. Batches
 * matter wherever a test cares about the order things arrive in: the *Memory bound* only
 * evicts at the end of one.
 */
export function aFold() {
  const activity = activityTable()
  const stream = consoleStream()
  // Cumulative, the way `useSidecar` counts it — `WireStatus.evictedRows`.
  let evictedRows = 0
  let identity: RunIdentity = null

  return {
    fold(batch: readonly Envelope[]) {
      const evicted = activity.fold(batch)
      stream.fold(batch)
      stream.evict(evicted)
      evictedRows += evicted.length
      identity = latchRunIdentity(identity, batch)
    },
    /**
     * What a *load-earlier* pull puts in: history from before everything the fold holds, so
     * its rows open above them. The Console is not given it, for the reason `useSidecar` does
     * not give it either — the Console is append order, and this belongs before the lines it
     * already has. It can still evict, which the Console does hear about.
     */
    foldEarlier(batch: readonly Envelope[]) {
      const evicted = activity.foldEarlier(batch)
      stream.evict(evicted)
      evictedRows += evicted.length
    },
    /** Fresh arrays every read, the way a live `useSidecar` render passes them. */
    get props(): ReaderProps {
      return {
        rows: [...activity.rows],
        lines: [...stream.lines],
        evictedRows,
        railsRoot: identity?.railsRoot ?? null,
      }
    },
    get rows(): readonly ActivityRow[] {
      return activity.rows
    },
    get identity(): RunIdentity {
      return identity
    },
  }
}

export type Folded = ReturnType<typeof aFold>

/** A fold with `batches` already in it. */
export function folded(...batches: readonly (readonly Envelope[])[]): Folded {
  const fold = aFold()
  for (const batch of batches) fold.fold(batch)
  return fold
}

/** The Reader over `envelopes` as one batch, and a user to drive it with. */
export function openTheReader(envelopes: readonly Envelope[] = [], props: ReaderProps = {}) {
  return openTheReaderOver(folded(envelopes), props)
}

export function openTheReaderOver(fold: Folded, props: ReaderProps = {}) {
  const user = userEvent.setup()
  const view = render(<Reader {...fold.props} {...props} />)
  return { user, fold, ...view }
}

// ---- finding things -----------------------------------------------------------------

export function column(name: "Console" | "Activity table" | "Detail column") {
  return screen.getByRole("region", { name })
}

/** The Activity table's rows, heading row excluded. */
export function activityRows() {
  const [, body] = within(within(column("Activity table")).getByRole("grid")).getAllByRole("rowgroup")
  if (body === undefined) throw new Error("the Activity table has no body")
  return within(body).queryAllByRole("row")
}

/** The row with a cell reading exactly `text` — a request's path, or a Run row's kind. */
export function rowShowing(text: string) {
  const found = activityRows().find((row) => within(row).queryByText(text) !== null)
  if (found === undefined) throw new Error(`no Activity table row shows ${text}`)
  return found
}

/** A Request row's cell under the column heading `heading`. */
export function cellUnder(row: HTMLElement, heading: string) {
  const headings = within(column("Activity table")).getAllByRole("columnheader")
  const at = headings.findIndex((each) => each.textContent === heading)
  const cell = within(row).getAllByRole("cell")[at]
  if (cell === undefined) throw new Error(`the row has no cell under ${heading}`)
  return cell
}

export function tab(name: string) {
  return screen.getByRole("tab", { name: new RegExp(`^${name}`) })
}

export function consoleLines() {
  return within(within(column("Console")).getByRole("list")).queryAllByRole("listitem")
}

export function lineSaying(text: string) {
  const found = consoleLines().find((line) => line.textContent?.includes(text))
  if (found === undefined) throw new Error(`no Console line says ${text}`)
  return found
}

export function chip(name: string, group: string) {
  return within(screen.getByRole("group", { name: group })).getByRole("button", { name })
}

/** The Detail column's own timeline — not the trailing section's, which is a list of its own. */
export function timeline() {
  return within(column("Detail column")).getByRole("list", { name: "Timeline" })
}

/** A list's own items, and none of the items of the lists inside them. */
export function itemsOf(list: HTMLElement) {
  return within(list)
    .queryAllByRole("listitem")
    .filter((item) => item.parentElement === list)
}

/** A timeline entry is a query when it holds a statement, and a log line when it does not. */
export function isQuery(entry: HTMLElement) {
  return within(entry).queryByRole("code") !== null
}

/** Every stretch the search lit inside `element`, as the text it lit, in document order. */
export function lit(element: HTMLElement) {
  return within(element)
    .queryAllByRole("mark")
    .map((mark) => mark.textContent)
}

/**
 * The innermost element whose whole text is `text`, across whatever elements it is split
 * into — a Callsite line is a `↳`, an openable `path:line` and the method after it.
 */
export function wholeText(text: string): Matcher {
  const says = (element: Element) => element.textContent === text
  return (_, element) => element !== null && says(element) && [...element.children].every((child) => !says(child))
}

// ---- doing things -------------------------------------------------------------------

/** Selects the row showing `text`, the way a developer does: by clicking it. */
export async function select(user: UserEvent, text: string) {
  const row = rowShowing(text)
  await user.click(row)
  return row
}

/** Rails' own lines start hidden, so a test about them has to ask for them first. */
export async function showRails(user: UserEvent) {
  await user.click(chip("rails", "Filter by source"))
}

export async function search(user: UserEvent, term: string) {
  const box = screen.getByRole("searchbox")
  await user.clear(box)
  // `{` and `[` open a key descriptor in `user.type`; doubled, each is the character itself.
  if (term !== "") await user.type(box, term.replaceAll("{", "{{").replaceAll("[", "[["))
}

/** Folds the Console into its strip, by its own collapse button. */
export async function collapseConsole(user: UserEvent) {
  await user.click(within(column("Console")).getByRole("button", { name: "Collapse Console" }))
}

/** Reopens a *Collapsed Console*, by the strip that is its one button. */
export async function expandConsole(user: UserEvent) {
  await user.click(within(column("Console")).getByRole("button", { name: "Expand Console" }))
}
