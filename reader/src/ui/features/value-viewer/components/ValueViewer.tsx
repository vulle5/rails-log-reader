import { useCallback, useId, useState, type KeyboardEvent, type MouseEvent } from "react"

import type { ContainerKind, ContainerNode, LeafNode, ValueChild, ValueNode } from "../lib/value-tree"

/**
 * The *Value viewer*: a value tree drawn as an ARIA tree. The top level is open, and every
 * container under it starts folded to its summary until the developer opens it.
 *
 * What the developer opened and closed is this instance's own, keyed by each node's path, so
 * closing a node keeps what was opened inside it, and a new instance starts folded again.
 */
export function ValueViewer({ label, value }: { label: string; value: ValueNode }) {
  // Only the nodes the developer toggled: absent is folded.
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const toggle = useCallback((path: string) => {
    setOpened((previous) => new Map(previous).set(path, previous.get(path) !== true))
  }, [])

  if (value.type === "container" && value.children.length === 0 && value.cut === undefined) {
    return <p className="font-mono text-sm text-muted">{DRAWN[value.kind].empty}</p>
  }

  return (
    <ul className="font-mono text-sm leading-sql" role="tree" aria-label={label}>
      {value.type === "container" ? (
        <Children node={value} path={[]} opened={opened} onToggle={toggle} />
      ) : (
        <li role="treeitem">
          <Leaf leaf={value} />
        </li>
      )}
    </ul>
  )
}

/** How each kind of container is drawn: empty, folded, and what its summary counts. */
const DRAWN: Record<ContainerKind, { empty: string; folded: string; noun: string }> = {
  hash: { empty: "{}", folded: "{…}", noun: "key" },
  list: { empty: "[]", folded: "[…]", noun: "item" },
}

type Folds = {
  opened: ReadonlyMap<string, boolean>
  onToggle: (path: string) => void
}

function Children({ node, path, opened, onToggle }: { node: ContainerNode; path: readonly string[] } & Folds) {
  return (
    <>
      {node.children.map((child) => (
        <Item key={child.key} child={child} path={[...path, child.key]} opened={opened} onToggle={onToggle} />
      ))}
      {node.cut !== undefined && (
        <li className="pl-4 text-faint italic" role="treeitem">
          {node.cut.more === null ? "…more" : `…${node.cut.more} more ${noun(node, node.cut.more)}`}
        </li>
      )}
    </>
  )
}

function Item({ child, path, opened, onToggle }: { child: ValueChild; path: readonly string[] } & Folds) {
  const line = useId()
  const { node } = child

  if (node.type !== "container") {
    return (
      <li className="pl-4" role="treeitem" aria-labelledby={line}>
        <span id={line}>
          <Key text={child.key} />
          <Leaf leaf={node} />
        </span>
      </li>
    )
  }

  const pathKey = JSON.stringify(path)
  const open = opened.get(pathKey) === true
  // An event from inside an open node's children is theirs to answer, not this node's.
  const own = (event: MouseEvent | KeyboardEvent) =>
    (event.target as Element).closest('[role="treeitem"]') === event.currentTarget

  return (
    <li
      className="rounded-sm focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-accent"
      role="treeitem"
      aria-expanded={open}
      aria-labelledby={line}
      tabIndex={0}
      onClick={(event) => {
        if (own(event)) onToggle(pathKey)
      }}
      onKeyDown={(event) => {
        if (!own(event)) return
        const wanted = event.key === "ArrowRight" ? true : event.key === "ArrowLeft" ? false : null
        if (event.key === "Enter" || event.key === " " || (wanted !== null && wanted !== open)) {
          event.preventDefault()
          onToggle(pathKey)
        }
      }}
    >
      {/* The whole line is the toggle. */}
      <div className="flex cursor-pointer items-baseline hover:bg-sunken">
        <span className="w-4 flex-none text-center text-faint select-none" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span id={line}>
          <Key text={child.key} />
          <Summary node={node} />
        </span>
      </div>
      {open && (
        <ul className="pl-4" role="group">
          <Children node={node} path={path} opened={opened} onToggle={onToggle} />
        </ul>
      )}
    </li>
  )
}

function Key({ text }: { text: string }) {
  return <span className="text-muted">{`${text}: `}</span>
}

/** A folded container, said as its brackets and a count: `{…} 7 keys`, `[…] 3 items`. */
function Summary({ node }: { node: ContainerNode }) {
  const count = node.children.length + (node.cut?.more ?? 0)
  return (
    <>
      {node.label !== undefined && `${node.label} `}
      {DRAWN[node.kind].folded}
      <span className="text-faint">{` ${count}${node.cut?.more === null ? "+" : ""} ${noun(node, count)}`}</span>
    </>
  )
}

function noun(node: ContainerNode, count: number) {
  const one = DRAWN[node.kind].noun
  return count === 1 ? one : `${one}s`
}

function Leaf({ leaf }: { leaf: LeafNode }) {
  if (leaf.type === "filtered") return <>[FILTERED]</>
  return <span className="whitespace-pre-wrap wrap-anywhere">{leaf.text}</span>
}
