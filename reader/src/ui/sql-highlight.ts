/**
 * SQL highlighting, hand-rolled and dependency-free — the mechanism #9 chose. Rails and
 * ActiveRecord emit a narrow grammar: keywords, quoted identifiers, string and numeric
 * literals, `$1` and `?` placeholders, and a QueryLogs comment on the end. That is small
 * enough that one regex is competitive with any library, and a library would cost either a
 * CJS interop dance (Prism) or ~12 KB gzip (highlight.js) to colour one short string.
 *
 * The tokenizer's one hard promise: **it never edits.** Concatenating every token's text
 * reproduces the input character for character, which is what keeps "renders exactly as
 * emitted, never reformatted" true of the highlighting layer too — what is read is what
 * pastes into a console.
 */

export type SqlTokenKind =
  | "keyword"
  /** A quoted one — `"posts"`, `` `posts` ``. An unquoted word is plain: it may be a function. */
  | "identifier"
  | "string"
  | "number"
  /** `$1` or `?`. Bind *values* are never here: the wire keeps them apart from the statement. */
  | "placeholder"
  | "comment"
  /** Everything else: whitespace, punctuation, operators, unquoted words. */
  | "plain"

export type SqlToken = { kind: SqlTokenKind; text: string }

/**
 * Ordered by precedence at each position: a comment and a literal come first, so a `?` or a
 * keyword *inside* one is part of it and not a token of its own. Every closer is optional
 * (`\*\/|$`, `'?`) because a Sidecar line is cut at the wire's per-field cap and arrives
 * stopped mid-token — which colours what is there rather than dropping it.
 *
 * A string literal ends on a doubled quote **or** a backslash-escaped one, which is a
 * dialect call and worth stating: `\'` is an escape on mysql2 and trilogy, and merely a
 * backslash before the closing quote on postgres and sqlite. It is read as an escape
 * because that is the case Rails actually produces — #13 established that with
 * `prepared_statements` off, Arel inlines literals straight into the SQL text, so a quote
 * inside a value reaches the Reader escaped by the mysql adapter, while ActiveRecord's own
 * postgres and sqlite quoting doubles the quote and never emits `\'` at all. Guessing wrong
 * miscolours a stretch of one query and can do no worse: this file never edits.
 */
const TOKEN =
  /\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*|'(?:''|\\[\s\S]|[^'])*'?|"(?:""|[^"])*"?|`[^`]*`?|\$\d+|\?|\d+(?:\.\d+)?|[A-Za-z_]\w*/g

/**
 * What Rails' own SQL is built from, plus the DDL and transaction words a `rake` task or a
 * `rails c` session puts in the same Sidecar. Matched case-insensitively: `connection.execute`
 * takes whatever the developer typed.
 */
const KEYWORDS = new Set(
  `SELECT DISTINCT FROM WHERE AND OR NOT NULL IS IN EXISTS LIKE ILIKE BETWEEN ORDER BY GROUP HAVING LIMIT OFFSET
   INSERT INTO VALUES UPDATE SET DELETE RETURNING ON CONFLICT DO NOTHING
   JOIN INNER OUTER LEFT RIGHT FULL CROSS LATERAL USING AS UNION INTERSECT EXCEPT ALL WITH RECURSIVE
   CASE WHEN THEN ELSE END ASC DESC NULLS FIRST LAST
   BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE TRANSACTION
   CREATE ALTER DROP TABLE INDEX UNIQUE VIEW PRIMARY FOREIGN KEY REFERENCES CONSTRAINT DEFAULT PRAGMA EXPLAIN
   COUNT SUM AVG MIN MAX CAST TRUE FALSE`
    .split(/\s+/)
    .filter((word) => word !== ""),
)

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let after = 0

  // Adjacent tokens of one kind become one, so the gaps between matches — whitespace,
  // commas, parentheses — do not each become a span of their own.
  function push(kind: SqlTokenKind, text: string) {
    if (text === "") return

    const last = tokens[tokens.length - 1]
    if (last !== undefined && last.kind === kind) last.text += text
    else tokens.push({ kind, text })
  }

  TOKEN.lastIndex = 0
  for (let match = TOKEN.exec(sql); match !== null; match = TOKEN.exec(sql)) {
    push("plain", sql.slice(after, match.index))
    push(kindOf(match[0]), match[0])
    after = match.index + match[0].length
  }
  push("plain", sql.slice(after))

  return tokens
}

function kindOf(text: string): SqlTokenKind {
  const opener = text[0]

  if (opener === "/" || opener === "-") return "comment"
  if (opener === "'") return "string"
  if (opener === '"' || opener === "`") return "identifier"
  if (opener === "$" || text === "?") return "placeholder"
  if (opener !== undefined && opener >= "0" && opener <= "9") return "number"
  return KEYWORDS.has(text.toUpperCase()) ? "keyword" : "plain"
}
