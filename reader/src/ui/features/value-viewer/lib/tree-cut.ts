import type { ContainerNode, ValueNode } from "./value-tree"

/**
 * Where a value's tree, as the *Value viewer* first draws it, is cut to `limit` lines: how many
 * of the top level's children are drawn, and how many lines are left out after them. `null` when
 * it is drawn in no more than `limit`, and for a value with no top level to cut.
 *
 * As first drawn, a child is one line, unless its source opens it, when it is its opening line,
 * its own children's, a line saying what its source cut, if it did, and its closing bracket's.
 */
export function cutTree(tree: ValueNode, limit: number): { children: number; more: number } | null {
  if (tree.type !== "container") return null

  const lines = tree.children.map((child) => linesOf(child.node))
  const total = sum(lines) + (tree.cut === undefined ? 0 : 1)
  if (total <= limit) return null

  let children = 0
  let drawn = 0
  for (const each of lines) {
    if (drawn + each > limit) break
    drawn += each
    children++
  }
  return { children, more: total - drawn }
}

function linesOf(node: ValueNode): number {
  if (node.type !== "container" || node.open !== true || isEmpty(node)) return 1
  return 2 + sum(node.children.map((child) => linesOf(child.node))) + (node.cut === undefined ? 0 : 1)
}

/** A container holding nothing, and not cut short: there is nothing more to it than it shows. */
export function isEmpty(node: ContainerNode) {
  return node.children.length === 0 && node.cut === undefined
}

function sum(counts: readonly number[]) {
  return counts.reduce((total, count) => total + count, 0)
}
