import { useLayoutEffect, useRef, type CSSProperties } from "react"

import type { Candidate, CandidateKind } from "../../../../shared/repl"
import { cn } from "../../../lib/cn"
import { rowId } from "./InputHistoryList"

/** A kind's mark, and what it stands for, which the row's title says. */
const KINDS: Record<CandidateKind, { glyph: string; named: string }> = {
  method: { glyph: "ƒ", named: "method" },
  constant: { glyph: "C", named: "constant" },
  local: { glyph: "x", named: "local variable" },
  ivar: { glyph: "@", named: "instance variable" },
  cvar: { glyph: "@@", named: "class variable" },
  gvar: { glyph: "$", named: "global variable" },
  keyword: { glyph: "k", named: "keyword" },
  symbol: { glyph: ":", named: "symbol" },
  path: { glyph: "/", named: "file" },
}

/**
 * The completion popover: the candidates for the word under the caret, headed by what they
 * were asked of when `receiver` says, each with a mark for its kind. It is drawn at `place`, the
 * word's start, its bottom edge on that line, and takes no focus: the prompt keeps it, and names
 * the selected row as its active descendant. `selected` is `-1` while none is chosen.
 */
export function CompletionList({
  id,
  receiver,
  candidates,
  selected,
  place,
  onPick,
}: {
  /** Prefixes the row ids, which `rowId` names. */
  id: string
  receiver: string | null
  candidates: readonly Candidate[]
  selected: number
  /** Where the word starts, in pixels from the corner of the prompt's input. */
  place: { left: number; top: number }
  onPick: (candidate: Candidate) => void
}) {
  const chosen = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    chosen.current?.scrollIntoView?.({ block: "nearest" })
  }, [selected, candidates])

  // At the word rather than the caret, so it holds still as the word grows. Held inside the
  // input's box by its left edge, and by the drawer's height, which the container sizes.
  const position: CSSProperties = { left: `max(0px, min(${place.left}px, calc(100% - 18rem)))`, top: place.top }

  return (
    <div
      className="absolute z-10 flex max-h-[min(12rem,calc(100cqh-5.5rem))] w-72 -translate-y-full flex-col overflow-hidden rounded-md border border-outline bg-raised shadow-dialog"
      style={position}
    >
      {receiver !== null && <p className="flex-none truncate border-b border-border px-2 py-1 font-mono text-xs text-muted">{receiver}</p>}
      <div
        className="min-h-0 overflow-auto py-0.5 [scrollbar-width:thin]"
        role="listbox"
        id={id}
        aria-label={receiver === null ? "Completions" : `Completions for ${receiver}`}
      >
        {candidates.map((candidate, index) => (
          // The colour of each kind's mark, read off its `data-kind`.
          <div
            className={cn(
              "group flex cursor-pointer items-center gap-2 px-2 py-0.5 font-mono text-sm",
              index === selected ? "bg-selected shadow-pinned" : "hover:bg-sunken",
            )}
            key={candidate.text}
            id={rowId(id, index)}
            role="option"
            aria-selected={index === selected}
            data-kind={candidate.kind}
            title={KINDS[candidate.kind].named}
            ref={index === selected ? chosen : undefined}
            // The click would take the prompt's focus, which is what reads the keys.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(candidate)}
          >
            {/* The mark is drawn from `data-glyph` and is no text: the row reads as its candidate, and
                its kind is what its title describes. */}
            <span
              className={cn(
                "min-w-0 flex-auto truncate before:mr-2 before:inline-block before:w-4 before:text-center before:font-sans before:text-xs before:text-faint before:content-[attr(data-glyph)]",
                "group-data-[kind=method]:before:text-accent",
                "group-data-[kind=constant]:before:text-sql-identifier",
                "group-data-[kind=keyword]:before:text-sql-keyword",
                "group-data-[kind=symbol]:before:text-sql-placeholder",
              )}
              data-glyph={KINDS[candidate.kind].glyph}
            >
              {candidate.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
