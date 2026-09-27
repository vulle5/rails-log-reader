import type { ValueNode } from "../../value-viewer/lib/value-tree"

/**
 * A request's params as the *Value viewer*'s tree: the JSON the wire parsed, keys in the order
 * they arrived, and nothing dropped or coerced. `controller`, `action` and `format` stay,
 * though the header already names them. A string is drawn as JSON writes it, quotes and
 * escapes included, so a form's `"48"` never reads as the number `48`. The string
 * `[FILTERED]` is what `filter_parameters` left in a value's place, and becomes the filtered
 * marker.
 */
export function paramsTree(params: Record<string, unknown>): ValueNode {
  return nodeOf(params)
}

function nodeOf(value: unknown): ValueNode {
  if (Array.isArray(value)) {
    return {
      type: "container",
      kind: "list",
      children: value.map((item, index) => ({ key: String(index), node: nodeOf(item) })),
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
