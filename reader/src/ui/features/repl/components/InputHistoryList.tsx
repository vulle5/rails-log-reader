import { useLayoutEffect, useRef } from "react"

import { cn } from "../../../lib/cn"
import type { HistoryEntry } from "../lib/input-history"
import { RubyCode } from "./RubyCode"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The *Input history* as a list over the *Transcript*, oldest at the top so the newest is
 * nearest the prompt. It is drawn above whatever holds it and takes no focus: the prompt
 * keeps it, and names the selected row as its active descendant.
 *
 * Each row is an entry's first line as Ruby, `+N lines` when it has more, `raised` when it did,
 * and when it ran. Above the first entry of every console process but `pid` is an
 * `earlier console · pid N` divider, and above the first of `pid`'s own, when entries of an
 * earlier console come before it, is a `this console · pid N` divider, so where one ends and
 * the other begins is marked. `filter` is what the developer has typed to narrow it, and
 * `entries` are already narrowed by it.
 */
export function InputHistoryList({
  id,
  entries,
  filter,
  selected,
  pid,
  onPick,
}: {
  /** Prefixes the row ids, which `rowId` names. */
  id: string
  entries: readonly HistoryEntry[]
  filter: string
  /** The index into `entries` of the row that Enter or Tab would pick. */
  selected: number
  /** The console process running now, whose entries need no divider. `null` when none is. */
  pid: number | null
  onPick: (entry: HistoryEntry) => void
}) {
  const now = Date.now()
  const chosen = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    chosen.current?.scrollIntoView?.({ block: "nearest" })
  }, [selected, entries])

  return (
    // The container is sized by the drawer's body, so the list never outgrows the room over the prompt.
    <div className="absolute bottom-full left-2 z-10 mb-1 flex max-h-[min(14rem,calc(100cqh-5.5rem))] w-[min(36rem,calc(100%-1rem))] flex-col overflow-hidden rounded-md border border-outline bg-raised shadow-dialog">
      <p className="flex-none border-b border-border px-2 py-1 text-xs text-muted">
        History {filter === "" ? <span className="text-faint">— type to filter</span> : <span className="font-mono text-foreground">“{filter}”</span>}
      </p>
      <ul className="min-h-0 overflow-auto py-0.5 [scrollbar-width:thin]" role="listbox" aria-label="Input history">
        {entries.map((entry, index) => {
          const [first = "", ...more] = entry.input.split("\n")
          const before = entries[index - 1]
          const introduced = entry.pid !== pid && before?.pid !== entry.pid
          const resumed = entry.pid === pid && before !== undefined && before.pid !== pid

          return (
            <li key={entry.input} role="presentation">
              {introduced && <div className="border-t border-border px-2 pt-0.5 text-[0.6875rem] text-faint">earlier console · pid {entry.pid}</div>}
              {resumed && <div className="border-t border-border px-2 pt-0.5 text-[0.6875rem] text-faint">this console · pid {entry.pid}</div>}
              <div
                className={cn(
                  "flex cursor-pointer items-start gap-2 px-2 py-0.5 font-mono text-sm",
                  index === selected ? "bg-selected shadow-pinned" : "hover:bg-sunken",
                )}
                id={rowId(id, index)}
                role="option"
                aria-selected={index === selected}
                ref={index === selected ? chosen : undefined}
                // The click would take the prompt's focus, which is what reads the keys.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(entry)}
              >
                <span className="min-w-0 flex-auto truncate whitespace-pre">
                  <RubyCode source={first} />
                  {more.length > 0 && <span className="ml-2 font-sans text-xs text-faint">+{more.length} lines</span>}
                </span>
                {entry.raised && <span className="flex-none font-sans text-xs text-error">raised</span>}
                <span className="flex-none font-sans text-xs text-faint">{ago(now - entry.at)}</span>
              </div>
            </li>
          )
        })}
        {entries.length === 0 && (
          <li className="px-2 py-1 text-xs text-faint" role="presentation">
            Nothing matches.
          </li>
        )}
      </ul>
    </div>
  )
}

/** The id of the row at `index` of the list whose id is `id`, which the prompt names as its active descendant. */
export function rowId(id: string, index: number) {
  return `${id}-${index}`
}

/** How long ago, as the history says it: `ms` since an entry ran. */
function ago(ms: number) {
  if (ms < MINUTE) return "just now"
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  const days = Math.floor(ms / DAY)
  return days === 1 ? "yesterday" : `${days}d ago`
}
