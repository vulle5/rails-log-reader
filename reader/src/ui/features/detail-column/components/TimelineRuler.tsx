import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react"

import type { TimelineEvent } from "../../../../shared/activity"
import type { SqlEvent } from "../../../../shared/wire"
import { SearchContext, type Search } from "../../../hooks/search"
import { unreachable } from "../../../lib/unreachable"
import { queryMark, type MarkKind } from "../lib/sql-highlight"
import {
  targetOnStrip,
  thumbOnScreen,
  type BlockOnPage,
  type Target,
  type Thumb,
  type TimelineLayout,
} from "../lib/timeline-layout"
import { holdsMatch } from "../lib/timeline-matches"

/**
 * The *Timeline ruler*: a strip down the Timeline's right side, a full-width tick per marked
 * statement and a tick per entry, or exception block, holding a *Search* match, each at its place
 * in `layout`, and a thumb over the stretch the scrollport is showing.
 *
 * Ticks, thumb and presses are all on one measure, the timeline's estimated layout. A tick stays
 * put while the browser lays out entries it skipped off screen, lies inside the thumb exactly when
 * its entry starts on screen, and a press where it is drawn lands on its entry. The page's real
 * heights only say which block each edge of the screen is in and how far into it, and where a
 * pressed block's element is. An entry holds a match by the same rule it lights by, so a match
 * tick is drawn exactly where something is lit. Drawn first inside the scrollport, sticky and of
 * no height, so it stays in view and lays out nothing in the timeline under it: the scrollport's
 * right padding is its room, and the port has no scrollbar of its own beside it.
 *
 * It is the port's scrollbar. Pressing the strip anywhere but a tick centres the thumb on the
 * point pressed, or, pressed on the thumb, holds it where it was grabbed; dragging moves it on
 * from there. The point the thumb's top is aimed at names a block and a share of it, and the port
 * is scrolled to put that share of the block's element at the top of the screen. A thumb pushed
 * against either end of the strip scrolls the port to that end of its range. It only ever sets the
 * port's `scrollTop`, so the scroll it causes is read by the column's *auto-scroll* like any other.
 *
 * Edge cases follow a native scrollbar. A press stays held on its block and share while the strip
 * is held and for `SETTLE_FRAMES` after it is let go: whenever the timeline is resized in that
 * time, as entries brought near the screen take their real heights, the port is scrolled back to
 * it, so the thumb stays under the pointer. An entry arriving in that time leaves the hold alone,
 * so what is on screen stays still and the thumb moves, until the next pointer move re-aims it.
 */
