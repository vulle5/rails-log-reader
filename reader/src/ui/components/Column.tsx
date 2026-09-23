import type { ReactNode } from "react"

import type { ColumnAutoScroll } from "../hooks/auto-scroll"

/**
 * One of the Reader's three columns: a heading, and a body that is the column's scrollport.
 *
 * Code that finds a column or its scrollport in the DOM — the auto-scroll jump, *Hover
 * grouping* — finds it by `data-column` and `data-scrollport`. The class names are styling
 * only; nothing looks an element up by one.
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
  /** This column's own *auto-scroll*: the scrollport it follows, and what the pill says. */
  scroll: ColumnAutoScroll
  children?: ReactNode
}

export function Column({ place, name, controls, scroll, children }: ColumnProps) {
  return (
    <section className={`column column-${place}`} role="region" aria-label={name} data-column={place}>
      <header className="column-heading">
        <h2>{name}</h2>
        {controls}
      </header>
      <div className="column-body" data-scrollport ref={scroll.port} onScroll={scroll.onScroll}>
        {children}
      </div>
      {/* Only where there is something to go and see. A pill on a paused column with nothing
          below it would read "0 new" — sending the reader to look at nothing, and covering
          the lines they scrolled up to read while it did. Scrolling back down is the way out
          of a pause either way; the pill is what the count is for. */}
      {!scroll.following && scroll.unseen > 0 && (
        <button type="button" className="new-pill" onClick={scroll.resume} title="Follow new activity again">
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
