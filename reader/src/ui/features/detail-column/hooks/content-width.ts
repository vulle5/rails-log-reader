import { useLayoutEffect, useRef, useState } from "react"

/** The width assumed until one is measured, and where the DOM lays nothing out to measure. */
const UNMEASURED = 480

/**
 * The width of the element `ref` is attached to, inside its padding and scrollbar, kept up to
 * date as it is resized. Measured before the first paint, so nothing is drawn at the assumed one.
 */
export function useContentWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(UNMEASURED)

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth)
    }
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, width] as const
}
