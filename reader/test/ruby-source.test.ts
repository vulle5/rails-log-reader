import { describe, expect, test } from "bun:test"

import type { RubyNode } from "../src/shared/repl"
import { rubySource } from "../src/ui/features/repl/lib/ruby-source"
import type { ValueNode } from "../src/ui/features/value-viewer/lib/value-tree"
import { RUBY_HASH as HASH, RUBY_RECORD } from "./repl.fixtures"

function sourceOf(tree: RubyNode) {
  const source = rubySource(tree)
  if (source === null) throw new Error(`no structure: ${tree.inspect}`)
  return source
}

function child(node: ValueNode, key: string) {
  if (node.type !== "container") throw new Error("not a container")
  const found = node.children.find((each) => each.key === key)
  if (found === undefined) throw new Error(`no child ${key}`)
  return found.node
}

describe("a REPL result as a value tree", () => {
  test("lays a Hash out under its keys, a simple Symbol key bare, and an Array under its indices", () => {
    const { tree } = sourceOf(HASH)

    expect(tree).toMatchObject({ type: "container", kind: "hash" })
    expect(tree.type === "container" && tree.children.map((each) => each.key)).toEqual(["a", '"b"'])
    expect(child(tree, '"b"')).toMatchObject({ type: "container", kind: "list" })
  })

  test("colours each key by its Ruby type class", () => {
    const { tree } = sourceOf(HASH)

    expect(tree.type === "container" && tree.children.map((each) => each.keyType)).toEqual([
      { token: "symbol", sourceType: "symbol" },
      { token: "string", sourceType: "string" },
    ])
  })

  test("keeps a Symbol key that is not an identifier, and any other key, as its inspect", () => {
    const { tree } = sourceOf({
      type: "hash",
      inspect: '{"a b": 1, 2 => 3}',
      pairs: [
        [{ type: "symbol", inspect: ':"a b"' }, { type: "integer", inspect: "1", step: '[:"a b"]' }],
        [{ type: "integer", inspect: "2" }, { type: "integer", inspect: "3", step: "[2]" }],
      ],
    })

    expect(tree.type === "container" && tree.children.map((each) => each.key)).toEqual([':"a b"', "2"])
  })

  test("colours each leaf by its Ruby type class, and keeps that class on it", () => {
    const list = child(sourceOf(HASH).tree, '"b"')

    expect(child(list, "0")).toEqual({ type: "leaf", text: "1.0", token: "number", sourceType: "float" })
    expect(child(list, "1")).toEqual({ type: "leaf", text: "nil", token: "null", sourceType: "nil" })
    expect(child(list, "2")).toEqual({ type: "leaf", text: ":c", token: "symbol", sourceType: "symbol" })
  })

  test("draws a leaf of a type it has no colour for as plain text", () => {
    const { tree } = sourceOf({ type: "array", inspect: "[…]", items: [{ type: "time", inspect: "2026-09-29 00:00:00 UTC", step: "[0]" }] })

    expect(child(tree, "0")).toEqual({ type: "leaf", text: "2026-09-29 00:00:00 UTC", token: "plain", sourceType: "time" })
  })

  test("says how many items the loop left out of a cut container", () => {
    const { tree } = sourceOf({ type: "array", inspect: "[0, …]", items: [{ type: "integer", inspect: "0", step: "[0]" }], more: 4_001 })

    expect(tree).toMatchObject({ cut: { more: 4_001 } })
  })

  test("marks a node whose inspect the loop cut", () => {
    const { tree } = sourceOf({ type: "array", inspect: "[…]", items: [{ type: "string", inspect: '"xxx', cut: true, step: "[0]" }] })

    expect(child(tree, "0")).toMatchObject({ text: '"xxx…' })
  })

  test("copies a node as its inspect, the whole value included", () => {
    const source = sourceOf(HASH)

    expect(source.copyText(source.tree)).toBe('{a: 1, "b" => [1.0, nil, :c]}')
    expect(source.copyText(child(source.tree, '"b"'))).toBe("[1.0, nil, :c]")
  })

  test("copies a node's path as the steps that reach it", () => {
    const source = sourceOf(HASH)

    expect(source.pathText([{ key: '"b"', in: "hash" }, { key: "2", in: "list" }])).toBe('["b"][2]')
    expect(source.pathText([{ key: "a", in: "hash" }])).toBe("[:a]")
  })

  test("lays a record out under its attribute names, labelled with its class and counting attributes", () => {
    const { tree } = sourceOf(RUBY_RECORD)

    expect(tree).toMatchObject({ type: "container", kind: "hash", label: "Author", nouns: ["attribute", "attributes"] })
    expect(tree.type === "container" && tree.children.map((each) => [each.key, each.keyType])).toEqual([
      ["id", undefined],
      ["name", undefined],
      ["email", undefined],
    ])
  })

  test("draws a record's filtered attribute as the filtered marker", () => {
    expect(child(sourceOf(RUBY_RECORD).tree, "email")).toEqual({ type: "filtered" })
  })

  test("labels a Relation with its class, counting records, and says it has more without saying how many", () => {
    const { tree } = sourceOf({
      type: "relation",
      class: "ActiveRecord::Relation",
      inspect: "#<ActiveRecord::Relation [...]>",
      items: [RUBY_RECORD],
      more: null,
    })

    expect(tree).toMatchObject({ kind: "list", label: "#<ActiveRecord::Relation>", nouns: ["record", "records"], cut: { more: null } })
    expect(child(tree, "0")).toMatchObject({ label: "Author" })
  })

  test("labels a Set, a Struct, a Data and a plain object each as Ruby writes its class", () => {
    const member = { type: "integer", inspect: "1" } as const

    expect(sourceOf({ type: "set", class: "Set", inspect: "#<Set: {1}>", items: [member] }).tree).toMatchObject({
      kind: "list",
      label: "#<Set>",
    })
    expect(sourceOf({ type: "struct", class: "Point", inspect: "#<struct Point x=1>", fields: [["x", member]] }).tree).toMatchObject({
      kind: "hash",
      label: "#<struct Point>",
      nouns: ["member", "members"],
    })
    expect(sourceOf({ type: "data", class: "Coord", inspect: "#<data Coord x=1>", fields: [["x", member]] }).tree).toMatchObject({
      label: "#<data Coord>",
      nouns: ["member", "members"],
    })
    expect(sourceOf({ type: "object", class: "Money", inspect: "#<Money:0x0 @cents=1>", fields: [["@cents", member]] }).tree).toMatchObject({
      label: "#<Money>",
      nouns: ["ivar", "ivars"],
    })
  })

  test("labels a value of an anonymous class without a name", () => {
    const member = { type: "integer", inspect: "1" } as const

    expect(sourceOf({ type: "struct", inspect: "#<struct x=1>", fields: [["x", member]] }).tree).toMatchObject({ label: "#<struct>" })
    expect(sourceOf({ type: "object", inspect: "#<#<Class:0x0> @a=1>", fields: [["@a", member]] }).tree).toMatchObject({
      label: "#<anonymous>",
    })
  })

  test("draws a cycle as the text Ruby gives the repeat", () => {
    const { tree } = sourceOf({
      type: "hash",
      inspect: "{self: {...}}",
      pairs: [[{ type: "symbol", inspect: ":self" }, { type: "cycle", inspect: "{...}", step: "[:self]" }]],
    })

    expect(child(tree, "self")).toEqual({ type: "cycle", text: "{...}" })
  })

  test("has no path for a node reached through a Set member or an ivar", () => {
    const source = sourceOf({
      type: "object",
      class: "Money",
      inspect: "#<Money>",
      fields: [["@parts", { type: "array", inspect: "[1]", items: [{ type: "integer", inspect: "1", step: "[0]" }] }]],
    })

    expect(source.pathText([{ key: "@parts", in: "hash" }])).toBeNull()
    expect(source.pathText([{ key: "@parts", in: "hash" }, { key: "0", in: "list" }])).toBeNull()
  })

  test("copies a record attribute's path as its step", () => {
    expect(sourceOf(RUBY_RECORD).pathText([{ key: "name", in: "hash" }])).toBe("[:name]")
  })

  test("has no structure for a scalar, or an empty container", () => {
    expect(rubySource({ type: "integer", inspect: "42" })).toBeNull()
    expect(rubySource({ type: "array", inspect: "[]", items: [] })).toBeNull()
    expect(rubySource({ type: "hash", inspect: "{}", pairs: [] })).toBeNull()
  })
})
