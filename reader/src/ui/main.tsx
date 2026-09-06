import { createRoot } from "react-dom/client"

import { Reader } from "./Reader"
import { useSidecar } from "./live"

const container = document.getElementById("root")
if (container === null) throw new Error("index.html is missing its #root element")

/** The one place the Sidecar is subscribed to, so every component below is a pure render. */
function LiveReader() {
  return <Reader rows={useSidecar()} />
}

createRoot(container).render(<LiveReader />)
