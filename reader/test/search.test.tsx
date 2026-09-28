import { describe, expect, test } from "bun:test"
import { renderHook } from "@testing-library/react"

import { useSearch } from "../src/ui/hooks/search"

/**
 * The search as compiled from a term, one render at a time: each render records the term it
 * was given beside what that render's search lights in `text`, so a render where the two
 * disagree is the lighting trailing the term.
 */
function compiling(text: string, term = "") {
  const renders: [term: string, lit: string[]][] = []
  const hook = renderHook(
    ({ term }) => {
      const search = useSearch(term)
      renders.push([term, search.find(text).map(([start, end]) => text.slice(start, end))])
    },
    { initialProps: { term } },
  )
  return { renders, type: (term: string) => hook.rerender({ term }) }
}

describe("the search's term", () => {
  test("lights from the term it was opened with, without trailing it", () => {
    const { renders } = compiling("Loaded 3 Posts", "posts")

    expect(renders).toEqual([["posts", ["Posts"]]])
  })

  test("lights a render after it arrives, and not before", () => {
    const { renders, type } = compiling("Loaded 3 Posts")

    type("posts")

    expect(renders.slice(1)).toEqual([
      ["posts", []],
      ["posts", ["Posts"]],
    ])
  })
})
