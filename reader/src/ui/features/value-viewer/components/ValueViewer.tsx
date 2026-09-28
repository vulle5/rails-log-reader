import { useCallback, useContext, useId, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"

import { CopyButton, LineCopy } from "../../../components/CopyButton"
import { cn } from "../../../lib/cn"
import { Marked, SearchContext, type Search } from "../../../hooks/search"
import { keysMatch, leafText, matchesInside, pathKey } from "../lib/value-matches"
import type {
  ContainerKind,
  ContainerNode,
  LeafNode,
  PathStep,
  TokenClass,
  ValueChild,
  ValueNode,
  ValueSource,
} from "../lib/value-tree"

/**
 * The *Value viewer*: a value tree drawn as an ARIA tree. The top level is open, and every
 * container under it starts folded to its summary until the developer opens it. An empty one is
 * drawn as its brackets, `{}` or `[]`, with nothing to open.
 *
 * What the developer opened and closed is this instance's own, keyed by each node's path, so
 * closing a node keeps what was opened inside it, and a new instance starts folded again.
 * A string longer than `LONG_STRING` characters is cut to its first `LONG_STRING`, and one
 * opened whole stays whole for the instance, the same way.
 *
 * *Search* reaches in: each hash key and each leaf is lit on its own, and what is open is
 * worked out on each render, never kept. A node is open if the developer opened it, and
 * otherwise if a match lies under it and the developer has not folded it since the term began.
 * A fold made over a match holds until the term changes, and its summary is lit, counting the
 * matches inside. So what Search opened folds back when the term changes, and what the
 * developer opened stays. A string matched past its cut is drawn whole while the term matches there.
 *
 * One control copies the whole value, and each node, on hover or focus, offers a copy of its
 * value and of its path. Every text copied is the source's: the viewer only asks for it.
 *
 * A `caption` is drawn over the tree, and the copy control sits on its line rather than the
 * tree's first, so the control is in the same place whatever the viewer is placed under.
 */
export function ValueViewer({ label, source, caption }: { label: string; source: ValueSource; caption?: ReactNode }) {
  const value = source.tree
  const search = useContext(SearchContext)
  const inside = useMemo(() => matchesInside(search, value), [search, value])
  // Only the nodes the developer toggled: absent is folded.
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  // The developer's folds over a match, which hold only under the search they were made in.
  const [folds, setFolds] = useState<HeldFolds>(() => ({ search, paths: NO_PATHS }))
  const held = heldUnder(folds, search)
  const isOpen = (path: string) => opened.get(path) === true || (inside.has(path) && !held.has(path))
  const toggle = (path: string) => {
    const open = isOpen(path)
    setOpened((previous) => new Map(previous).set(path, !open))
    setFolds((previous) => {
      const paths = new Set(heldUnder(previous, search))
      if (open && inside.has(path)) paths.add(path)
      else paths.delete(path)
      return { search, paths }
    })
  }
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set())
  const openWhole = useCallback((path: string) => {
    setWhole((previous) => new Set(previous).add(path))
  }, [])
  const view: ViewState = { source, search, inside, isOpen, onToggle: toggle, whole, onOpenWhole: openWhole }
  const wholeText = useMemo(() => source.copyText(value), [source, value])

  if (value.type === "container" && isEmpty(value)) {
    return (
      <>
        {caption}
        <p className="font-mono text-sm">
          <Empty node={value} />
        </p>
      </>
    )
  }

  return (
    // The right padding keeps the top lines clear of the copy button, which is anchored here.
    <div className="relative pr-15">
      {/* Centred on the first line, the caption's or the tree's, which starts at the block's top edge. */}
      <CopyButton className="-top-0.5 right-0" text={wholeText} label={`Copy ${label.toLowerCase()}`} />
      {caption}
      <ul className="font-mono text-sm leading-sql" role="tree" aria-label={label}>
        {value.type === "container" ? (
          <Children node={value} path={[]} {...view} />
        ) : (
          <li className="group/line" role="treeitem">
            <Leaf leaf={value} path={[]} {...view} />
            <NodeCopies node={value} path={[]} source={source} />
          </li>
        )}
      </ul>
    </div>
  )
}

