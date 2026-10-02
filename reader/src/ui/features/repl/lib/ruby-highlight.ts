/**
 * Ruby highlighting for the *REPL*, hand-rolled and dependency-free, the way the SQL one is.
 * No regex parses Ruby, so this one guesses from a small set of lexical shapes, and where it
 * guesses wrong, a stretch of one input is miscoloured.
 *
 * Its one hard promise: **it never edits.** Concatenating every token's text reproduces the
 * input character for character, because the prompt draws it under the textarea the developer
 * is typing in, where a character added or lost would move the caret off the text it sits in.
 */

export type RubyTokenKind =
  /** `def`, `end`, `if`, and the literal words `nil`, `true`, `false` and `self`. */
  | "keyword"
  /** A quoted string, a heredoc, a backtick command, a regexp, or a non-symbol `%` literal. */
  | "string"
  /** `:name`, `:"name"`, a `name:` hash key or keyword argument, and `%i[]` and `%s()`. */
  | "symbol"
  | "number"
  | "constant"
  /** A local, a method name, and an instance, class or global variable. */
  | "identifier"
  | "comment"
  /** Everything else: whitespace, punctuation and operators. */
  | "plain"

export type RubyToken = { kind: RubyTokenKind; text: string }

/**
 * Ordered by precedence at each position: a comment and a literal come first, so a quote in a
 * comment or a `#` in a string is part of it. Every closer is optional, so an input typed only
 * as far as an open string colours the rest of itself as that string.
 *
 * - A double-quoted string steps over one level of `#{…}` whole, so a quote inside it does not
 *   close the string. Interpolation is coloured as the string it sits in.
 * - A `%` literal is only one with a bracket for its delimiter, so `x %= 2` and `10 % 3` stay
 *   operators. Its brackets do not nest.
 * - A heredoc runs from its `<<` to its terminator, the rest of its opening line included. Its
 *   terminator must be uppercase, so `a<<b` stays a shift.
 * - A `/` opens a regexp only at the start of a line, or after a `(`, `,`, an operator or a
 *   keyword that takes a value, and otherwise divides.
 * - A `name:` is a hash key unless a second colon makes it a scope.
 */
const TOKEN = new RegExp(
  [
    /(?<=^|\n)=begin\b[\s\S]*?(?:\n=end\b[^\n]*|$)/,
    /#[^\n]*/,
    /"(?:\\[\s\S]|#\{[^}]*\}|[^"\\])*"?/,
    /'(?:\\[\s\S]|[^'\\])*'?/,
    /`[^`]*`?/,
    /<<[~-]?(?<quote>["'`]?)(?<terminator>[A-Z_][A-Z_\d]*)\k<quote>[\s\S]*?(?:\n[ \t]*\k<terminator>(?=\n|$)|$)/,
    /%[qQwWiIrsx]?(?:\([^)]*\)?|\[[^\]]*\]?|\{[^}]*\}?|<[^>]*>?)/,
    /(?<=(?:^|[\n(,=~!&|{;[]|\b(?:if|unless|when|and|or|not|return))\s*)\/(?:\\[\s\S]|[^/\\\n])*(?:\/[a-z]*)?/,
    /(?<!:):(?:"(?:\\[\s\S]|[^"\\])*"?|[A-Za-z_]\w*(?:[?!]|=(?![=>~]))?)/,
    /@@?[A-Za-z_]\w*|\$(?:[A-Za-z_]\w*|\d+|[!@&+~=/\\,;.<>_*$?:0])/,
    /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[ri]?/,
    /[A-Za-z_]\w*[?!]?:(?!:)/,
    /[A-Za-z_]\w*(?:[?!](?!=))?/,
  ]
    .map((pattern) => pattern.source)
    .join("|"),
  "g",
)

const KEYWORDS = new Set(
  `alias and begin BEGIN break case class def defined? do else elsif end END ensure for if in
   module next not or redo rescue retry return super then undef unless until when while yield
   nil true false self __FILE__ __LINE__ __method__ __dir__ __ENCODING__`
    .split(/\s+/)
    .filter((word) => word !== ""),
)

export function tokenizeRuby(ruby: string): RubyToken[] {
  const tokens: RubyToken[] = []
  let after = 0

  // The gaps between matches — whitespace, operators, brackets — become one plain token each.
  function push(kind: RubyTokenKind, text: string) {
    if (text === "") return

    const last = tokens[tokens.length - 1]
    if (kind === "plain" && last !== undefined && last.kind === "plain") last.text += text
    else tokens.push({ kind, text })
  }

  TOKEN.lastIndex = 0
  for (let match = TOKEN.exec(ruby); match !== null; match = TOKEN.exec(ruby)) {
    push("plain", ruby.slice(after, match.index))
    push(kindOf(match[0], calledOn(ruby, match.index)), match[0])
    after = match.index + match[0].length
  }
  push("plain", ruby.slice(after))

  return tokens
}

/** Whether what starts at `at` follows a `.` or `&.`, as a method's name does, and not a `..` range. */
function calledOn(ruby: string, at: number) {
  return ruby[at - 1] === "." && ruby[at - 2] !== "."
}

function kindOf(text: string, called: boolean): RubyTokenKind {
  const opener = text[0]!

  if (opener === "#" || opener === "=") return "comment"
  if (opener === '"' || opener === "'" || opener === "`" || opener === "/" || opener === "<") return "string"
  if (opener === "%") return "iIs".includes(text[1]!) ? "symbol" : "string"
  if (opener === ":" || text.endsWith(":")) return "symbol"
  if (opener === "@" || opener === "$") return "identifier"
  if (opener >= "0" && opener <= "9") return "number"
  if (!called && KEYWORDS.has(text)) return "keyword"
  return opener >= "A" && opener <= "Z" ? "constant" : "identifier"
}
