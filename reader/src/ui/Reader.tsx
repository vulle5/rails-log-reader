import type { ReactNode } from "react"

import type { RequestRow } from "../shared/activity"
import { ActivityTable } from "./ActivityTable"

/**
 * The Reader's three persistent columns. All three are present from the first paint and
 * are sized by the grid rather than by their contents, so filling one never reflows the
 * others — including the Detail column, which holds a placeholder until something is
 * selected rather than appearing when it is.
 *
 * The Activity table is present with no rows in it rather than absent until there are some,
 * for the same reason: the first request of the session must not be the thing that
 * introduces a header row and pushes the layout around.
 *
 * Rows are passed in rather than subscribed to here: the live Sidecar is `main.tsx`'s
 * business, which keeps this component mountable over a seeded fold.
 */
export function Reader({ rows = [] }: { rows?: readonly RequestRow[] }) {
  return (
    <div className="reader">
      <Column place="console" name="Console" />
      <Column place="activity" name="Activity table">
        <ActivityTable rows={rows} />
      </Column>
      <Column place="detail" name="Detail column">
        <p className="placeholder">
          Nothing selected — pick a row in the Activity table, or a line in the Console.
        </p>
      </Column>
    </div>
  )
}

type ColumnProps = {
  place: "console" | "activity" | "detail"
  /** The glossary's name for the column: what it is headed with, and what a screen reader announces. */
  name: string
  children?: ReactNode
}

function Column({ place, name, children }: ColumnProps) {
  return (
    <section className={`column column-${place}`} role="region" aria-label={name}>
      <header className="column-heading">
        <h2>{name}</h2>
      </header>
      <div className="column-body">{children}</div>
    </section>
  )
}
