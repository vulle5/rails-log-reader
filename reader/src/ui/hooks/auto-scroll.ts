import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react"

/**
 * The Reader's **auto-scroll**: three of them, one per column, and one rule between them.
 *
 * A column *follows* — it sticks to the bottom, so whatever arrives is on screen the moment
 * it does — until it is *paused*, and **scrolling up is the only gesture that pauses it**.
 * Scrolling back to the bottom resumes, silently. A paused column counts what has arrived
 * below and offers the count as a pill, which is the only other way back.
 *
 * Three of them and not one, because the three columns are read for different reasons at the
 * same time: scrolling the Console back to find a boot line has nothing to say about whether
 * the Activity table should keep following new traffic, and pinning a hanging request in the
 * Detail column has nothing to say about either. So each column owns its own state and
 * nothing here is shared but the rule.
 *
 * **There is no second pause state**, and that is a promise about everything this file does
 * not contain. Selecting a row does not pause the Activity table — you had to scroll up to
 * click a moving row anyway, and that scroll already paused it. A tab filter switching, a
 * level chip going off, a Run boundary landing, a request finishing: none of them pauses
 * anything and none of them resumes anything. The one input is where the scrollport is, and
 * the DOM is the only thing that knows that — which is why `scrolled` is fed a measurement
 * rather than an intention, and why a jump the Console asked for settles the state by moving
 * the port and letting the scroll it caused be read like any other.
 */

/**
 * The state of one column's auto-scroll. `unseen` is 0 whenever `following`, always, and so
 * is `floor`.
 */
export type AutoScroll = {
  /** Stuck to the bottom of what it is showing. */
  following: boolean
  /** What has arrived below since it stopped. The number the pill says. */
  unseen: number
  /**
   * Whether `unseen` is a lower bound rather than an exact count — see `arrived`. Sticky once
   * set, for the same reason the count it replaces was never made exact in the first place: a
   * caller that starts feeding `arrived` an eviction count has already reached the one case
   * `unseen` cannot count past, and going back to exact would need the very ledger the pill
   * was built to avoid keeping.
   */
  floor: boolean
}

/** Where every column opens: pinned to the bottom of the loaded history, with nothing missed. */
export const FOLLOWING: AutoScroll = { following: true, unseen: 0, floor: false }

/** The parts of a scrollport this file reads, as the DOM hands them over. */
export type Port = { scrollTop: number; scrollHeight: number; clientHeight: number }

/**
 * How near the bottom still counts as the bottom. A scrollport reports whole pixels while
 * the layout under it is fractional, so a port the browser has scrolled as far as it goes
 * can still report a pixel of distance — and without the slack, a row of fractional height
 * arriving would pause a column nobody touched.
 */
export const BOTTOM_SLACK = 2

export function atBottom(port: Port) {
  return port.scrollHeight - port.clientHeight - port.scrollTop <= BOTTOM_SLACK
}

/**
 * The whole rule, and the only transition that pauses one: the port is where it is, and that
 * is the entire answer. Returns the state it was given when nothing changed, because this
 * fires on every frame of a drag and a column that re-rendered through one would be scrolling
 * against the hand doing it.
 */
export function scrolled(state: AutoScroll, bottom: boolean): AutoScroll {
  if (bottom) return state.following ? state : FOLLOWING
  return state.following ? { following: false, unseen: 0, floor: false } : state
}

/**
 * Things were appended below. A following column shows them and counts nothing; a paused one
 * counts them and moves nothing — including a Run boundary, which is one more thing that
 * arrived and never a reason to yank a reader back from what they were reading.
 *
 * `evicted` is the *Memory bound*'s own report of what it just took while this batch folded —
 * rows, for the Activity table, and the same rows again for the Console, whose retention
 * borrows that eviction rather than counting one of its own (#63). Zero everywhere below the
 * cap, where `howMany` is exact on its own. Once the bound is evicting one row for every row
 * it takes, `howMany` stalls at zero for the Activity table — the length it counts holds
 * still — or can even run negative for the Console, whose own rendered count is lines rather
 * than rows and can drop as evicted lines outnumber a quiet batch's arrivals. Either way
 * `howMany` alone has stopped saying anything true about what arrived, so `evicted` is what
 * keeps the pill moving from there, and `floor` is what tells the caller the number on it is
 * a lower bound and not the exact count it a moment ago was.
 */
export function arrived(state: AutoScroll, howMany: number, evicted = 0): AutoScroll {
  if (state.following) return state
  if (howMany <= 0 && evicted <= 0) return state
  return { following: false, unseen: state.unseen + Math.max(howMany, 0) + evicted, floor: state.floor || evicted > 0 }
}

/** What a column needs to follow: the port to attach, and what the pill renders from. */
export type ColumnAutoScroll = AutoScroll & {
  /** Goes on the scrollport — the column's own `.column-body`, never the window. */
  port: RefObject<HTMLDivElement | null>
  onScroll: () => void
  /** The pill's click: back to the bottom, and back to following. */
  resume: () => void
}

