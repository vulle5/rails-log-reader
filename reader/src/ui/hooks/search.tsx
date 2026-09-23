import { createContext, useContext, useMemo, type ReactNode } from "react"

/**
 * The Reader's one search: a case-insensitive substring, matched over the text the Reader
 * renders — Console lines, SQL, paths, `Controller#action` — and lit wherever it is found.
 *
 * It **highlights and never hides**. v1 rules out filtering the Activity table by anything
 * but row kind, and a text box that thinned rows or lines would be that exclusion coming back
 * through the one control nobody would think to check it against. So nothing here decides
 * what is shown; it only marks what already is. For the same reason there is no regex, which
 * is a query language, and no next/prev, which is navigation — a term goes in and every
 * occurrence lights, and that is the whole feature.
 *
 * The term reaches what renders text through context rather than props, because "everywhere
 * text is rendered" is three columns deep and a prop threaded through every one of them
 * would be a second copy of the component tree's shape.
 */

/** One occurrence: `[start, end)` in the text it was found in. */
export type Match = readonly [number, number]

export type Search = {
  /** Every occurrence of the term in `text`, left to right, never overlapping. */
  find: (text: string) => readonly Match[]
}

const NOTHING: readonly Match[] = []

const NOT_SEARCHING: Search = { find: () => NOTHING }

export const SearchContext = createContext<Search>(NOT_SEARCHING)

/**
 * The term compiled once per keystroke rather than once per rendered string — a busy Reader
 * renders thousands of them. A pattern and not a lowercased `indexOf`, because lowercasing
 * can change a string's length (`"İ"` lowercases to two code units) and every offset after
 * such a character would then light the wrong letters. The term is escaped whole: the
 * pattern is how the match is made, never a language the developer is given.
 */
export function useSearch(term: string): Search {
  return useMemo(() => {
    if (term === "") return NOT_SEARCHING

    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
    return {
      find(text) {
        const found: Match[] = []
        for (const match of text.matchAll(pattern)) found.push([match.index, match.index + match[0].length])
        return found
      },
    }
  }, [term])
}

/** The occurrences of the current term in `text`. */
export function useMatches(text: string) {
  return useContext(SearchContext).find(text)
}

/** `text`, with every occurrence of the current term marked. */
export function Highlight({ text }: { text: string }) {
  return <Marked text={text} matches={useMatches(text)} />
}

/**
 * `text` with `matches` marked, where `text` is the stretch of some longer string that
 * begins at `from` — which is how one statement split into SQL tokens is lit across the
 * tokens rather than inside each: the matches are found once on the whole statement, and
 * every token marks its own share of them. Never edits: the pieces put the text back
 * together character for character, marks or no marks.
 */
export function Marked({ text, from = 0, matches }: { text: string; from?: number; matches: readonly Match[] }) {
  if (matches.length === 0) return text

  const pieces: ReactNode[] = []
  const end = from + text.length
  let at = from

  for (const [start, stop] of matches) {
    if (stop <= at || start >= end) continue

    const lit = Math.max(start, at)
    if (lit > at) pieces.push(text.slice(at - from, lit - from))

    const unlit = Math.min(stop, end)
    pieces.push(
      // Lit, never hidden: a background under the characters that matched, and nothing done to
      // anything that did not. Inheriting the colour is what keeps a matched keyword a keyword.
      <mark key={lit} className="rounded-xs bg-match text-inherit">
        {text.slice(lit - from, unlit - from)}
      </mark>,
    )
    at = unlit
  }
  if (at < end) pieces.push(text.slice(at - from))

  return pieces
}

type SearchBoxProps = {
  term: string
  onChange: (term: string) => void
}

export function SearchBox({ term, onChange }: SearchBoxProps) {
  // The placeholder keeps the browser's own grey, which Preflight would replace.
  return (
    <input
      type="search"
      className="w-80 max-w-full rounded border border-border bg-raised px-2 py-0.75 font-mono text-sm text-foreground placeholder:[color:revert] focus:outline-2 focus:-outline-offset-1 focus:outline-accent/50"
      placeholder="Search"
      aria-label="Search — highlights every match, hides nothing"
      title="Highlights every match, hides nothing"
      spellCheck={false}
      value={term}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}
