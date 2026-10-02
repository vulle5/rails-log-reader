import type { PathStep, ValueChild, ValueNode, ValueSource } from "../../value-viewer/lib/value-tree"
import { jsonText, rubyString } from "./json-text"

/**
 * A JSON response body as the *Value viewer*'s source, or `null` when the body is not whole,
 * valid JSON, such as a body the wire cut.
 *
 * Every object keeps the order the body wrote its keys in, integer-like keys included. A repeated key stays where it first appeared and holds its last value,
 * as a parsed body does. A leaf is drawn exactly as the body wrote it, so `1.50` keeps its zero
 * and a string keeps its escapes, and is coloured by its JSON type.
 *
 * A copy is JSON written from the tree. A path is Ruby that reaches the node in a Rails test:
 * `response.parsed_body["posts"][0]`.
 */
export function jsonSource(body: string): ValueSource | null {
  let tree: ValueNode
  try {
    tree = new Parser(body).document()
  } catch {
    // Invalid JSON, or nesting deep enough to overflow the stack.
    return null
  }
  return { tree, copyText: (node) => jsonText(node), pathText }
}

function pathText(path: readonly PathStep[]) {
  return `response.parsed_body${path.map((step) => `[${step.in === "list" ? step.key : rubyString(step.key)}]`).join("")}`
}

// Sticky, so each matches only where the parser stands.
const WHITESPACE = /[ \t\n\r]*/y
const STRING = /"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
const KEYWORD = /true|false|null/y

class Parser {
  private at = 0

  constructor(private readonly text: string) {}

  document(): ValueNode {
    const node = this.value()
    this.skipWhitespace()
    if (this.at !== this.text.length) throw this.error()
    return node
  }

  private value(): ValueNode {
    this.skipWhitespace()
    const next = this.text[this.at]
    if (next === "{") return this.object()
    if (next === "[") return this.array()
    if (next === '"') return { type: "leaf", text: this.token(STRING), token: "string" }
    if (next === "t" || next === "f" || next === "n") {
      const text = this.token(KEYWORD)
      return { type: "leaf", text, token: text === "null" ? "null" : "keyword" }
    }
    return { type: "leaf", text: this.token(NUMBER), token: "number" }
  }

  private object(): ValueNode {
    const children: ValueChild[] = []
    const places = new Map<string, number>()
    this.members("}", () => {
      this.skipWhitespace()
      const key = JSON.parse(this.token(STRING)) as string
      this.skipWhitespace()
      this.expect(":")
      const node = this.value()
      const place = places.get(key)
      if (place === undefined) {
        places.set(key, children.length)
        children.push({ key, node })
      } else {
        children[place] = { key, node }
      }
    })
    return { type: "container", kind: "hash", children }
  }

  private array(): ValueNode {
    const children: ValueChild[] = []
    this.members("]", () => children.push({ key: String(children.length), node: this.value() }))
    return { type: "container", kind: "list", children }
  }

  /** The comma-separated members after an opening bracket, up to and including `close`. */
  private members(close: string, member: () => void) {
    this.at += 1
    this.skipWhitespace()
    if (this.text[this.at] === close) {
      this.at += 1
      return
    }
    for (;;) {
      member()
      this.skipWhitespace()
      if (this.text[this.at] === close) {
        this.at += 1
        return
      }
      this.expect(",")
    }
  }

  private token(pattern: RegExp) {
    pattern.lastIndex = this.at
    const match = pattern.exec(this.text)
    if (match === null || match[0] === "") throw this.error()
    this.at = pattern.lastIndex
    return match[0]
  }

  private expect(character: string) {
    if (this.text[this.at] !== character) throw this.error()
    this.at += 1
  }

  private skipWhitespace() {
    WHITESPACE.lastIndex = this.at
    WHITESPACE.exec(this.text)
    this.at = WHITESPACE.lastIndex
  }

  private error() {
    return new SyntaxError(`Unexpected JSON at ${this.at}`)
  }
}
