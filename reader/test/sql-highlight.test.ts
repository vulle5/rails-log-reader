import { describe, expect, test } from "bun:test"

import { tokenizeSql, type SqlTokenKind } from "../src/ui/features/detail-column/lib/sql-highlight"

/**
 * The hand-rolled tokenizer #9 chose over a dependency. Rails' SQL is a narrow grammar —
 * keywords, quoted identifiers, string and numeric literals, `$1` and `?` placeholders and
 * a trailing QueryLogs comment — and the one property that matters more than any colour is
 * that highlighting is not an edit: the tokens have to rebuild the query character for
 * character, or what is read stops matching what pastes into a console.
 */

/** Every piece the tokenizer called `kind`, in order. */
function of(sql: string, kind: SqlTokenKind) {
  return tokenizeSql(sql)
    .filter((token) => token.kind === kind)
    .map((token) => token.text)
}

function rebuilt(sql: string) {
  return tokenizeSql(sql)
    .map((token) => token.text)
    .join("")
}

describe("tokenizing a query", () => {
  test("rebuilds it character for character, so highlighting it is never editing it", () => {
    for (const sql of [
      'SELECT "posts".* FROM "posts" WHERE "posts"."published" = ? ORDER BY "posts"."created_at" DESC LIMIT 20',
      "INSERT INTO `analytics_events` (`name`, `payload`) VALUES ($1, $2) RETURNING `id`",
      "SELECT COUNT(*) FROM orders WHERE total_cents >= 19.95 AND note = 'it''s fine'",
      "  BEGIN  \n\n",
      "",
    ]) {
      expect(rebuilt(sql)).toBe(sql)
    }
  })

  test("finds the keywords whatever case they were written in", () => {
    expect(of('SELECT "posts".* FROM "posts" WHERE "id" IS NOT NULL ORDER BY "id" DESC', "keyword")).toEqual([
      "SELECT",
      "FROM",
      "WHERE",
      "IS",
      "NOT",
      "NULL",
      "ORDER",
      "BY",
      "DESC",
    ])
    expect(of("select 1 from posts", "keyword")).toEqual(["select", "from"])
  })

  test("leaves a table or column name alone, quoted in whichever dialect quoted it", () => {
    expect(of('SELECT "posts"."id" FROM "posts"', "identifier")).toEqual(['"posts"', '"id"', '"posts"'])
    expect(of("SELECT `posts`.`id` FROM `posts`", "identifier")).toEqual(["`posts`", "`id`", "`posts`"])
  })

  test("does not mistake a function or an unquoted name for a keyword", () => {
    expect(of("SELECT to_tsvector(body) FROM posts", "keyword")).toEqual(["SELECT", "FROM"])
  })

  test("tells a string literal from an identifier, doubled quote and all", () => {
    expect(of("SELECT * FROM posts WHERE title = 'it''s here' AND body = 'x'", "string")).toEqual([
      "'it''s here'",
      "'x'",
    ])
  })

  test("picks out numeric literals without swallowing a name that has digits in it", () => {
    expect(of("SELECT id FROM posts_2024 WHERE id = 4021 AND score >= 19.95", "number")).toEqual(["4021", "19.95"])
  })

  test("picks out both placeholder shapes, and neither inside a string", () => {
    expect(of('SELECT * FROM "posts" WHERE "id" = $1 AND "slug" = ?', "placeholder")).toEqual(["$1", "?"])
    expect(of("SELECT * FROM posts WHERE title = 'why? because'", "placeholder")).toEqual([])
  })

  test("keeps a trailing QueryLogs comment whole, as one comment", () => {
    const sql = `SELECT "posts".* FROM "posts" /*application='ExampleApp',controller='posts',action='show'*/`

    expect(of(sql, "comment")).toEqual([`/*application='ExampleApp',controller='posts',action='show'*/`])
    // The quotes inside it are the comment's, not a string literal that happens to be there.
    expect(of(sql, "string")).toEqual([])
  })

  test("takes a line comment to the end of its line and no further", () => {
    expect(of("SELECT 1 -- a note\nSELECT 2", "comment")).toEqual(["-- a note"])
    expect(of("SELECT 1 -- a note\nSELECT 2", "number")).toEqual(["1", "2"])
  })

  /**
   * A Sidecar line is cut at the wire's per-field cap, so the tokenizer is routinely handed
   * a query that stops mid-token. It has to colour what is there and stop, never drop it.
   */
  test("carries an unterminated string or comment to the end rather than losing it", () => {
    expect(of("SELECT * FROM posts WHERE title = 'the beginning of", "string")).toEqual([
      "'the beginning of",
    ])
    expect(of("SELECT 1 /*application='ExampleApp',contro", "comment")).toEqual([
      "/*application='ExampleApp',contro",
    ])
    expect(rebuilt('SELECT * FROM "post')).toBe('SELECT * FROM "post')
  })
})

/**
 * #13's finding, made concrete: with `prepared_statements` off — mysql2's default, and
 * trilogy always — Arel inlines literal values into the SQL text instead of binding them,
 * so a quote inside a value reaches the Reader escaped rather than bound away.
 */
describe("a literal the adapter inlined instead of binding", () => {
  test("ends a string on a backslash-escaped quote, not before it", () => {
    const sql = "SELECT * FROM posts WHERE title = 'it\\'s here' AND id = 12"

    expect(of(sql, "string")).toEqual(["'it\\'s here'"])
    // The rest of the query is still read as SQL rather than swallowed by a string that
    // closed in the wrong place.
    expect(of(sql, "keyword")).toEqual(["SELECT", "FROM", "WHERE", "AND"])
    expect(of(sql, "number")).toEqual(["12"])
  })

  test("still rebuilds it character for character", () => {
    const sql = "UPDATE posts SET body = 'a \\\\ b \\' c' WHERE id = 1"

    expect(rebuilt(sql)).toBe(sql)
  })
})
