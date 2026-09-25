import type { ReactNode } from "react"

import type { ColumnAutoScroll } from "../hooks/auto-scroll"
import { cn } from "../lib/cn"

/**
 * One of the Reader's three columns: a heading, and a body that is the column's scrollport. An
 * outlined panel, floating on the backdrop behind the columns: the Console in the backdrop's
 * own fill, the other two lighter.
 *
 * `data-column` says which column an element is, and `data-scrollport` marks its body: what
 * *Hover grouping* and its jump find a column and its scrollport by.
 */

export type ColumnPlace = "console" | "activity" | "detail"

/** Every column's scrollport, or — given a place — that one column's. */
export function scrollportSelector(place?: ColumnPlace) {
  return place === undefined ? "[data-scrollport]" : `[data-column="${place}"] [data-scrollport]`
}

type ColumnProps = {
  place: ColumnPlace
  /** The glossary's name for the column: what it is headed with, and what a screen reader announces. */
  name: string
  /**
   * What sits in the heading beside the name — the Activity table's row-kind tabs and the
   * Console's level chips. In the heading and not in the body, because the body is the
   * scrollport: a filter that scrolled away with the rows it was filtering would be gone
   * exactly when it is wanted.
   */
  controls?: ReactNode
  /** A control for the column itself, at the right end of the heading: the Console's collapse button. */
  action?: ReactNode
  /** This column's own *auto-scroll*: the scrollport it follows, and what the pill says. */
  scroll: ColumnAutoScroll
  children?: ReactNode
}

export function Column({ place, name, controls, action, scroll, children }: ColumnProps) {
  // `min-h-0` for the same reason as `min-w-0`: a grid item's automatic minimum size is its
  // content, so without it a column would overflow the track the grid constrained it to and
  // hand the overflow back to the page.
  return (
    <section
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border",
        place === "console" && "bg-sunken",
        place === "activity" && "bg-background",
        place === "detail" && "bg-raised",
      )}
      role="region"
      aria-label={name}
      data-column={place}
    >
      <header
        className={cn(
          "flex min-h-7.5 flex-none flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-1",
          action !== undefined && "@container",
        )}
      >
        <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">{name}</h2>
        {action === undefined ? (
          controls
        ) : (
          <>
            {/* One row — name, controls, action — once the heading is wide enough for the
                Console's name, chips and collapse button side by side (27rem). Narrower, the
                action stays on the name's row and the controls take a row of their own, so
                the chips keep the full width rather than wrapping beside the button. */}
            <div className="order-3 flex min-w-0 basis-full @min-[27rem]:order-2 @min-[27rem]:ml-auto @min-[27rem]:basis-auto">
              {controls}
            </div>
            <div className="order-2 flex @min-[27rem]:order-3">{action}</div>
          </>
        )}
      </header>
      {/* The scrollport is also what the sticky headings inside the column stick against; without
          one of its own they would stick to the window's. The gutter is reserved whether or not
          the content needs a scrollbar yet, so the Detail column does not narrow under the
          reader the moment a Selection first gives it something to scroll. Arbitrary properties,
          because Tailwind 4.1 has no scrollbar utilities. */}
      <div
        className="min-h-0 flex-auto overflow-auto [scrollbar-gutter:stable] [scrollbar-width:thin]"
        data-scrollport
        ref={scroll.port}
        onScroll={scroll.onScroll}
      >
        {children}
      </div>
      {/* Only where there is something to go and see. A pill on a paused column with nothing
          below it would read "0 new" — sending the reader to look at nothing, and covering
          the lines they scrolled up to read while it did. Scrolling back down is the way out
          of a pause either way; the pill is what the count is for.

          Positioned against the column and not its scrollport, so it stays put while the rows
          it is counting move underneath, and appears without pushing them around. */}
      {!scroll.following && scroll.unseen > 0 && (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 z-2 -translate-x-1/2 cursor-pointer rounded-full bg-accent px-2.5 py-0.75 text-xs text-background tabular-nums shadow-pill hover:bg-accent-hover"
          onClick={scroll.resume}
          title="Follow new activity again"
        >
          {/* `floor`: the Memory bound is evicting one row for every row it takes, so the
              count below has stalled rather than stopped — "+" says so rather than reading
              like a number that quietly froze. */}
          <span aria-hidden="true">↓</span> {scroll.unseen}
          {scroll.floor ? "+" : ""} new
        </button>
      )}
    </section>
  )
}
