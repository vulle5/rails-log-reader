import type { PathStep, ValueNode, ValueSource } from "../../value-viewer/lib/value-tree"
import { isParamsHash, type RequestRoutePayload } from "../../../../shared/wire"

/**
 * A request's params as the *Value viewer*'s source. The tree is the JSON the wire parsed,
 * keys in the order they arrived, and nothing dropped or coerced. A tagged Hash is drawn in
 * its pairs' order. A plain object, which is how an envelope before v4 carries a Hash, is
 * drawn in the order `JSON.parse` gives it. `controller`, `action` and `format` stay,
 * though the header already names them. A string is drawn as JSON writes it, quotes and
 * escapes included, so a form's `"48"` never reads as the number `48`. The string
 * `[FILTERED]` is what `filter_parameters` left in a value's place, and becomes the filtered
 * marker.
 *
 * A copy is JSON written from the tree, so it keeps the tree's key order, and a filtered value
 * copies as the `"[FILTERED]"` Rails left. A path is Ruby that reaches the node from `params`:
 * `params[:comment][:tags][0]`.
 */
export function paramsSource(params: RequestRoutePayload["params"]): ValueSource {
  return { tree: nodeOf(params), copyText: (node) => jsonOf(node, ""), pathText }
}

function nodeOf(value: unknown): ValueNode {
  if (Array.isArray(value)) {
    return {
      type: "container",
      kind: "list",
      children: value.map((item, index) => ({ key: String(index), node: nodeOf(item) })),
    }
  }
  if (isParamsHash(value)) {
    return {
      type: "container",
      kind: "hash",
      children: value.pairs.map(([key, item]) => ({ key, node: nodeOf(item) })),
    }
  }
  if (value !== null && typeof value === "object") {
    return {
      type: "container",
      kind: "hash",
      children: Object.entries(value).map(([key, item]) => ({ key, node: nodeOf(item) })),
    }
  }

  if (value === FILTERED) return { type: "filtered" }
  if (typeof value === "string") return { type: "leaf", text: JSON.stringify(value), token: "string" }
  if (typeof value === "number") return { type: "leaf", text: String(value), token: "number" }
  if (typeof value === "boolean") return { type: "leaf", text: String(value), token: "keyword" }
  return { type: "leaf", text: "null", token: "null" }
}

const FILTERED = "[FILTERED]"

/** `node` as JSON laid out two spaces a level, the way `JSON.stringify(value, null, 2)` lays it out. A leaf's text already is its JSON. */
function jsonOf(node: ValueNode, indent: string): string {
  if (node.type === "filtered") return JSON.stringify(FILTERED)
  if (node.type === "cycle") return JSON.stringify(node.text)
  if (node.type === "leaf") return node.text

  const [open, close] = node.kind === "hash" ? ["{", "}"] : ["[", "]"]
  if (node.children.length === 0) return `${open}${close}`
  const inner = `${indent}  `
  const members = node.children.map(({ key, node: child }) => {
    const name = node.kind === "hash" ? `${JSON.stringify(key)}: ` : ""
    return `${inner}${name}${jsonOf(child, inner)}`
  })
  return `${open}\n${members.join(",\n")}\n${indent}${close}`
}

function pathText(path: readonly PathStep[]) {
  return `params${path.map((step) => `[${step.in === "list" ? step.key : symbol(step.key)}]`).join("")}`
}

/** A Hash key as a Ruby symbol: bare where Ruby reads it bare, quoted otherwise, as in `:"42"`. */
function symbol(key: string) {
  if (/^[A-Za-z_][A-Za-z0-9_]*[?!]?$/.test(key)) return `:${key}`
  // Escaped as JSON, which Ruby's double quotes read alike, but for `#{`, `#$` and `#@`.
  return `:${JSON.stringify(key).replace(/#(?=[{$@])/g, "\\#")}`
}
