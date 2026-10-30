import type { SqlEvent } from "../../../../shared/wire"
import type { Search } from "../../../hooks/search"
import { bindText } from "./format"

/**
 * How many matches of the current term a query's timeline entry lights, the same ones its
 * components light: its name, its statement matched whole, each bind as it is written (`NULL`
 * for a null), and its Callsite as the `↳ ` line it is shown as. A missing name or an empty
 * Callsite is not shown, so lights nothing. Its `CACHE` and `ASYNC` markers and its duration
 * are the Reader's own words, never matched.
 */
export function queryMatches(search: Search, event: SqlEvent) {
  const { name, sql, binds, callsite } = event.payload
  return (
    (name === null ? 0 : search.find(name).length) +
    search.find(sql).length +
    binds.reduce<number>((count, bind) => count + search.find(bindText(bind)).length, 0) +
    (callsite === undefined || callsite === "" ? 0 : search.find(`↳ ${callsite}`).length)
  )
}
