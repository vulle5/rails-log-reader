import { describe, expect, test } from "bun:test"

import { jsonSource } from "../src/ui/features/detail-column/lib/json-source"
import type { LeafNode, TokenClass, ValueNode } from "../src/ui/features/value-viewer/lib/value-tree"

function treeOf(body: string) {
  const source = jsonSource(body)
  if (source === null) throw new Error(`not parsed: ${body}`)
  return source.tree
}

function keysOf(node: ValueNode) {
  if (node.type !== "container") throw new Error("not a container")
  return node.children.map((child) => child.key)
}

function leaf(text: string, token: TokenClass): LeafNode {
  return { type: "leaf", text, token }
}

describe("a JSON body as a value tree", () => {
  test("keeps an object's keys in the order the body wrote them, integer-like keys included", () => {
    expect(keysOf(treeOf('{"name":"x","42":1,"7":2,"5":3}'))).toEqual(["name", "42", "7", "5"])
  })

  test("colours each leaf by its real JSON type", () => {
    expect(treeOf('[1, "1", true, false, null]')).toEqual({
      type: "container",
      kind: "list",
      children: [
        { key: "0", node: leaf("1", "number") },
        { key: "1", node: leaf('"1"', "string") },
        { key: "2", node: leaf("true", "keyword") },
        { key: "3", node: leaf("false", "keyword") },
        { key: "4", node: leaf("null", "null") },
      ],
    })
  })

  test("draws a number and a string as the body wrote them", () => {
    expect(treeOf('{"price":1.50,"big":12345678901234567890,"e":1E3,"s":"caf\\u00e9 \\/"}')).toEqual({
      type: "container",
      kind: "hash",
      children: [
        { key: "price", node: leaf("1.50", "number") },
        { key: "big", node: leaf("12345678901234567890", "number") },
        { key: "e", node: leaf("1E3", "number") },
        { key: "s", node: leaf('"caf\\u00e9 \\/"', "string") },
      ],
    })
  })

  test("reads a key through its escapes", () => {
    expect(keysOf(treeOf('{"a\\"b":1,"\\u00e9":2}'))).toEqual(['a"b', "é"])
  })

  test("keeps a repeated key where it first appeared, holding its last value, as a parsed body does", () => {
    expect(treeOf('{"a":1,"b":2,"a":3}')).toEqual({
      type: "container",
      kind: "hash",
      children: [
        { key: "a", node: leaf("3", "number") },
        { key: "b", node: leaf("2", "number") },
      ],
    })
  })

  test("nests objects and arrays", () => {
    expect(treeOf(' { "posts" : [ { "id" : 1 } ] , "meta" : { } } ')).toEqual({
      type: "container",
      kind: "hash",
      children: [
        {
          key: "posts",
          node: {
            type: "container",
            kind: "list",
            children: [
              { key: "0", node: { type: "container", kind: "hash", children: [{ key: "id", node: leaf("1", "number") }] } },
            ],
          },
        },
        { key: "meta", node: { type: "container", kind: "hash", children: [] } },
      ],
    })
  })

  test("takes a scalar body as a leaf", () => {
    expect(treeOf('"ok"')).toEqual(leaf('"ok"', "string"))
  })

  test.each([
    ["an empty body", ""],
    ["a cut body", '{"posts":[{"id":1},{"id"'],
    ["trailing text", '{"a":1} x'],
    ["a trailing comma", '{"a":1,}'],
    ["a leading zero", "[01]"],
    ["a bare word", "[nope]"],
    ["an unknown escape", '["\\x"]'],
    ["a raw control character", '["a\nb"]'],
    ["a single-quoted string", "['a']"],
  ])("gives no tree for %s", (_, body) => {
    expect(jsonSource(body)).toBeNull()
  })

  test("gives no tree for a body nested past the parser's reach", () => {
    expect(jsonSource("[".repeat(100_000) + "]".repeat(100_000))).toBeNull()
  })
})

describe("copying out of a JSON body", () => {
  test("copies the whole body as JSON laid out two spaces a level, in the body's own key order", () => {
    const source = jsonSource('{"7":true,"posts":[1,"a"],"none":{}}')
    if (source === null) throw new Error("not parsed")

    expect(source.copyText(source.tree)).toBe('{\n  "7": true,\n  "posts": [\n    1,\n    "a"\n  ],\n  "none": {}\n}')
  })

  test("writes a path the way a Rails test reaches it", () => {
    const source = jsonSource("{}")
    if (source === null) throw new Error("not parsed")

    expect(
      source.pathText([
        { key: "posts", in: "hash" },
        { key: "0", in: "list" },
        { key: 'say "#{hi}"', in: "hash" },
      ]),
    ).toBe('response.parsed_body["posts"][0]["say \\"\\#{hi}\\""]')
  })
})
