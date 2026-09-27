import { useId, type KeyboardEvent, type ReactNode } from "react"

import type { ColumnAutoScroll } from "../../../hooks/auto-scroll"
import { cn } from "../../../lib/cn"

/**
 * The *Detail tab* bar under the Detail column's header, and the panels it switches between.
 * The bar stays put while a panel scrolls, because each panel is a scrollport of its own.
 *
 * Every panel stays mounted, the ones not showing laid out but invisible, so a tab comes back
 * exactly as it was left: scrolled where it was, and folded the way it was.
 */

/** Every tab a row can have. Which ones a row has, and which of them are enabled, is its own. */
export type DetailTabId = "timeline" | "params"

export type DetailTab = {
  id: DetailTabId
  label: string
  /** Drawn faint after the label, saying what the tab holds before it is opened. */
  hint?: ReactNode
  /** Drawn at the tab's far end: what Search found in a tab that is not showing. */
  badge?: ReactNode
  /** A tab this row cannot show, drawn and never chosen: its panel is not drawn at all. */
  disabled?: boolean
  /**
   * What the panel is showing, when that can change under it: a new one is a new scrollport,
   * opening at its top rather than where the last one was left.
   */
  subject?: string
  /** Where this panel's scroll is followed from: the Timeline's *auto-scroll*. */
  scroll?: PanelScroll
  panel: ReactNode
}

export type PanelScroll = Pick<ColumnAutoScroll, "port" | "onScroll">

/**
 * The tab showing: the one chosen if this row has it enabled, and its first tab otherwise. The
 * choice itself is never changed by a row that cannot show it, so the next row that can shows
 * it again.
 */
function showingTab(tabs: readonly DetailTab[], chosen: DetailTabId) {
  return tabs.find((tab) => tab.id === chosen && tab.disabled !== true) ?? tabs[0]
}

export function DetailTabs({
  tabs,
  chosen,
  onChoose,
}: {
  tabs: readonly DetailTab[]
  chosen: DetailTabId
  onChoose: (tab: DetailTabId) => void
}) {
  const id = useId()
  const showing = showingTab(tabs, chosen)
  const tabId = (tab: DetailTab) => `${id}-tab-${tab.id}`
  const panelId = (tab: DetailTab) => `${id}-panel-${tab.id}`

  /** Arrows move along the bar, skipping a disabled tab, and choose what they land on. */
  function onKeyDown(event: KeyboardEvent) {
    const enabled = tabs.filter((tab) => tab.disabled !== true)
    const at = enabled.findIndex((tab) => tab === showing)
    const next =
      event.key === "ArrowRight"
        ? enabled[(at + 1) % enabled.length]
        : event.key === "ArrowLeft"
          ? enabled[(at - 1 + enabled.length) % enabled.length]
          : event.key === "Home"
            ? enabled[0]
            : event.key === "End"
              ? enabled.at(-1)
              : undefined
    if (next === undefined) return

    event.preventDefault()
    onChoose(next.id)
    document.getElementById(tabId(next))?.focus()
  }

  return (
    <>
      <div
        className="flex flex-none gap-0.5 border-b border-border bg-raised px-3 py-1"
        role="tablist"
        aria-label="Detail tabs"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={tabId(tab)}
            type="button"
            role="tab"
            aria-selected={tab === showing}
            aria-controls={tab.disabled === true ? undefined : panelId(tab)}
            tabIndex={tab === showing ? 0 : -1}
            disabled={tab.disabled}
            className="inline-flex cursor-pointer items-baseline gap-1.25 rounded border border-transparent bg-transparent px-2 py-0.5 text-xs text-muted not-aria-selected:enabled:hover:bg-sunken disabled:cursor-default disabled:text-faint aria-selected:border-border aria-selected:bg-selected aria-selected:text-foreground"
            onClick={() => onChoose(tab.id)}
          >
            {tab.label}
            {tab.hint !== undefined && <span className="text-faint">{tab.hint}</span>}
            {tab.badge}
          </button>
        ))}
      </div>
      {/* One grid cell holding every panel, so each is sized to the space under the bar and
          the one showing is simply the one not made invisible. */}
      <div className="grid min-h-0 flex-auto grid-cols-1 grid-rows-1">
        {tabs.map(
          (tab) =>
            tab.disabled !== true && (
              <DetailScroller
                key={`${tab.id} ${tab.subject ?? ""}`}
                id={panelId(tab)}
                className={cn("[grid-area:1/1]", tab !== showing && "invisible")}
                role="tabpanel"
                aria-labelledby={tabId(tab)}
                // Invisible is already out of reach of a pointer, the keyboard and a screen
                // reader; this says so to whatever reads the tree rather than the styles.
                aria-hidden={tab !== showing}
                scroll={tab.scroll}
              >
                {tab.panel}
              </DetailScroller>
            ),
        )}
      </div>
    </>
  )
}

/**
 * One scrollport in the Detail column: a tab's panel, or a *Run row*'s timeline, which has no
 * bar. The gutter is reserved whether or not the content needs a scrollbar yet, so the column
 * does not narrow under the reader the moment it first has something to scroll.
 */
export function DetailScroller({
  className,
  scroll,
  children,
  ...props
}: {
  className?: string
  scroll?: PanelScroll
  children: ReactNode
  id?: string
  role?: string
  "aria-labelledby"?: string
  "aria-hidden"?: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-px overflow-auto pb-6 [scrollbar-gutter:stable] [scrollbar-width:thin]",
        className,
      )}
      data-scrollport
      ref={scroll?.port}
      onScroll={scroll?.onScroll}
      {...props}
    >
      {children}
    </div>
  )
}
