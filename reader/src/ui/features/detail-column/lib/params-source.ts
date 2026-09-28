import type { PathStep, ValueNode, ValueSource } from "../../value-viewer/lib/value-tree"
import { FILTERED, jsonText, rubyString } from "./json-text"
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
  return { tree: nodeOf(params), copyText: (node) => jsonText(node), pathText }
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

function pathText(path: readonly PathStep[]) {
  return `params${path.map((step) => `[${step.in === "list" ? step.key : symbol(step.key)}]`).join("")}`
}

/** A Hash key as a Ruby symbol: bare where Ruby reads it bare, quoted otherwise, as in `:"42"`. */
function symbol(key: string) {
  if (/^[A-Za-z_][A-Za-z0-9_]*[?!]?$/.test(key)) return `:${key}`
  return `:${rubyString(key)}`
}
