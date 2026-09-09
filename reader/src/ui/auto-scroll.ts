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

/** The state of one column's auto-scroll. `unseen` is 0 whenever `following`, always. */
export type AutoScroll = {
  /** Stuck to the bottom of what it is showing. */
  following: boolean
  /** What has arrived below since it stopped. The number the pill says. */
  unseen: number
}

/** Where every column opens: pinned to the bottom of the loaded history, with nothing missed. */
export const FOLLOWING: AutoScroll = { following: true, unseen: 0 }

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
  return state.following ? { following: false, unseen: 0 } : state
}

/**
 * Things were appended below. A following column shows them and counts nothing; a paused one
 * counts them and moves nothing — including a Run boundary, which is one more thing that
 * arrived and never a reason to yank a reader back from what they were reading.
 */
export function arrived(state: AutoScroll, howMany: number): AutoScroll {
  if (state.following || howMany <= 0) return state
  return { following: false, unseen: state.unseen + howMany }
}

/** What a column needs to follow: the port to attach, and what the pill renders from. */
export type ColumnAutoScroll = AutoScroll & {
  /** Goes on the scrollport — the column's own `.column-body`, never the window. */
  port: RefObject<HTMLDivElement | null>
  onScroll: () => void
  /** The pill's click: back to the bottom, and back to following. */
  resume: () => void
}

type Showing = {
  /**
   * How many things the column is rendering. Growth is what "new" means, so this is counted
   * over what is *rendered* rather than what was folded: a line a level chip is hiding is
   * not something the reader would see by scrolling down, and a pill that counted it would
   * be sending them to look at nothing.
   */
  items: number
  /**
   * What it is showing them *of*: a Console filter, a row-kind tab, a selected row. When this
   * changes the list was re-derived rather than appended to, so the difference in `items` is
   * not arrivals and is not counted — a chip revealing fifty old lines is not fifty new ones.
   * The count already accumulated stands: how much arrived while you were away is a fact
   * about arrivals, and no filter changes it.
   */
  showing: string
  /**
   * Whether a change of `showing` also puts the column back to following. True for the Detail
   * column alone, where a change of `showing` is a change of *Selection* — a different row's
   * timeline, which opens at its newest activity rather than inheriting the last one's scroll
   * position. The other two are showing the same stream, thinned, and a reader who scrolled
   * up in it is still reading where they were.
   */
  refollowsWhenShowingChanges?: boolean
}

export function useAutoScroll({
  items,
  showing,
  refollowsWhenShowingChanges = false,
}: Showing): ColumnAutoScroll {
  const port = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<AutoScroll>(FOLLOWING)
  const rendered = useRef({ items, showing })

  // A layout effect, so the port is put back on the bottom in the same frame the thing that
  // pushed it off was added: after the DOM has the new rows and before anything is painted,
  // which is what makes following look like the column never moved at all.
  useLayoutEffect(() => {
    const previous = rendered.current
    rendered.current = { items, showing }

    if (showing !== previous.showing) {
      if (refollowsWhenShowingChanges) setState(FOLLOWING)
    } else if (!state.following) {
      setState((current) => arrived(current, items - previous.items))
    }

    // Read off `state` and not off what was just set: a column that was following is
    // following, and the one that was just handed a new Selection is about to be. Either way
    // the bottom is where it belongs, and the render that state change causes changes nothing
    // about that.
    if (state.following || (showing !== previous.showing && refollowsWhenShowingChanges)) {
      stickToBottom(port.current)
    }
  }, [items, showing, refollowsWhenShowingChanges, state.following])

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
