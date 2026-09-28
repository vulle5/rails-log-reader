import { describe, expect, test } from "bun:test"

import { xmlSource } from "../src/ui/features/detail-column/lib/xml-source"
import type { ContainerNode, PathStep, ValueNode } from "../src/ui/features/value-viewer/lib/value-tree"

function sourceOf(body: string) {
  const source = xmlSource(body)
  if (source === null) throw new Error(`not parsed: ${body}`)
  return source
}

function container(node: ValueNode | undefined): ContainerNode {
  if (node?.type !== "container") throw new Error("not a container")
  return node
}

function child(node: ValueNode, key: string) {
  const found = container(node).children.find((each) => each.key === key)
  if (found === undefined) throw new Error(`no child ${key}`)
  return found.node
}

function keysOf(node: ValueNode) {
  return container(node).children.map((each) => each.key)
}

/** The root element, the one child of the document the tree stands for. */
function rootOf(body: string) {
  const { tree } = sourceOf(body)
  const [root] = container(tree).children
  if (root === undefined) throw new Error("no root element")
  return root
}

const POSTS =
  '<?xml version="1.0" encoding="UTF-8"?>\n<posts type="array">' +
  '<post><id type="integer">1</id><title>Hello &amp; welcome</title></post>' +
  "<post><id type=\"integer\">2</id><title>Second</title><tags><tag>a</tag><tag>b</tag></tags></post>" +
  "</posts>"

describe("an XML body as a value tree", () => {
  test("stands for the document, holding its root element under the root's tag, open from the start", () => {
    const root = rootOf(POSTS)
    expect(root.key).toBe("posts")
    expect(root.node).toMatchObject({ type: "container", kind: "element", open: true })
  })

  test("draws an element's attributes as its label", () => {
    expect(rootOf(POSTS).node).toMatchObject({ label: 'type="array"' })
    expect(container(rootOf("<a><b/></a>").node).label).toBeUndefined()
  })

  test("keys an element by its tag, with its position where siblings share the tag", () => {
    const root = rootOf(POSTS).node
    expect(keysOf(root)).toEqual(["post[1]", "post[2]"])
    expect(keysOf(child(root, "post[2]"))).toEqual(["id", "title", "tags"])
    expect(keysOf(child(child(root, "post[2]"), "tags"))).toEqual(["tag[1]", "tag[2]"])
  })

  test("folds only nested elements: the root alone starts open", () => {
    expect(container(child(rootOf(POSTS).node, "post[1]")).open).toBeUndefined()
  })

  test("makes an element holding only text a string leaf of that text, its attributes left to copies", () => {
    const post = child(rootOf(POSTS).node, "post[1]")
    expect(child(post, "id")).toEqual({ type: "leaf", text: '"1"', token: "string" })
    expect(child(post, "title")).toEqual({ type: "leaf", text: '"Hello & welcome"', token: "string" })
  })

  test("makes an element holding nothing an empty string", () => {
    expect(child(rootOf("<a><b/></a>").node, "b")).toEqual({ type: "leaf", text: '""', token: "string" })
  })

  test("keeps text beside child elements as text() leaves, and skips the whitespace between elements", () => {
    const root = rootOf("<p>\n  Hello <b>you</b> and <b>them</b>\n</p>").node
    expect(keysOf(root)).toEqual(["text()[1]", "b[1]", "text()[2]", "b[2]"])
    expect(child(root, "text()[1]")).toEqual({ type: "leaf", text: '"\\n  Hello "', token: "string" })
    expect(keysOf(rootOf("<a>\n  <b>1</b>\n  <c>2</c>\n</a>").node)).toEqual(["b", "c"])
  })

  test("is null for a body that is not well-formed XML", () => {
    expect(xmlSource("<posts><post></posts>")).toBeNull()
    expect(xmlSource("not xml")).toBeNull()
    expect(xmlSource("<a/><b/>")).toBeNull()
  })
})

describe("an XML body's paths", () => {
  function path(...keys: string[]): PathStep[] {
    return keys.map((key) => ({ key, in: "element" }))
  }

  test("are XPath from the document, with positions only where siblings share a tag", () => {
    expect(sourceOf(POSTS).pathText(path("posts", "post[2]", "title"))).toBe("/posts/post[2]/title")
    expect(sourceOf(POSTS).pathText(path("posts"))).toBe("/posts")
  })
})

describe("an XML body's copies", () => {
  test("lay the whole body out two spaces a level, keeping its declaration", () => {
    const { tree, copyText } = sourceOf(POSTS)
    expect(copyText(tree)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<posts type="array">',
        "  <post>",
        '    <id type="integer">1</id>',
        "    <title>Hello &amp; welcome</title>",
        "  </post>",
        "  <post>",
        '    <id type="integer">2</id>',
        "    <title>Second</title>",
        "    <tags>",
        "      <tag>a</tag>",
        "      <tag>b</tag>",
        "    </tags>",
        "  </post>",
        "</posts>",
      ].join("\n"),
    )
  })

  test("copy a node as its own element, laid out from its own first line, attributes included", () => {
    const { tree, copyText } = sourceOf(POSTS)
    const posts = child(tree, "posts")
    expect(copyText(child(child(posts, "post[1]"), "id"))).toBe('<id type="integer">1</id>')
    expect(copyText(child(child(posts, "post[2]"), "tags"))).toBe("<tags>\n  <tag>a</tag>\n  <tag>b</tag>\n</tags>")
  })

  test("copy an empty element as self-closing, and escape what an attribute or text needs", () => {
    const { tree, copyText } = sourceOf('<a note="&quot;x&quot; &lt; y"><b/><c>1 &lt; 2</c></a>')
    expect(copyText(tree)).toBe('<a note="&quot;x&quot; &lt; y">\n  <b/>\n  <c>1 &lt; 2</c>\n</a>')
  })

  test("copy a text() leaf as its text", () => {
    const { tree, copyText } = sourceOf("<p>Hello <b>you</b></p>")
    expect(copyText(child(child(tree, "p"), "text()"))).toBe("Hello ")
  })
})
