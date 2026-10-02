import { describe, expect, test } from "bun:test"

import { tokenizeRuby, type RubyTokenKind } from "../src/ui/features/repl/lib/ruby-highlight"

/**
 * The hand-rolled Ruby tokenizer the *REPL* draws its input and *Transcript* with. What it
 * colours is a guess at a language no regex parses, and a wrong guess only miscolours; the one
 * property that has to hold is that the tokens rebuild the input character for character.
 */

/** Every piece the tokenizer called `kind`, in order. */
function of(ruby: string, kind: RubyTokenKind) {
  return tokenizeRuby(ruby)
    .filter((token) => token.kind === kind)
    .map((token) => token.text)
}

function rebuilt(ruby: string) {
  return tokenizeRuby(ruby)
    .map((token) => token.text)
    .join("")
}

describe("tokenizing Ruby", () => {
  test("rebuilds it character for character, so highlighting it is never editing it", () => {
    for (const ruby of [
      'Post.where(published: true).order(created_at: :desc).limit(20).map { |post| "#{post.id}: #{post.title}" }',
      "posts.each do |post|\n  # touch it\n  post.touch\nend\n",
      "=begin\na note\n=end\nx = %w[a b c] + %i(d e)",
      "@count ||= $stdout.puts(1_000.5e3, 0xff, ?a) if defined?(Foo::Bar) && x != y",
      "  \n\n",
      "",
      '"unterminated #{interp',
      "%w[open",
      "/half a regex",
    ]) {
      expect(rebuilt(ruby)).toBe(ruby)
    }
  })

  test("finds the keywords, the literal ones included", () => {
    expect(of("def greet(name) = name if name.nil? unless defined?(x)", "keyword")).toEqual([
      "def",
      "if",
      "unless",
      "defined?",
    ])
    expect(of("x = nil || true && false || self", "keyword")).toEqual(["nil", "true", "false", "self"])
    expect(of("[1].each do |n| n end", "keyword")).toEqual(["do", "end"])
  })

  test("reads a keyword called as a method, or written as a hash key, as not a keyword", () => {
    expect(of("post.class.then { it }.end", "keyword")).toEqual([])
    expect(of("link_to(post, class: 'big', if: true)", "keyword")).toEqual(["true"])
  })

  test("tells a constant from an identifier", () => {
    expect(of("ActiveRecord::Base.connection.execute(SQL)", "constant")).toEqual(["ActiveRecord", "Base", "SQL"])
    expect(of("ActiveRecord::Base.connection.execute(SQL)", "identifier")).toEqual(["connection", "execute"])
  })

  test("counts instance, class and global variables as identifiers", () => {
    expect(of("@post = @@cache[$PROGRAM_NAME]", "identifier")).toEqual(["@post", "@@cache", "$PROGRAM_NAME"])
  })

  test("keeps a method name's ? or ! with it, but not a != after it", () => {
    expect(of("post.save! if post.valid?", "identifier")).toEqual(["post", "save!", "post", "valid?"])
    expect(of("a!=b", "identifier")).toEqual(["a", "b"])
  })

  test("picks out strings in either quote, escapes and interpolation and all", () => {
    expect(of(`puts 'it\\'s', "say \\"hi\\"", "#{h["a"]} done"`, "string")).toEqual([
      "'it\\'s'",
      '"say \\"hi\\""',
      '"#{h["a"]} done"',
    ])
  })

  test("takes a percent literal whole, and a percent that divides as plain", () => {
    expect(of("%w[a b] + %q(it's) + %Q{x}", "string")).toEqual(["%w[a b]", "%q(it's)", "%Q{x}"])
    expect(of("10 % 3; x %= 2", "string")).toEqual([])
  })

  test("reads a symbol, a quoted one and a hash key as symbols, and not a scope or a ternary", () => {
    expect(of('order(:created_at, :"odd one", published: true)', "symbol")).toEqual([
      ":created_at",
      ':"odd one"',
      "published:",
    ])
    expect(of("%i[a b]", "symbol")).toEqual(["%i[a b]"])
    expect(of("Foo::Bar; x ? y : z", "symbol")).toEqual([])
    expect(of("{ :a=>1 }", "symbol")).toEqual([":a"])
  })

  test("picks out numbers without swallowing a name that has digits in it", () => {
    expect(of("posts_2024.first(10) + 1_000 + 3.14 + 2e10 + 0xff + 1r", "number")).toEqual([
      "10",
      "1_000",
      "3.14",
      "2e10",
      "0xff",
      "1r",
    ])
    expect(of("(1..10).step(2)", "number")).toEqual(["1", "10", "2"])
  })

  test("takes a comment to the end of its line and no further, and never one inside a string", () => {
    expect(of("x = 1 # a note\ny = 2", "comment")).toEqual(["# a note"])
    expect(of('"#not a comment" # but this is', "comment")).toEqual(["# but this is"])
    expect(of("=begin\nblock\n=end\nx", "comment")).toEqual(["=begin\nblock\n=end"])
  })

  test("reads a regexp where one can start, and a slash between values as division", () => {
    expect(of('x =~ /a"b#c/i', "string")).toEqual(['/a"b#c/i'])
    expect(of("total / count / 2", "string")).toEqual([])
  })

  test("reads a regexp at the start of a later line", () => {
    expect(of("foo(1)\n/bar/", "string")).toEqual(["/bar/"])
  })

  test("takes a heredoc's body whole, to its terminator, and a shift as an operator", () => {
    const ruby = 'sql = <<~SQL\n  SELECT "x\n  SQL\nPost.count'

    expect(of(ruby, "string")).toEqual(['<<~SQL\n  SELECT "x\n  SQL'])
    expect(of(ruby, "constant")).toEqual(["Post"])
    expect(of("list << item; a<<b", "string")).toEqual([])
    expect(rebuilt("x = <<-EOS\nnever closed")).toBe("x = <<-EOS\nnever closed")
  })

  test("carries an unterminated string or comment to the end rather than losing it", () => {
    expect(of('puts "the beginning of', "string")).toEqual(['"the beginning of'])
    expect(of("=begin\nnever closed", "comment")).toEqual(["=begin\nnever closed"])
  })
})