/**
 * The most characters of a string drawn before it is cut. An escape such as `\n` or `\u00e9`
 * is one character, and so is a code point outside the BMP, so the count is the string's and
 * a cut never splits either.
 */
const LONG_STRING = 80

/** One character of a string as drawn: an escape, or a code point. */
const CHARACTER = /\\u[0-9a-fA-F]{4}|\\[\s\S]|[\s\S]/gu

/** The developer's folds over a match, and the search they were made under. */
type HeldFolds = { search: Search; paths: ReadonlySet<string> }

const NO_PATHS: ReadonlySet<string> = new Set()

/** The folds that still hold: only those made under `search`, so a new term lets every one go. */
function heldUnder(folds: HeldFolds, search: Search) {
  return folds.search === search ? folds.paths : NO_PATHS
}

/** How each kind of container is drawn: empty, folded, and what its summary counts. */
const DRAWN: Record<ContainerKind, { empty: string; folded: string; noun: string }> = {
  hash: { empty: "{}", folded: "{…}", noun: "key" },
  list: { empty: "[]", folded: "[…]", noun: "item" },
}

/** The source drawn, what Search found in it, and what is open in this instance, keyed by `pathKey`. */
type ViewState = {
  source: ValueSource
  search: Search
  /** How many matches lie inside each container that has any. */
  inside: ReadonlyMap<string, number>
  isOpen: (path: string) => boolean
  onToggle: (path: string) => void
  /** The strings opened whole, by path. */
  whole: ReadonlySet<string>
  onOpenWhole: (path: string) => void
}

function Children({ node, path, ...view }: { node: ContainerNode; path: readonly PathStep[] } & ViewState) {
  return (
    <>
      {node.children.map((child) => (
        <Item
          key={child.key}
          child={child}
          keyed={keysMatch(node)}
          path={[...path, { key: child.key, in: node.kind }]}
          {...view}
        />
      ))}
      {node.cut !== undefined && (
        <li className="pl-4 text-faint italic" role="treeitem">
          {node.cut.more === null ? "…more" : `…${node.cut.more} more ${noun(node, node.cut.more)}`}
        </li>
      )}
    </>
  )
}

/** `keyed` when the item's key is text Search matches, rather than a list index. */
function Item({
  child,
  keyed,
  path,
  ...view
}: { child: ValueChild; keyed: boolean; path: readonly PathStep[] } & ViewState) {
  const { source, search, inside, isOpen, onToggle } = view
  const line = useId()
  const { node } = child

  // An empty container has nothing to open, so it is drawn as a leaf is.
  if (node.type !== "container" || isEmpty(node)) {
    return (
      <li className="group/line pl-4" role="treeitem" aria-labelledby={line}>
        <span id={line}>
          <Key text={child.key} keyed={keyed} search={search} />
          {node.type === "container" ? <Empty node={node} /> : <Leaf leaf={node} path={path} {...view} />}
        </span>
        <NodeCopies node={node} path={path} source={source} line={line} />
      </li>
    )
  }

  const key = pathKey(path)
  const open = isOpen(key)
  const found = inside.get(key)
  // An event from inside an open node's children is theirs to answer, not this node's, and
  // one from a button on its line is the button's.
  const own = (event: MouseEvent | KeyboardEvent) =>
    (event.target as Element).closest('button, [role="treeitem"]') === event.currentTarget

  return (
    <li
      className="rounded-sm focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-accent"
      role="treeitem"
      aria-expanded={open}
      aria-labelledby={line}
      tabIndex={0}
      onClick={(event) => {
        if (own(event)) onToggle(key)
      }}
      onKeyDown={(event) => {
        if (!own(event)) return
        const wanted = event.key === "ArrowRight" ? true : event.key === "ArrowLeft" ? false : null
        if (event.key === "Enter" || event.key === " " || (wanted !== null && wanted !== open)) {
          event.preventDefault()
          onToggle(key)
        }
      }}
    >
      {/* The whole line is the toggle. */}
      <div className="group/line flex cursor-pointer items-baseline hover:bg-sunken">
        <span className="w-4 flex-none text-center text-faint select-none" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span id={line}>
          <Key text={child.key} keyed={keyed} search={search} />
          {/* Folded over a match, which only the developer's own fold leaves: lit, but not itself a match. */}
          {!open && found !== undefined ? (
            <span className="rounded-xs bg-match" data-lit>
              <Summary node={node} />
              {` · ${found} ${found === 1 ? "match" : "matches"}`}
            </span>
          ) : (
            <Summary node={node} />
          )}
        </span>
        <NodeCopies node={node} path={path} source={source} line={line} />
      </div>
      {open && (
        <ul className="pl-4" role="group">
          <Children node={node} path={path} {...view} />
        </ul>
      )}
    </li>
  )
}