export function TimelineRuler({ layout }: { layout: TimelineLayout }) {
  const anchor = useRef<HTMLDivElement>(null)
  const [port, setPort] = useState<HTMLElement | null>(null)
  const ticks = useMemo(() => marks(layout), [layout])
  const search = useContext(SearchContext)
  const matched = useMemo(() => matchesAt(layout, search), [layout, search])
  // How far below the thumb's top the press that is dragging it landed, as a fraction of the whole.
  const grab = useRef<number | null>(null)
  // What the press or drag aimed the thumb's top at, while it is held there.
  const held = useRef<Target | null>(null)
  const letGo = useRef(0)
  const view = useView(port, layout, () => {
    if (port === null || held.current === null) return
    scrollTo(port, held.current)
    if (grab.current === null) letGoLater()
  })

  function press(event: PointerEvent<HTMLDivElement>) {
    // A tick is a button of its own, whose click goes to its entry.
    if (port === null || event.button !== 0 || event.target !== event.currentTarget) return
    // No text selection starts under a drag.
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const at = pointedAt(port, event)
    const { top, size } = viewOf(port, layout)
    grab.current = at >= top && at <= top + size ? at - top : size / 2
    cancelAnimationFrame(letGo.current)
    aim(port, at - grab.current, size)
  }

  function drag(event: PointerEvent<HTMLDivElement>) {
    if (port === null || grab.current === null) return
    aim(port, pointedAt(port, event) - grab.current, view.size)
  }

  function release() {
    if (grab.current === null) return
    grab.current = null
    letGoLater()
  }

  /** Holds the thumb's top on what the strip draws at `top`, its bottom `size` under it. */
  function aim(port: HTMLElement, top: number, size: number) {
    held.current = top + size >= 1 ? { at: "end" } : targetOnStrip(layout, top)
    scrollTo(port, held.current)
  }

  /** Stops holding the thumb where it was aimed once `SETTLE_FRAMES` pass from now. */
  function letGoLater() {
    cancelAnimationFrame(letGo.current)
    const wait = (left: number) => {
      letGo.current = requestAnimationFrame(() => {
        if (left > 1) wait(left - 1)
        else held.current = null
      })
    }
    wait(SETTLE_FRAMES)
  }

  useLayoutEffect(() => () => cancelAnimationFrame(letGo.current), [])

  useLayoutEffect(() => {
    setPort(anchor.current?.closest<HTMLElement>("[data-scrollport]") ?? null)
  }, [])

  return (
    <div ref={anchor} className="sticky top-0 z-10 -mb-px h-0 flex-none">
      {/* `touch-none`: a finger dragging the strip scrolls the port through it, rather than panning the page. */}
      <div
        className="absolute top-0 -right-2.5 w-2.5 touch-none border-l border-border bg-sunken"
        style={{ height: view.height }}
        role="group"
        aria-label="Timeline ruler"
        onPointerDown={press}
        onPointerMove={drag}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        {/* Under the marks' ticks, so an entry both marked and matching shows its mark, and
            passes a click through to it. Named, though hidden from assistive technology with
            their layer. */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          {matched.map((at, index) => (
            <div
              key={index}
              className="absolute inset-x-0 h-0.5 bg-match-tick"
              style={{ top: `${at * 100}%` }}
              role="img"
              aria-label="Search match"
            />
          ))}
        </div>
        {ticks.map((tick) => (
          // A tick's colour is its mark's, read off its `data-mark`: the colour its entry's edge is in.
          <button
            key={tick.key}
            type="button"
            className="absolute inset-x-0 h-0.75 data-[mark=delete]:bg-method-delete data-[mark=insert]:bg-method-post data-[mark=rollback]:bg-error data-[mark=update]:bg-method-put-patch"
            style={{ top: `${tick.at * 100}%` }}
            data-mark={tick.kind}
            title={tick.label}
            aria-label={tick.label}
            onClick={() => entryOf(port, tick.key)?.scrollIntoView({ block: "center" })}
          />
        ))}
        {/* Drawn after the ticks, over them and translucent, and passes a click through to the
            tick under it. Named, though hidden from assistive technology with its layer. */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div
            className="absolute inset-x-0 border-y border-foreground/50 bg-foreground/20"
            style={{ top: `${view.top * 100}%`, height: `${view.size * 100}%` }}
            role="img"
            aria-label="Timeline ruler thumb"
          />
        </div>
      </div>
    </div>
  )
}

/**
 * How many frames after the strip is let go the thumb stays aimed where it was. A browser lays
 * out what a scroll brought near the screen two frames after it, and once more after the scroll
 * that follows: three covers each round of it.
 */
const SETTLE_FRAMES = 3

type Tick = { key: string; at: number; kind: MarkKind; label: string }

/** A tick per marked statement in `layout`, in timeline order. */
function marks(layout: TimelineLayout): Tick[] {
  const ticks: Tick[] = []
  for (const block of layout.blocks) {
    if (block.kind !== "entry" || block.event.type !== "sql") continue
    const kind = queryMark(block.event)
    if (kind === null) continue
    ticks.push({ key: entryKey(block.event), at: block.fraction, kind, label: tickLabel(kind, block.event) })
  }
  return ticks
}

/** Where each entry or exception block holding a match of the current term sits in `layout`, in timeline order. */
function matchesAt(layout: TimelineLayout, search: Search): number[] {
  return layout.blocks.filter((block) => holdsMatch(search, block)).map((block) => block.fraction)
}

/** `INSERT · Order Create`, or the kind alone for a query with no name. */
function tickLabel(kind: MarkKind, event: SqlEvent) {
  const { name } = event.payload
  return name === null || name === "" ? kind.toUpperCase() : `${kind.toUpperCase()} · ${name}`
}

/**
 * A timeline entry's `(run_id, seq)`, the event identity everywhere else in the Reader: its key,
 * and, on a query, the `data-event` its tick finds it by.
 */
export function entryKey(event: TimelineEvent) {
  return `${event.run_id} ${event.seq}`
}

function entryOf(port: HTMLElement | null, key: string) {
  if (port === null) return undefined
  return [...port.querySelectorAll<HTMLElement>("li[data-event]")].find((entry) => entry.dataset.event === key)
}

/** The scrollport's height, and the stretch of its content on screen as fractions of the whole. */
type View = Thumb & { height: number }

/**
 * Where `port` is scrolled to, read as it scrolls, after every render of the ruler, and as the
 * port or any block inside it is resized: an entry the browser lays out for the first time
 * changes the real heights the thumb is read through without scrolling the port. The blocks are
 * watched afresh whenever `layout` changes, which is whenever the port's content does. `resized`
 * runs first on each resize, so whatever it scrolls is what is read.
 */
function useView(port: HTMLElement | null, layout: TimelineLayout, resized: () => void): View {
  const [view, setView] = useState<View>({ height: 0, top: 0, size: 1 })
  const onResize = useRef(resized)
  useLayoutEffect(() => {
    onResize.current = resized
  })

  const read = useCallback(() => {
    if (port === null) return
    const next = viewOf(port, layout)
    setView((prev) => (prev.height === next.height && prev.top === next.top && prev.size === next.size ? prev : next))
  }, [port, layout])

  useLayoutEffect(() => read())

  useLayoutEffect(() => {
    if (port === null) return
    port.addEventListener("scroll", read, { passive: true })
    const observer = new ResizeObserver(() => {
      onResize.current()
      read()
    })
    observer.observe(port)
    for (const block of port.children) observer.observe(block)
    return () => {
      port.removeEventListener("scroll", read)
      observer.disconnect()
    }
  }, [port, read, layout])

  return view
}

/** How far down the strip `event` is, as a fraction of the whole: the strip is the port's height. */
function pointedAt(port: HTMLElement, event: PointerEvent<HTMLDivElement>) {
  return (event.clientY - event.currentTarget.getBoundingClientRect().top) / port.clientHeight
}

/**
 * Scrolls `port` to `target`: an end of its range, or the target's share of its block's element at
 * the top of the screen. The port clamps it to its range.
 */
function scrollTo(port: HTMLElement, target: Target) {
  switch (target.at) {
    case "start":
      port.scrollTop = 0
      return
    case "end":
      port.scrollTop = port.scrollHeight
      return
    case "block": {
      const element = port.querySelector<HTMLElement>(`[data-layout-index="${target.index}"]`)
      if (element === null) return
      const block = onPage(port, element)
      port.scrollTop = block.top + target.share * block.height
      return
    }
    default:
      unreachable(target)
  }
}

/** `block`'s index in the layout, and its real top and height in `port`'s content. */
function onPage(port: HTMLElement, block: HTMLElement): BlockOnPage {
  // Where the top of the port's content is on the viewport.
  const origin = port.getBoundingClientRect().top + port.clientTop - port.scrollTop
  const { top, height } = block.getBoundingClientRect()
  return { index: Number(block.dataset.layoutIndex), top: top - origin, height }
}

/**
 * The port's height, and the thumb `layout` places for the stretch of the port on screen. Only the
 * blocks at the screen's two edges are measured, each found by a search over the blocks' real
 * tops, which are in layout order.
 */
function viewOf(port: HTMLElement, layout: TimelineLayout): View {
  const { scrollTop, scrollHeight, clientHeight } = port
  const blocks = [...port.querySelectorAll<HTMLElement>("[data-layout-index]")]
  const bottom = scrollTop + clientHeight
  const thumb = thumbOnScreen(layout, {
    top: scrollTop,
    bottom,
    contentHeight: scrollHeight,
    atTop: blockAt(port, blocks, scrollTop),
    atBottom: blockAt(port, blocks, bottom),
  })
  return { height: clientHeight, ...thumb }
}

/** The last of `blocks` starting at or above `at` pixels down the port's content, or null above them all. */
function blockAt(port: HTMLElement, blocks: readonly HTMLElement[], at: number) {
  let found: BlockOnPage | null = null
  let low = 0
  let high = blocks.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const block = onPage(port, blocks[middle]!)
    if (block.top <= at) {
      found = block
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}
