import type { RubyNode, RubyTypeClass } from "../../../../shared/repl"
import type { ContainerKind, LeafType, PathStep, TokenClass, ValueNode, ValueSource } from "../../value-viewer/lib/value-tree"

/**
 * A *REPL* result as the *Value viewer*'s source, or `null` when the value has no structure to
 * draw: a scalar, an object the loop did not lay out, or an empty one.
 *
 * A Hash's children are keyed by each key's `inspect`, except a Symbol that reads bare as a
 * Hash key, which is keyed without its colon, as `{a: 1}` writes it. An Array's, a Set's and a
 * Relation's are keyed by index. A record's attributes, a Struct's or a Data's members and an
 * object's ivars are keyed by name, and each of those is labelled with its class and counts
 * what it holds by its own noun: `Author {…} 6 attributes`, `#<Money> {…} 2 ivars`. A key and
 * a leaf are each drawn as their `inspect`, `…` after one the loop cut, and coloured by their
 * Ruby type class, which each keeps as its `sourceType`. A record's filtered attribute is the
 * filtered marker, and a cycle is the text Ruby's `inspect` gives the repeat.
 *
 * A node copies as its own `inspect`, the whole value included. A path is the `[…]` steps that
 * reach the node: `["b"][2]`. A node below a Set's member, a Data's member or an ivar has none.
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

/** The colour of each Ruby type class a leaf or a key can have. */
const TOKENS: Readonly<Partial<Record<RubyTypeClass, TokenClass>>> = {
  nil: "null",
  boolean: "keyword",
  string: "string",
  symbol: "symbol",
  integer: "number",
  float: "number",
  rational: "number",
  complex: "number",
  decimal: "number",
}

/**
 * How each type class laid out as fields, or labelled, is drawn: the kind of container it
 * reads as, its label for its class's name, and what its summary counts.
 */
const LAID_OUT: Readonly<
  Partial<Record<RubyTypeClass, { kind: ContainerKind; label: (name: string | undefined) => string; nouns?: readonly [string, string] }>>
> = {
  set: { kind: "list", label: (name) => `#<${name ?? "anonymous"}>` },
  relation: { kind: "list", label: (name) => `#<${name ?? "anonymous"}>`, nouns: ["record", "records"] },
  struct: { kind: "hash", label: (name) => (name === undefined ? "#<struct>" : `#<struct ${name}>`), nouns: ["member", "members"] },
  data: { kind: "hash", label: (name) => (name === undefined ? "#<data>" : `#<data ${name}>`), nouns: ["member", "members"] },
  record: { kind: "hash", label: (name) => name ?? "#<anonymous>", nouns: ["attribute", "attributes"] },
  object: { kind: "hash", label: (name) => `#<${name ?? "anonymous"}>`, nouns: ["ivar", "ivars"] },
}

/** A Symbol `inspect` that reads bare as a Hash key, `a:`, rather than quoted. */
const BARE_SYMBOL = /^:[A-Za-z_][A-Za-z0-9_]*[?!]?$/

function hasChildren(node: RubyNode) {
  return (node.pairs?.length ?? node.items?.length ?? node.fields?.length ?? 0) > 0 || node.more !== undefined
}

function nodeOf(node: RubyNode, nodes: Map<ValueNode, RubyNode>): ValueNode {
  const drawn = drawnNode(node, nodes)
  nodes.set(drawn, node)
  return drawn
}

function drawnNode(node: RubyNode, nodes: Map<ValueNode, RubyNode>): ValueNode {
  if (node.type === "filtered") return { type: "filtered" }
  if (node.type === "cycle") return { type: "cycle", text: node.inspect }

  const laidOut = LAID_OUT[node.type]
  const labelled = laidOut === undefined ? {} : { label: laidOut.label(node.class), ...(laidOut.nouns && { nouns: laidOut.nouns }) }
  const cut = node.more === undefined ? {} : { cut: { more: node.more } }
  if (node.pairs !== undefined) {
    const children = node.pairs.map(([key, value]) => ({ key: keyText(key), keyType: typeOf(key), node: nodeOf(value, nodes) }))
    return { type: "container", kind: "hash", children, ...cut }
  }
  if (node.fields !== undefined) {
    const children = node.fields.map(([name, value]) => ({ key: name, node: nodeOf(value, nodes) }))
    return { type: "container", kind: laidOut?.kind ?? "hash", ...labelled, children, ...cut }
  }
  if (node.items !== undefined) {
    const children = node.items.map((item, index) => ({ key: String(index), node: nodeOf(item, nodes) }))
    return { type: "container", kind: "list", ...labelled, children, ...cut }
  }
  return { type: "leaf", text: drawnText(node), ...typeOf(node) }
}

function typeOf(node: RubyNode): LeafType {
  return { token: TOKENS[node.type] ?? "plain", sourceType: node.type }
}

function drawnText(node: RubyNode) {
  return node.cut === true ? `${node.inspect}…` : node.inspect
}

function keyText(key: RubyNode) {
  return key.type === "symbol" && BARE_SYMBOL.test(key.inspect) ? key.inspect.slice(1) : drawnText(key)
}

function childOf(node: RubyNode | undefined, key: string) {
  return (
    node?.pairs?.find(([each]) => keyText(each) === key)?.[1] ??
    node?.fields?.find(([name]) => name === key)?.[1] ??
    node?.items?.[Number(key)]
  )
}

function pathText(tree: RubyNode, path: readonly PathStep[]) {
  let node: RubyNode | undefined = tree
  let steps = ""
  for (const { key } of path) {
    node = childOf(node, key)
    if (node?.step === undefined) return null
    steps += node.step
  }
  return steps
}
