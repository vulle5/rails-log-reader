import { useMemo } from "react"

import { Marked, type Match } from "../../../hooks/search"
import { cn } from "../../../lib/cn"
import { tokenizeRuby } from "../lib/ruby-highlight"

/**
 * Ruby drawn in the highlighter's colours, as a run of spans whose text is exactly `source`.
 * Every kind keeps the font's own weight and slant, so the prompt's highlighting lines up with
 * the textarea over it glyph for glyph. An identifier and the plain text between tokens take
 * the colour around them.
 *
 * `matches`, found on the whole of `source`, are lit across the tokens, each token marking its own
 * share, so a match keeps the colours it crosses.
 */
export function RubyCode({ source, matches = NO_MATCHES }: { source: string; matches?: readonly Match[] }) {
  const tokens = useMemo(() => {
    let start = 0
    return tokenizeRuby(source).map((token) => {
      const placed = { ...token, start }
      start += token.text.length
      return placed
    })
  }, [source])

  return tokens.map((token, at) => (
    // The colour of each kind of token the Ruby tokenizer names, read off its `data-token`.
    <span
      key={at}
      className={cn(
        "data-[token=keyword]:text-sql-keyword",
        "data-[token=string]:text-sql-string",
        "data-[token=symbol]:text-sql-placeholder",
        "data-[token=number]:text-sql-number",
        "data-[token=constant]:text-sql-identifier",
        "data-[token=comment]:text-sql-comment",
      )}
      data-token={token.kind}
    >
      <Marked text={token.text} from={token.start} matches={matches} />
    </span>
  ))
}

const NO_MATCHES: readonly Match[] = []
