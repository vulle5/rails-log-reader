import type { ContainerNode, PathStep, ValueNode, ValueSource } from "../../value-viewer/lib/value-tree"

/**
 * An XML response body as the *Value viewer*'s source, parsed by the platform's own XML
 * parser, or `null` when the body is not well-formed XML.
 *
 * The tree stands for the document, so its one child is the root element, under its tag, and
 * starts open. An element with child elements is a container, keyed by its tag with its
 * attributes as its label. One holding only text, or nothing, is a string leaf of that text,
 * its attributes kept only in its copy. Text beside child elements is a `text()` leaf, and the
 * whitespace laying the elements out is dropped. A key takes its position, `post[2]`, where
 * siblings share it, so each key is an XPath step.
 *
 * A copy is the node's own XML, laid out two spaces a level, and the whole value's keeps the
 * body's `<?xml …?>` declaration. A `text()` leaf copies as its text. A path is XPath from the
 * document: `/posts/post[2]/title`.
 */
export function xmlSource(body: string): ValueSource | null {
  const document = new DOMParser().parseFromString(body, "application/xml")
  if (document.getElementsByTagName("parsererror").length > 0 || document.documentElement === null) return null

  const nodes = new WeakMap<ValueNode, Node>()
  const root = elementNode(document.documentElement, nodes)
  if (root.type === "container") root.open = true
  const tree: ContainerNode = {
    type: "container",
    kind: "element",
    children: [{ key: document.documentElement.nodeName, node: root }],
  }
  const declaration = /^\s*(<\?xml[^>]*\?>)/.exec(body)?.[1]

  return {
    tree,
    copyText: (node) => {
      if (node === tree) {
        const laidOut = xmlText(document.documentElement)
        return declaration === undefined ? laidOut : `${declaration}\n${laidOut}`
      }
      const source = nodes.get(node)
      if (source === undefined) return ""
      return source.nodeType === Node.ELEMENT_NODE ? xmlText(source as Element) : (source.textContent ?? "")
    },
    pathText,
  }
}

function pathText(path: readonly PathStep[]) {
  return `/${path.map((step) => step.key).join("/")}`
}

function elementNode(element: Element, nodes: WeakMap<ValueNode, Node>): ValueNode {
  const shown = shownChildren(element)
  const node: ValueNode = shown.some(isElement)
    ? {
        type: "container",
        kind: "element",
        ...(element.attributes.length === 0 ? {} : { label: attributesText(element) }),
        children: keyed(shown).map(([key, child]) => ({ key, node: childNode(child, nodes) })),
      }
    : { type: "leaf", text: JSON.stringify(element.textContent ?? ""), token: "string" }
  nodes.set(node, element)
  return node
}

function childNode(child: Element | Text, nodes: WeakMap<ValueNode, Node>): ValueNode {
  if (isElement(child)) return elementNode(child, nodes)
  const node: ValueNode = { type: "leaf", text: JSON.stringify(child.data), token: "string" }
  nodes.set(node, child)
  return node
}

/** An element's child elements and text, but for text that is only whitespace, which lays the elements out. */
function shownChildren(element: Element) {
  return [...element.childNodes].filter(
    (child): child is Element | Text =>
      isElement(child) || (isText(child) && child.data.trim() !== ""),
  )
}

/** Each child under its XPath step: its tag, or `text()`, with its position among the siblings sharing that step. */
function keyed(children: readonly (Element | Text)[]): [string, Element | Text][] {
  const steps = children.map((child) => (isElement(child) ? child.nodeName : "text()"))
  const seen = new Map<string, number>()
  return children.map((child, at) => {
    const step = steps[at] ?? ""
    if (steps.filter((other) => other === step).length === 1) return [step, child]
    const position = (seen.get(step) ?? 0) + 1
    seen.set(step, position)
    return [`${step}[${position}]`, child]
  })
}

/** `element` as XML laid out two spaces a level. An element holding only text keeps it on its own line. */
function xmlText(element: Element, indent = ""): string {
  const open = `<${element.nodeName}${element.attributes.length === 0 ? "" : ` ${attributesText(element)}`}`
  const shown = shownChildren(element)
  if (!shown.some(isElement)) {
    const text = element.textContent ?? ""
    return text === "" ? `${open}/>` : `${open}>${escapeText(text)}</${element.nodeName}>`
  }
  const inner = `${indent}  `
  const lines = shown.map((child) =>
    isElement(child) ? `${inner}${xmlText(child, inner)}` : `${inner}${escapeText(child.data.trim())}`,
  )
  return `${open}>\n${lines.join("\n")}\n${indent}</${element.nodeName}>`
}

/** An element's attributes as written in its start tag: `type="array"`. */
function attributesText(element: Element) {
  return [...element.attributes].map(({ name, value }) => `${name}="${escapeAttribute(value)}"`).join(" ")
}

function escapeText(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeAttribute(value: string) {
  return escapeText(value).replaceAll('"', "&quot;")
}

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE
}

/** Text, or a CDATA section, which is text written another way. */
function isText(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE
}
