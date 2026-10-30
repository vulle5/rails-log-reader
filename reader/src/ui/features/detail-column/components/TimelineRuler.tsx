import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { SqlEvent } from "../../../../shared/wire"
import { queryMark, type MarkKind } from "../lib/sql-highlight"
import type { TimelineLayout } from "../lib/timeline-layout"

/**
 * The *Timeline ruler*: a strip down the Timeline's right side, a full-width tick per marked
 * statement at its place in `layout`, and a thumb over the stretch the scrollport is showing.
 *
 * A tick is placed by the timeline's estimated layout, so it stays put while the browser lays out
 * entries it skipped off screen; the thumb is placed by the scrollport's own numbers, so it is
 * where the reader really is. Drawn first inside the scrollport, sticky and of no height, so it
 * stays in view and lays out nothing in the timeline under it: the scrollport's right padding is
 * its room.
 */
export function TimelineRuler({ layout }: { layout: TimelineLayout }) {
  const anchor = useRef<HTMLDivElement>(null)
  const [port, setPort] = useState<HTMLElement | null>(null)
  const view = useView(port, layout)
  const ticks = useMemo(() => marks(layout), [layout])

  useLayoutEffect(() => {
    setPort(anchor.current?.closest<HTMLElement>("[data-scrollport]") ?? null)
  }, [])

  return (
    <div ref={anchor} className="sticky top-0 z-10 -mb-px h-0 flex-none">
      <div
        className="absolute top-0 -right-2.5 w-2.5 border-l border-border bg-sunken"
        style={{ height: view.height }}
        role="group"
        aria-label="Timeline ruler"
      >
        {ticks.map((tick) => (
          // A tick's colour is its mark's, read off its `data-mark`: the colour its entry's edge is in.
          <button
            key={tick.key}
            type="button"
            className="absolute inset-x-0 h-0.75 cursor-pointer data-[mark=delete]:bg-method-delete data-[mark=insert]:bg-method-post data-[mark=rollback]:bg-error data-[mark=update]:bg-method-put-patch"
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
            className="absolute inset-x-0 border-y border-foreground/30 bg-foreground/10"
            style={{ top: `${view.top * 100}%`, height: `${view.size * 100}%` }}
            role="img"
            aria-label="Timeline ruler thumb"
          />
        </div>
      </div>
    </div>
  )
}

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

/** `INSERT · Order Create`, or the kind alone for a query with no name. */
function tickLabel(kind: MarkKind, event: SqlEvent) {
  const { name } = event.payload
  return name === null || name === "" ? kind.toUpperCase() : `${kind.toUpperCase()} · ${name}`
}

/** What a query's timeline entry carries as `data-event`, for its tick to find it by. */
export function entryKey(event: SqlEvent) {
  return `${event.run_id} ${event.seq}`
}

function entryOf(port: HTMLElement | null, key: string) {
  if (port === null) return undefined
  return [...port.querySelectorAll<HTMLElement>("li[data-event]")].find((entry) => entry.dataset.event === key)
}

/** The scrollport's height, and the stretch of its content on screen as fractions of the whole. */
type View = { height: number; top: number; size: number }

/**
 * Where `port` is scrolled to, read as it scrolls, after every render of the ruler, and as the
 * port or any block inside it is resized: an entry the browser lays out for the first time
 * changes the port's scroll height without scrolling it. The blocks are watched afresh whenever
 * `layout` changes, which is whenever the port's content does.
 */
function useView(port: HTMLElement | null, layout: TimelineLayout): View {
  const [view, setView] = useState<View>({ height: 0, top: 0, size: 1 })

  const read = useCallback(() => {
    if (port === null) return
    const next = viewOf(port)
    setView((prev) => (prev.height === next.height && prev.top === next.top && prev.size === next.size ? prev : next))
  }, [port])

  useLayoutEffect(() => read())

  useLayoutEffect(() => {
    if (port === null) return
    port.addEventListener("scroll", read, { passive: true })
    const observer = new ResizeObserver(read)
    observer.observe(port)
    for (const block of port.children) observer.observe(block)
    return () => {
      port.removeEventListener("scroll", read)
      observer.disconnect()
    }
  }, [port, read, layout])

  return view
}

function viewOf(port: HTMLElement): View {
  const { scrollTop, scrollHeight, clientHeight } = port
  // Nothing laid out yet, or nothing to scroll: all of it is on screen.
  if (scrollHeight <= 0 || scrollHeight <= clientHeight) return { height: clientHeight, top: 0, size: 1 }
  return { height: clientHeight, top: scrollTop / scrollHeight, size: clientHeight / scrollHeight }
}
