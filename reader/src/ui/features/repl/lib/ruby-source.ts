import type { RubyNode, RubyTypeClass } from "../../../../shared/repl"
import type { LeafType, PathStep, TokenClass, ValueNode, ValueSource } from "../../value-viewer/lib/value-tree"

/**
 * A *REPL* result as the *Value viewer*'s source, or `null` when the value has no structure to
 * draw: a scalar, an object the loop did not lay out, or an empty Hash or Array.
 *
 * A Hash's children are keyed by each key's `inspect`, except a Symbol that reads bare as a
 * Hash key, which is keyed without its colon, as `{a: 1}` writes it. An Array's are keyed by
 * index. A key and a leaf are each drawn as their `inspect`, `…` after one the loop cut, and
 * coloured by their Ruby type class, which each keeps as its `sourceType`.
 *
 * A node copies as its own `inspect`, the whole value included. A path is the `[…]` steps that
 * reach the node: `["b"][2]`.
 */
export function rubySource(tree: RubyNode): ValueSource | null {
  if (!hasChildren(tree)) return null

  const nodes = new Map<ValueNode, RubyNode>()
  return {
    tree: nodeOf(tree, nodes),
    copyText: (node) => nodes.get(node)?.inspect ?? "",
    pathText: (path) => pathText(tree, path),
  }
}

/** The colour of each Ruby type class. */
const TOKENS: Readonly<Record<RubyTypeClass, TokenClass>> = {
  hash: "plain",
  array: "plain",
  nil: "null",
  boolean: "keyword",
  string: "string",
  symbol: "symbol",
  integer: "number",
  float: "number",
  rational: "number",
  complex: "number",
  decimal: "number",
  time: "plain",
  object: "plain",
}

/** A Symbol `inspect` that reads bare as a Hash key, `a:`, rather than quoted. */
const BARE_SYMBOL = /^:[A-Za-z_][A-Za-z0-9_]*[?!]?$/

function hasChildren(node: RubyNode) {
  return (node.pairs?.length ?? node.items?.length ?? 0) > 0 || node.more !== undefined
}

function nodeOf(node: RubyNode, nodes: Map<ValueNode, RubyNode>): ValueNode {
  let drawn: ValueNode
  if (node.pairs !== undefined) {
    drawn = {
      type: "container",
      kind: "hash",
      children: node.pairs.map(([key, value]) => ({ key: keyText(key), keyType: typeOf(key), node: nodeOf(value, nodes) })),
      ...cut(node),
    }
  } else if (node.items !== undefined) {
    drawn = {
      type: "container",
      kind: "list",
      children: node.items.map((item, index) => ({ key: String(index), node: nodeOf(item, nodes) })),
      ...cut(node),
    }
  } else {
    drawn = { type: "leaf", text: drawnText(node), ...typeOf(node) }
  }
  nodes.set(drawn, node)
  return drawn
}

function typeOf(node: RubyNode): LeafType {
  return { token: TOKENS[node.type], sourceType: node.type }
}

function drawnText(node: RubyNode) {
  return node.cut === true ? `${node.inspect}…` : node.inspect
}

function cut(node: RubyNode) {
  return node.more === undefined ? {} : { cut: { more: node.more } }
}

function keyText(key: RubyNode) {
  return key.type === "symbol" && BARE_SYMBOL.test(key.inspect) ? key.inspect.slice(1) : drawnText(key)
}

function pathText(tree: RubyNode, path: readonly PathStep[]) {
  let node: RubyNode | undefined = tree
  let steps = ""
  for (const { key } of path) {
    node = node?.pairs?.find(([each]) => keyText(each) === key)?.[1] ?? node?.items?.[Number(key)]
    steps += node?.step ?? ""
  }
  return steps
}