/**
 * A node's copies of its value and of its path, drawn when its line is hovered or one of them
 * is focused. Each is described by the node's line, so a screen reader says which node it copies.
 */
function NodeCopies({
  node,
  path,
  source,
  line,
}: {
  node: ValueNode
  path: readonly PathStep[]
  source: ValueSource
  line?: string
}) {
  return (
    <>
      <LineCopy label="Copy value" idle="value" text={() => source.copyText(node)} line={line} />
      <LineCopy label="Copy path" idle="path" text={() => source.pathText(path)} line={line} />
    </>
  )
}

/** `keyed` when the key is text Search matches, rather than a list index. */
function Key({ text, keyed, search }: { text: string; keyed: boolean; search: Search }) {
  return (
    <span className="text-sql-identifier">
      <Marked text={text} matches={keyed ? search.find(text) : []} />
      {": "}
    </span>
  )
}

/** A container holding nothing, and not cut short: there is nothing more to it than it shows. */
function isEmpty(node: ContainerNode) {
  return node.children.length === 0 && node.cut === undefined
}

/** An empty container, said as its brackets alone: `{}`, `[]`, or `Comment {}`. */
function Empty({ node }: { node: ContainerNode }) {
  return (
    <span className="text-muted">
      {node.label !== undefined && `${node.label} `}
      {DRAWN[node.kind].empty}
    </span>
  )
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

/** A filtered value is a `FILTERED` marker rather than text, so it never reads as a string the app sent. */
function Leaf({ leaf, path, search, whole, onOpenWhole }: { leaf: LeafNode; path: readonly PathStep[] } & ViewState) {
  const matches = search.find(leafText(leaf))
  if (leaf.type === "filtered") {
    return (
      <span
        className="rounded-chip border border-dashed border-faint px-1 text-2xs tracking-wider text-muted"
        data-filtered
      >
        <Marked text="FILTERED" matches={matches} />
      </span>
    )
  }
  if (leaf.type === "cycle") {
    return (
      <Token>
        <Marked text={leaf.text} matches={matches} />
      </Token>
    )
  }

  // A string's text is its quotes around what it says, and only what it says is counted.
  const characters = leaf.token === "string" ? (leaf.text.slice(1, -1).match(CHARACTER) ?? []) : []
  const shown = `${leaf.text[0]}${characters.slice(0, LONG_STRING).join("")}`
  const key = pathKey(path)
  if (
    characters.length <= LONG_STRING ||
    whole.has(key) ||
    matches.some(([, stop]) => stop > shown.length)
  ) {
    return (
      <Token token={leaf.token}>
        <Marked text={leaf.text} matches={matches} />
      </Token>
    )
  }

  return (
    <>
      <Token token={leaf.token} cut>
        <Marked text={shown} matches={matches} />
      </Token>
      <button className="cursor-pointer text-faint italic hover:underline" type="button" onClick={() => onOpenWhole(key)}>
        {`…${characters.length - LONG_STRING} more chars`}
      </button>
    </>
  )
}

/** A leaf's text in the colour of its token class, read off its `data-token`. */
function Token({ token, cut = false, children }: { token?: TokenClass; cut?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "whitespace-pre-wrap wrap-anywhere",
        "data-[token=string]:text-sql-string",
        "data-[token=number]:text-sql-number",
        "data-[token=keyword]:text-sql-keyword",
        "data-[token=null]:text-faint data-[token=null]:italic",
      )}
      data-token={token}
      data-cut={cut || undefined}
    >
      {children}
    </span>
  )
}
