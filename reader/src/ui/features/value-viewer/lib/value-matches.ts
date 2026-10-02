import type { Search } from "../../../hooks/search"
import type { ContainerNode, LeafNode, PathStep, ValueNode } from "./value-tree"

/**
 * *Search* inside a value tree. Each hash key and each leaf is matched on its own, on the text
 * the *Value viewer* draws for it, so a match never spans a key and its value, and what is
 * counted here is exactly what the viewer lights. What the viewer draws of its own is never
 * matched: a list's indices, a folded container's summary and label, a cut string's count.
 * A hash's keys and an XML element's tags are the source's, and matched.
 */

/** The text a leaf is matched on: what it draws, `FILTERED` for the filtered marker. */
export function leafText(leaf: LeafNode) {
  return leaf.type === "filtered" ? "FILTERED" : leaf.text
}

/** Whether a container's keys are text the source gave, and matched, rather than indices the viewer counted. */
export function keysMatch(node: ContainerNode) {
  return node.kind !== "list"
}

/** How many matches of the current term lie in `value`, the same ones the viewer lights. */
export function countMatches(search: Search, value: ValueNode) {
  return walk(search, value, [], null)
}

/**
 * How many matches lie inside each container of `value`, its own key left out, keyed by the
 * container's `pathKey`. A container with none is absent.
 */
export function matchesInside(search: Search, value: ValueNode): ReadonlyMap<string, number> {
  const inside = new Map<string, number>()
  walk(search, value, [], inside)
  return inside
}

/** A node's path as one string, to key what is kept about it. */
export function pathKey(path: readonly PathStep[]) {
  return JSON.stringify(path.map((step) => step.key))
}

function walk(search: Search, node: ValueNode, path: readonly PathStep[], inside: Map<string, number> | null): number {
  if (node.type !== "container") return search.find(leafText(node)).length

  let count = 0
  for (const child of node.children) {
    if (keysMatch(node)) count += search.find(child.key).length
    count += walk(search, child.node, [...path, { key: child.key, in: node.kind }], inside)
  }
  if (count > 0) inside?.set(pathKey(path), count)
  return count
}
