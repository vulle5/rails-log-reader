import type { ValueNode } from "../../value-viewer/lib/value-tree"

/** What `filter_parameters` leaves in a filtered value's place, and what a filtered node copies as. */
export const FILTERED = "[FILTERED]"

/**
 * `node` as JSON laid out two spaces a level, the way `JSON.stringify(value, null, 2)` lays it
 * out, in the tree's own key order. A leaf's text already is its JSON.
 */
export function jsonText(node: ValueNode, indent = ""): string {
  if (node.type === "filtered") return JSON.stringify(FILTERED)
  if (node.type === "cycle") return JSON.stringify(node.text)
  if (node.type === "leaf") return node.text

  const [open, close] = node.kind === "hash" ? ["{", "}"] : ["[", "]"]
  if (node.children.length === 0) return `${open}${close}`
  const inner = `${indent}  `
  const members = node.children.map(({ key, node: child }) => {
    const name = node.kind === "hash" ? `${JSON.stringify(key)}: ` : ""
    return `${inner}${name}${jsonText(child, inner)}`
  })
  return `${open}\n${members.join(",\n")}\n${indent}${close}`
}

/** `text` as a Ruby double-quoted string: escaped as JSON, which Ruby reads alike, but for `#{`, `#$` and `#@`. */
export function rubyString(text: string) {
  return JSON.stringify(text).replace(/#(?=[{$@])/g, "\\#")
}
