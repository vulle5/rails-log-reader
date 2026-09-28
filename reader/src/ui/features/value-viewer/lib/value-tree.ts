/**
 * The *Value viewer*'s one input: a structured value as a tree of what it draws, and nothing
 * about where the value came from. Each source has its own adapter that builds one, so what is
 * particular to params, a response body or a REPL result stays in that adapter and never
 * reaches the viewer.
 */

export type ValueNode = ContainerNode | LeafNode

/**
 * What a container's brackets and summary noun are: a hash-like one reads `{…} N keys`, a
 * list-like one `[…] N items`, and an XML element `<…> N children`.
 */
export type ContainerKind = "hash" | "list" | "element"

export type ContainerNode = {
  type: "container"
  kind: ContainerKind
  /** Drawn before the summary, saying what the container is: `Comment` in `Comment {…} 6 attributes`. */
  label?: string
  /** In the order they are drawn, which is the order the source had them in. */
  children: readonly ValueChild[]
  /**
   * Set when the source cut the container short: how many children it left out, or `null`
   * when it did not say. Absent for a container carried whole.
   */
  cut?: { more: number | null }
  /** Set when the container starts open under the top level, until the developer folds it. */
  open?: true
}

/**
 * One child of a container, under its key: a hash's key as drawn, a list item's index, or an
 * XML child's XPath step, such as `post[2]`.
 * A key is unique among its siblings, so the keys down to a node are its path.
 */
export type ValueChild = { key: string; node: ValueNode }

/** What kind of token a leaf is: the type the value has in its source, never one guessed from how it reads. */
export type TokenClass = "string" | "number" | "keyword" | "null" | "symbol" | "plain"

export type LeafNode =
  | {
      type: "leaf"
      /** Exactly as drawn: a string with its quotes and escapes, a number as its source wrote it. */
      text: string
      token: TokenClass
    }
  /** A value the app's own `filter_parameters` replaced before the Reader ever saw it. */
  | { type: "filtered" }
  /** A value that contains itself, drawn as the text its source gave the repeat. */
  | { type: "cycle"; text: string }

/**
 * A value as its source hands it to the viewer: the tree to draw, and the text each copy out
 * of it hands over. The viewer never writes a path or a copy itself.
 */
export type ValueSource = {
  tree: ValueNode
  /** What copying `node` hands over: the value it stands for, written the source's way. The whole value's copy is `copyText(tree)`. */
  copyText(node: ValueNode): string
  /** How the source reaches the node down `path` from the whole value. */
  pathText(path: readonly PathStep[]): string
}

/** One step down a path: a child's key, and the kind of container it is a key of. */
export type PathStep = { key: string; in: ContainerKind }
