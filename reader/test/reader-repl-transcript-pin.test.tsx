import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"

import type { EvaluationEntry } from "../src/shared/repl"
import { Transcript } from "../src/ui/features/repl/components/Transcript"

/**
 * The *Transcript*'s pin to its newest entry while the prompt under it changes height. A DOM
 * with no layout has no height to change, so this stands a `ResizeObserver` in whose callbacks
 * the test runs, and gives the Transcript the scroll geometry the prompt's growth would leave.
 */

const observed: Array<() => void> = []
const realObserver = globalThis.ResizeObserver

beforeEach(() => {
  observed.length = 0
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      observed.push(callback)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  globalThis.ResizeObserver = realObserver
})

const ENTRY: EvaluationEntry = { kind: "evaluation", id: 1, input: "Post.count", output: "", outputCut: false, outcome: null }

/** A Transcript whose content is 1000px tall in a port of `clientHeight`, scrolled to `scrollTop`. */
function transcript(clientHeight: number, scrollTop: number) {
  render(<Transcript entries={[ENTRY]} railsRoot={null} />)
  const list = screen.getByRole("list", { name: "Transcript" })
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1000 })
  Object.defineProperty(list, "clientHeight", { configurable: true, value: clientHeight })
  list.scrollTop = scrollTop
  // user-event has no scroll gesture.
  fireEvent.scroll(list)
  return list
}

/** The prompt grew: the port is `clientHeight` tall now, and its observer is told. */
function resized(list: HTMLElement, clientHeight: number) {
  Object.defineProperty(list, "clientHeight", { configurable: true, value: clientHeight })
  for (const callback of observed) callback()
}

describe("the Transcript while the prompt changes height", () => {
  test("stays pinned to its newest entry as the prompt grows", () => {
    const list = transcript(300, 700)

    resized(list, 200)

    expect(list.scrollTop).toBe(1000)
  })

  test("stays pinned to its newest entry as the prompt shrinks", () => {
    const list = transcript(200, 800)

    resized(list, 300)

    expect(list.scrollTop).toBe(1000)
  })

  test("stays where it was scrolled to when it had been scrolled up", () => {
    const list = transcript(300, 100)

    resized(list, 200)

    expect(list.scrollTop).toBe(100)
  })
})
