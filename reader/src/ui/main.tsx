import { createRoot } from "react-dom/client"

import { Reader } from "./Reader"

const container = document.getElementById("root")
if (container === null) throw new Error("index.html is missing its #root element")

createRoot(container).render(<Reader />)