type AutoScrollOptions = {
  /**
   * How many things the column is rendering. Growth is what "new" means, so this is counted
   * over what is *rendered* rather than what was folded: a line a level chip is hiding is
   * not something the reader would see by scrolling down, and a pill that counted it would
   * be sending them to look at nothing.
   *
   * Growth of a length, which holds for as long as a column only ever appends — and since #27
   * the Activity table does not. Its two other ends are both handled by `listing`, which that
   * column feeds the row it starts at: a *load-earlier* prepending history above the oldest
   * row is not growth below, and the *Memory bound* taking a row off the same end is not a
   * loss below either. What is left is the fold sitting *at* its cap, where a row evicted per
   * row taken holds the length still and this undercounts. Being exact there means arrivals
   * somebody counted rather than a length to subtract — a second record of what the reader
   * has been shown, which is the thing the pill is deliberately not.
   */
  items: number
  /**
   * What the column is listing: a Console filter, a row-kind tab, a selected row. When this
   * changes the list was re-derived rather than appended to, so that render's difference in
   * `items` is not arrivals and is not counted — a chip revealing fifty old lines is not fifty
   * new ones. What was already counted stands, because how much arrived while you were away is
   * a fact about arrivals and no filter changes it.
   *
   * That leaves one seam, and it is left there deliberately: a render that relists *and*
   * delivers in the same commit drops that batch from the count. Closing it means a second
   * record of what the reader has already seen — an anchor on the last line they were shown,
   * or a tally per listing — which is a second source of truth about the same question, wrong
   * whenever its anchor is filtered away or evicted under the *Memory bound*. The pill's
   * number is a prompt to go and look, not a ledger, and it costs more to make it exact than
   * being exact is worth here.
   */
  listing: string
  /**
   * A narrower key than `listing`, watched the same way, whose own change alone puts the
   * column back to following. Left unset by two of the three columns, which never resume on
   * a relist: a tab or a chip re-derives the same stream thinned, and a reader who scrolled
   * up in it is still reading where they were.
   *
   * The Detail column alone supplies one, and supplies *Selection* — not its own filter
   * chip, for the same reason the other columns' chips are not `refollowsWhen` either. A new
   * Selection is a different row's timeline, which opens at its newest activity rather than
   * inheriting the last one's scroll position; the schema chip thins that same timeline, so
   * it is `listing`'s concern only, exactly the "same stream thinned" case a Console chip
   * already is.
   */
  refollowsWhen?: string
  /**
   * How many rows the *Memory bound* has evicted, ever — cumulative, counted the same way
   * `items` is, so a rising delta between two renders is what tells `arrived` a batch was
   * capped rather than counting one of its own. Left unset by the Detail column, which the
   * bound does not apply to as a fold (#63, #64): a Selection's timeline is never evicted out
   * from under it, so it has nothing to turn into a floor.
   */
  evicted?: number
}

export function useAutoScroll({ items, listing, refollowsWhen, evicted = 0 }: AutoScrollOptions): ColumnAutoScroll {
  const port = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<AutoScroll>(FOLLOWING)
  const rendered = useRef({ items, listing, refollowsWhen, evicted })

  // A layout effect, so the port is put back on the bottom in the same frame the thing that
  // pushed it off was added: after the DOM has the new rows and before anything is painted,
  // which is what makes following look like the column never moved at all.
  useLayoutEffect(() => {
    const previous = rendered.current
    rendered.current = { items, listing, refollowsWhen, evicted }
    const relisted = listing !== previous.listing
    const refollows = refollowsWhen !== undefined && refollowsWhen !== previous.refollowsWhen

    if (relisted) {
      if (refollows) setState(FOLLOWING)
    } else if (!state.following) {
      setState((current) => arrived(current, items - previous.items, evicted - previous.evicted))
    }

    // Read off `state` and not off what was just set: a column that was following is
    // following, and the one whose `refollowsWhen` just changed is about to be. Either way
    // the bottom is where it belongs, and the render that state change causes changes nothing
    // about that.
    if (state.following || refollows) stickToBottom(port.current)
  }, [items, listing, refollowsWhen, evicted, state.following])

  const onScroll = useCallback(() => {
    const measuring = port.current
    if (measuring === null) return

    const bottom = atBottom(measuring)
    setState((current) => scrolled(current, bottom))
  }, [])

  const resume = useCallback(() => {
    setState(FOLLOWING)
    // Now, rather than waiting for the effect: the click changed no content, so nothing else
    // would move the port, and the pill's whole promise is that it takes you to the bottom.
    stickToBottom(port.current)
  }, [])

  return { ...state, port, onScroll, resume }
}

/**
 * `scrollHeight - clientHeight` rather than `scrollHeight`: it is the port's own scroll
 * maximum, so the browser has nothing to clamp and the number the port reports back is the
 * number it was given.
 */
function stickToBottom(port: HTMLElement | null) {
  if (port === null) return
  port.scrollTop = port.scrollHeight - port.clientHeight
}
