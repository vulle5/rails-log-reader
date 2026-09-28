import { useCallback, useId, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react"

import { CopyButton, useCopy } from "../../../components/CopyButton"
import { cn } from "../../../lib/cn"
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
 * container under it starts folded to its summary until the developer opens it.
 *
 * What the developer opened and closed is this instance's own, keyed by each node's path, so
 * closing a node keeps what was opened inside it, and a new instance starts folded again.
 * A string longer than `LONG_STRING` characters is cut to its first `LONG_STRING`, and one
 * opened whole stays whole for the instance, the same way.
 *
 * One control copies the whole value, and each node, on hover or focus, offers a copy of its
 * value and of its path. Every text copied is the source's: the viewer only asks for it.
 */
export function ValueViewer({ label, source }: { label: string; source: ValueSource }) {
  const value = source.tree
  // Only the nodes the developer toggled: absent is folded.
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const toggle = useCallback((path: string) => {
    setOpened((previous) => new Map(previous).set(path, previous.get(path) !== true))
  }, [])
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set())
  const openWhole = useCallback((path: string) => {
    setWhole((previous) => new Set(previous).add(path))
  }, [])
  const view: ViewState = { source, opened, onToggle: toggle, whole, onOpenWhole: openWhole }
  const wholeText = useMemo(() => source.copyText(value), [source, value])

  if (value.type === "container" && value.children.length === 0 && value.cut === undefined) {
    return <p className="font-mono text-sm text-muted">{DRAWN[value.kind].empty}</p>
  }

  return (
    // The right padding keeps the top lines clear of the copy button, which is anchored here.
    <div className="relative pr-15">
      <CopyButton text={wholeText} label={`Copy ${label.toLowerCase()}`} />
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

/** How each kind of container is drawn: empty, folded, and what its summary counts. */
const DRAWN: Record<ContainerKind, { empty: string; folded: string; noun: string }> = {
  hash: { empty: "{}", folded: "{…}", noun: "key" },
  list: { empty: "[]", folded: "[…]", noun: "item" },
}

/** The source drawn, and what the developer opened in this instance, keyed by `pathKey`. */
type ViewState = {
  source: ValueSource
  opened: ReadonlyMap<string, boolean>
  onToggle: (path: string) => void
  /** The strings opened whole, by path. */
  whole: ReadonlySet<string>
  onOpenWhole: (path: string) => void
}

function Children({ node, path, ...view }: { node: ContainerNode; path: readonly PathStep[] } & ViewState) {
  return (
    <>
      {node.children.map((child) => (
        <Item key={child.key} child={child} path={[...path, { key: child.key, in: node.kind }]} {...view} />
      ))}
      {node.cut !== undefined && (
        <li className="pl-4 text-faint italic" role="treeitem">
          {node.cut.more === null ? "…more" : `…${node.cut.more} more ${noun(node, node.cut.more)}`}
        </li>
      )}
    </>
  )
}

function Item({ child, path, ...view }: { child: ValueChild; path: readonly PathStep[] } & ViewState) {
  const { source, opened, onToggle } = view
  const line = useId()
  const { node } = child

  if (node.type !== "container") {
    return (
      <li className="group/line pl-4" role="treeitem" aria-labelledby={line}>
        <span id={line}>
          <Key text={child.key} />
          <Leaf leaf={node} path={path} {...view} />
        </span>
        <NodeCopies node={node} path={path} source={source} line={line} />
      </li>
    )
  }

  const key = pathKey(path)
  const open = opened.get(key) === true
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
          <Key text={child.key} />
          <Summary node={node} />
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

function pathKey(path: readonly PathStep[]) {
  return JSON.stringify(path.map((step) => step.key))
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
      <NodeCopy label="Copy value" idle="value" text={() => source.copyText(node)} line={line} />
      <NodeCopy label="Copy path" idle="path" text={() => source.pathText(path)} line={line} />
    </>
  )
}

/** The text is asked for on the click, so a node's copy is never written until it is wanted. */
function NodeCopy({ label, idle, text, line }: { label: string; idle: string; text: () => string; line?: string }) {
  const [copied, copy] = useCopy()
  return (
    <button
      className={cn(
        "ml-2 cursor-pointer font-ui text-2xs text-faint hover:text-foreground hover:underline",
        // A confirmation stays drawn for as long as it lasts, hovered or not.
        "opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 data-copied:opacity-100",
      )}
      type="button"
      aria-label={label}
      aria-describedby={line}
      data-copied={copied || undefined}
      onClick={() => copy(text())}
    >
      {copied ? "Copied" : idle}
    </button>
  )
}

function Key({ text }: { text: string }) {
  return <span className="text-sql-identifier">{`${text}: `}</span>
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
function Leaf({ leaf, path, whole, onOpenWhole }: { leaf: LeafNode; path: readonly PathStep[] } & ViewState) {
  if (leaf.type === "filtered") {
    return (
      <span
        className="rounded-chip border border-dashed border-faint px-1 text-2xs tracking-wider text-muted"
        data-filtered
      >
        FILTERED
      </span>
    )
  }
  if (leaf.type === "cycle") return <Token>{leaf.text}</Token>

  // A string's text is its quotes around what it says, and only what it says is counted.
  const characters = leaf.token === "string" ? (leaf.text.slice(1, -1).match(CHARACTER) ?? []) : []
  const key = pathKey(path)
  if (characters.length <= LONG_STRING || whole.has(key)) return <Token token={leaf.token}>{leaf.text}</Token>

  return (
    <>
      <Token token={leaf.token} cut>{`${leaf.text[0]}${characters.slice(0, LONG_STRING).join("")}`}</Token>
      <button className="cursor-pointer text-faint italic hover:underline" type="button" onClick={() => onOpenWhole(key)}>
        {`…${characters.length - LONG_STRING} more chars`}
      </button>
    </>
  )
}

/** A leaf's text in the colour of its token class, read off its `data-token`. */
function Token({ token, cut = false, children }: { token?: TokenClass; cut?: boolean; children: string }) {
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
