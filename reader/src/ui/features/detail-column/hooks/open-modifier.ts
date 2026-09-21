import { useEffect, useState } from "react"

import { openModifierKey } from "../../../lib/platform"

/**
 * Whether `openModifier` is down right now. Let go of on the window losing focus too, since a
 * key released while another window has focus never sends its `keyup` here.
 */
export function useOpenModifierHeld() {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    const key = openModifierKey()
    const down = (event: KeyboardEvent) => {
      if (event.key === key) setHeld(true)
    }
    const up = (event: KeyboardEvent) => {
      if (event.key === key) setHeld(false)
    }
    const lost = () => setHeld(false)

    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", lost)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      window.removeEventListener("blur", lost)
    }
  }, [])

  return held
}
