/**
 * PROTOTYPE — throwaway, for "Marking writes and thinning cached queries in a long timeline" (#220).
 *
 * Four variants of how the *Detail column* marks a statement that changed data or undid changes,
 * switchable via `?variant=` on the Reader's own route:
 *   A  keyword tint — every keyword of the statement in its kind's colour, other tokens unchanged
 *   B  left edge — a coloured edge on the entry, the statement's own colours untouched
 *   C  both
 *   D  B's edge, plus a ruler down the timeline's side in place of its scrollbar
 *
 * More questions, each orthogonal to the mark, have their own switch in the bottom bar:
 *   `?palette=` log | verbs — the four kinds' colours
 *   `?chip=`    beside | inside | bubble — how a chip's count and its lit Search badge sit
 *
 * Verdicts so far, now the defaults: D's edge (no keyword tint), the badge fused into the chip, and
 * a ruler of full-width marks, Search matches and what is on screen, in place of the scrollbar,
 * and the `verbs` palette.
 *
 * The Reader is handed one canned request, `POST /orders`, of about 200 entries, and opens with
 * it selected: mostly SELECTs, a run of cached ones, a few SCHEMA queries, and an INSERT, an
 * UPDATE, a DELETE and a silent ROLLBACK among them. Nothing is persisted: the chips start shown
 * on every reload.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"

import type { ActivityRow, RequestRow, TimelineEvent } from "../../shared/activity"
import type { AppLogEvent, SqlEvent } from "../../shared/wire"
import { tokenizeSql } from "../features/detail-column/lib/sql-highlight"
import type { DetailFilter } from "../features/detail-column/components/DetailFilters"
import { SearchContext, type Search } from "../hooks/search"
import { MatchesBadge } from "../components/Matches"
import type { ThemeChoice } from "../hooks/theme"
import { cn } from "../lib/cn"

export const VARIANTS = {
  A: "Keyword tint",
  B: "Left edge",
  C: "Keyword tint + left edge",
  D: "Left edge + ruler",
} as const

export const PALETTES = {
  log: "development.log: INSERT green, UPDATE yellow, DELETE + ROLLBACK red",
  verbs: "HTTP verbs: INSERT as POST, UPDATE as PATCH, DELETE as DELETE, ROLLBACK red",
} as const


export const CHIPS = {
  beside: "count in chip, badge beside",
  inside: "badge fused into the chip",
  bubble: "count raised, badge a corner bubble",
} as const

type Variant = keyof typeof VARIANTS
type Palette = keyof typeof PALETTES
type ChipLook = keyof typeof CHIPS

type MarkKind = "insert" | "update" | "delete" | "rollback"

const POST = "var(--color-method-post)"
const COLOURS: Record<Palette, Record<MarkKind, string>> = {
  log: { insert: POST, update: "var(--color-warn)", delete: "var(--color-error)", rollback: "var(--color-error)" },
  verbs: {
    insert: POST,
    update: "var(--color-method-put-patch)",
    delete: "var(--color-method-delete)",
    rollback: "var(--color-error)",
  },
}

// ——— The mark ———

/** The real rule from CONTEXT.md: the statement's first keyword, past any leading comment. */
function firstKeyword(sql: string): string | null {
  for (const token of tokenizeSql(sql)) {
    if (token.kind === "comment" || (token.kind === "plain" && token.text.trim() === "")) continue
    return token.kind === "keyword" ? token.text.toUpperCase() : null
  }
  return null
}

function markOf(sql: string): MarkKind | null {
  const word = firstKeyword(sql)
  if (word === "INSERT") return "insert"
  if (word === "UPDATE") return "update"
  if (word === "DELETE") return "delete"
  if (word === "ROLLBACK") return "rollback"
  return null
}


export const ThinningContext = createContext<{ variant: Variant; palette: Palette }>({ variant: "D", palette: "verbs" })

export type QueryMark = {
  kind: MarkKind | null
  /** Sets `--mark` to the kind's colour, which the edge and the tint both read. */
  style: CSSProperties | undefined
  edge: boolean
  tint: boolean
}

export function useQueryMark(sql: string): QueryMark {
  const { variant, palette } = useContext(ThinningContext)
  const kind = markOf(sql)
  if (kind === null) return { kind, style: undefined, edge: false, tint: false }
  return {
    kind,
    style: { "--mark": COLOURS[palette][kind] } as CSSProperties,
    edge: variant !== "A",
    tint: variant === "A" || variant === "C",
  }
}

/**
 * D's ruler, in place of the timeline's scrollbar: a strip down its right side with a full-width
 * tick per marked entry, a yellow one per entry holding a *Search* match, and a box over the part
 * on screen. Hover a tick for what it is and click it to go there; press or drag anywhere else
 * on the strip to scroll, as a scrollbar's track does. Sticky and of no height, so it lays out
 * nothing in the timeline under it.
 */
export function MarkRuler({ rowId }: { rowId: string }) {
  const { variant, palette } = useContext(ThinningContext)
  const search = useContext(SearchContext)
  const anchor = useRef<HTMLDivElement>(null)
  const [port, setPort] = useState<HTMLElement | null>(null)
  const [layout, setLayout] = useState<RulerLayout>(EMPTY_LAYOUT)

  useLayoutEffect(() => {
    const scroller = anchor.current?.closest<HTMLElement>("[data-scrollport]") ?? null
    setPort(scroller)
    if (scroller === null) return

    // The ruler says what is on screen, so the scrollbar saying it too is one thing twice.
    scroller.style.scrollbarWidth = "none"
    scroller.style.scrollbarGutter = "auto"
    const measure = () => setLayout(measureRuler(scroller))
    measure()
    // `content-visibility: auto` settles entries' real heights as they scroll past, so the ticks
    // are re-measured rather than trusted once.
    const resize = new ResizeObserver(measure)
    resize.observe(scroller)
    const every = setInterval(measure, 700)
    scroller.addEventListener("scroll", measure, { passive: true })
    return () => {
      scroller.style.scrollbarWidth = ""
      scroller.style.scrollbarGutter = ""
      resize.disconnect()
      clearInterval(every)
      scroller.removeEventListener("scroll", measure)
    }
  }, [rowId, palette, search, variant])

  if (variant !== "D") return null

  function scrollTo(track: HTMLElement, clientY: number) {
    if (port === null) return
    const box = track.getBoundingClientRect()
    port.scrollTop = ((clientY - box.top) / box.height) * port.scrollHeight - port.clientHeight / 2
  }

  return (
    <div ref={anchor} className="sticky top-0 z-10 h-0 flex-none">
      <div
        className="absolute top-0 right-0 w-3 cursor-pointer touch-none border-l border-border bg-sunken select-none"
        style={{ height: layout.height }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button") !== null) return
          event.currentTarget.setPointerCapture(event.pointerId)
          scrollTo(event.currentTarget, event.clientY)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) scrollTo(event.currentTarget, event.clientY)
        }}
      >
        <div
          className="pointer-events-none absolute inset-x-0 border-y border-foreground/25 bg-foreground/8"
          style={{ top: `${layout.view.top * 100}%`, height: `${layout.view.height * 100}%` }}
        />
        {layout.found.map((at, index) => (
          <div key={`found ${index}`} className="pointer-events-none absolute inset-x-0 h-0.5 bg-match" style={{ top: `${at * 100}%` }} />
        ))}
        {layout.marks.map((tick, at) => (
          <button
            key={`mark ${at}`}
            type="button"
            title={tick.label}
            aria-label={tick.label}
            className="absolute inset-x-0 h-1 cursor-pointer rounded-xs"
            style={{ top: `${tick.at * 100}%`, background: tick.colour }}
            onClick={() => tick.entry.scrollIntoView({ block: "center" })}
          />
        ))}
      </div>
    </div>
  )
}

type RulerLayout = {
  height: number
  view: { top: number; height: number }
  marks: { at: number; colour: string; label: string; entry: HTMLElement }[]
  found: number[]
}

const EMPTY_LAYOUT: RulerLayout = { height: 0, view: { top: 0, height: 0 }, marks: [], found: [] }

/** Where everything the ruler draws sits, each as a fraction of the timeline's whole height. */
function measureRuler(port: HTMLElement): RulerLayout {
  const box = port.getBoundingClientRect()
  const total = port.scrollHeight
  const at = (entry: Element) => (entry.getBoundingClientRect().top - box.top + port.scrollTop) / total

  const marks = [...port.querySelectorAll<HTMLElement>("li[data-mark]")].map((entry) => ({
    at: at(entry),
    colour: entry.style.getPropertyValue("--mark"),
    label: `${entry.dataset.mark!.toUpperCase()} — ${entry.dataset.name ?? "query"}`,
    entry,
  }))

  const found = new Set<Element>()
  for (const mark of port.querySelectorAll("li mark")) {
    const entry = mark.closest("ol > li")
    if (entry !== null) found.add(entry)
  }

  return {
    height: port.clientHeight,
    view: { top: port.scrollTop / total, height: port.clientHeight / total },
    marks,
    found: [...found].map(at),
  }
}

// ——— The chips ———

export const THINNING_ON_OPEN: DetailFilter = { showingSchema: true, showingCache: true }

export function useThinning() {
  const [filter, setFilter] = useState<DetailFilter>(THINNING_ON_OPEN)
  return {
    filter,
    toggleSchema: () => setFilter((previous) => ({ ...previous, showingSchema: !previous.showingSchema })),
    toggleCache: () => setFilter((previous) => ({ ...previous, showingCache: !previous.showingCache })),
  }
}

function isSchema(event: TimelineEvent): event is SqlEvent {
  return event.type === "sql" && (event.payload.name === "SCHEMA" || event.payload.name === "EXPLAIN")
}

function isCached(event: TimelineEvent): event is SqlEvent {
  return event.type === "sql" && event.payload.cached
}

/** What the Detail column lights in a query: its statement, its binds and its callsite. */
function queryMatches(search: Search, event: SqlEvent) {
  const { sql, binds, callsite } = event.payload
  return (
    search.find(sql).length +
    binds.reduce<number>((count, bind) => count + search.find(bind === null ? "NULL" : String(bind)).length, 0) +
    (callsite === undefined ? 0 : search.find(`↳ ${callsite}`).length)
  )
}

export function ThinningChips({
  row,
  filter,
  look,
  onToggleCache,
  onToggleSchema,
}: {
  row: ActivityRow | null
  filter: DetailFilter
  look: ChipLook
  onToggleCache: () => void
  onToggleSchema: () => void
}) {
  const search = useContext(SearchContext)
  const events = row === null ? [] : [...row.timeline, ...(row.kind === "run" ? [] : row.trailing)]
  const cached = events.filter(isCached)
  const schema = events.filter(isSchema)
  const found = (hidden: SqlEvent[]) => hidden.reduce((count, event) => count + queryMatches(search, event), 0)

  return (
    <div className="flex flex-none items-center">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by query kind">
        <CountedChip
          look={look}
          named="cache"
          count={row === null ? null : cached.length}
          showing={filter.showingCache !== false}
          found={filter.showingCache === false ? found(cached) : 0}
          onToggle={onToggleCache}
        />
        <CountedChip
          look={look}
          named="schema"
          count={row === null ? null : schema.length}
          showing={filter.showingSchema}
          found={filter.showingSchema ? 0 : found(schema)}
          onToggle={onToggleSchema}
        />
      </div>
    </div>
  )
}

const CHIP =
  "relative cursor-pointer rounded-chip border border-border bg-selected px-1.25 py-px font-mono text-2xs tracking-wide text-foreground aria-[pressed=false]:bg-transparent aria-[pressed=false]:text-faint aria-[pressed=false]:line-through"

function CountedChip({
  look,
  named,
  count,
  showing,
  found,
  onToggle,
}: {
  look: ChipLook
  named: string
  count: number | null
  showing: boolean
  /** Search matches inside what it hides: 0 unless it is off. */
  found: number
  onToggle: () => void
}) {
  const badge = `${named}-prototype-matches`

  if (look === "beside") {
    return (
      <span className="inline-flex items-baseline gap-1">
        <button type="button" aria-pressed={showing} aria-describedby={found > 0 ? badge : undefined} className={CHIP} onClick={onToggle}>
          {named}
          {count !== null && <span className="ml-1 text-muted tabular-nums">{count}</span>}
        </button>
        {found > 0 && <MatchesBadge id={badge} count={found} />}
      </span>
    )
  }

  if (look === "inside") {
    return (
      <button
        type="button"
        aria-pressed={showing}
        className={cn(CHIP, "inline-flex items-baseline", found > 0 && "pr-0")}
        onClick={onToggle}
      >
        {named}
        {count !== null && <span className="ml-1 text-muted tabular-nums">{count}</span>}
        {/* Inline-block, so the off chip's strike stops at its edge. */}
        {found > 0 && (
          <span className="ml-1.25 inline-block border-l border-border bg-match px-1 text-foreground tabular-nums">
            {found === 1 ? "1 match" : `${found} matches`}
          </span>
        )}
      </button>
    )
  }

  return (
    <button type="button" aria-pressed={showing} className={cn(CHIP, found > 0 && "mr-1.5")} onClick={onToggle}>
      {named}
      {count !== null && <sup className="ml-0.5 text-[8px] text-muted tabular-nums">{count}</sup>}
      {found > 0 && (
        <span className="absolute -top-2 -right-2 inline-block min-w-3.5 rounded-full bg-match px-1 text-center font-ui text-[9px] leading-3.5 font-semibold text-foreground tabular-nums">
          {found}
        </span>
      )}
    </button>
  )
}

// ——— URL state and the bottom bar ———

function readParam<T extends string>(name: string, options: Record<T, unknown>, fallback: T): T {
  const raw = new URLSearchParams(window.location.search).get(name)
  if (raw === null) return fallback
  const key = (name === "variant" ? raw.toUpperCase() : raw) as T
  return key in options ? key : fallback
}

function writeParam(name: string, value: string) {
  const url = new URL(window.location.href)
  url.searchParams.set(name, value)
  window.history.replaceState(null, "", url)
}

export function useThinningPrototype() {
  const [variant, setVariant] = useState<Variant>(() => readParam("variant", VARIANTS, "D"))
  const [palette, setPalette] = useState<Palette>(() => readParam("palette", PALETTES, "verbs"))
  const [chip, setChip] = useState<ChipLook>(() => readParam("chip", CHIPS, "inside"))
  return {
    variant,
    palette,
    chip,

    chooseVariant(to: Variant) {
      writeParam("variant", to)
      setVariant(to)
    },
    choosePalette(to: Palette) {
      writeParam("palette", to)
      setPalette(to)
    },
    chooseChip(to: ChipLook) {
      writeParam("chip", to)
      setChip(to)
    },
  }
}

export function ThinningSwitcher({
  prototype,
  theme,
}: {
  prototype: ReturnType<typeof useThinningPrototype>
  theme: { choice: ThemeChoice; choose: (choice: ThemeChoice) => void }
}) {
  const { variant, palette, chip, chooseVariant, choosePalette, chooseChip } = prototype
  const keys = Object.keys(VARIANTS) as Variant[]
  const step = (by: number) => keys[(keys.indexOf(variant) + by + keys.length) % keys.length]!
  const dark = document.documentElement.dataset.theme === "dark"

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement
      if (target.closest("input, textarea, select, [contenteditable], [role=tablist]")) return
      if (event.key === "ArrowLeft") chooseVariant(step(-1))
      if (event.key === "ArrowRight") chooseVariant(step(1))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  if (process.env.NODE_ENV === "production") return null
  return (
    <div className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-strong px-3 py-1 text-xs whitespace-nowrap text-background shadow-dialog">
      <button type="button" className="cursor-pointer px-1" onClick={() => chooseVariant(step(-1))} aria-label="Previous variant">
        ←
      </button>
      <span className="font-semibold">
        {variant} — {VARIANTS[variant]}
      </span>
      <button type="button" className="cursor-pointer px-1" onClick={() => chooseVariant(step(1))} aria-label="Next variant">
        →
      </button>
      <label className="ml-1 flex items-center gap-1 border-l border-background/30 pl-3">
        palette
        <select
          className="cursor-pointer rounded bg-background px-1 text-foreground"
          value={palette}
          onChange={(event) => choosePalette(event.target.value as Palette)}
        >
          {(Object.keys(PALETTES) as Palette[]).map((key) => (
            <option key={key} value={key}>
              {PALETTES[key]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 border-l border-background/30 pl-3">
        chip
        <select
          className="cursor-pointer rounded bg-background px-1 text-foreground"
          value={chip}
          onChange={(event) => chooseChip(event.target.value as ChipLook)}
        >
          {(Object.keys(CHIPS) as ChipLook[]).map((key) => (
            <option key={key} value={key}>
              {CHIPS[key]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="cursor-pointer border-l border-background/30 pl-3"
        onClick={() => theme.choose(dark ? "light" : "dark")}
      >
        {dark ? "☀ light" : "☾ dark"}
      </button>
    </div>
  )
}

// ——— The canned request ———

export const SAMPLE_ROW_ID = "request prototype-orders-create"

const RUN = "prototype-run"
const TAGS = "/*action='create',application='Shop',controller='orders'*/"
let seq = 0

function envelope() {
  seq += 1
  return { v: 4, run_id: RUN, seq, at_mono: seq * 4_000_000, at_wall: 1_793_000_000_000 + seq * 4, request_id: "prototype-orders-create" }
}

function query(
  sql: string,
  name: string | null,
  { cached = false, ms = 0.4, binds = [], callsite }: { cached?: boolean; ms?: number; binds?: (string | number | null)[]; callsite?: string } = {},
): SqlEvent {
  return {
    ...envelope(),
    type: "sql",
    payload: {
      sql: `${sql} ${TAGS}`,
      name,
      duration_ms: cached ? 0 : ms,
      cached,
      async: false,
      binds,
      ...(callsite === undefined ? {} : { callsite }),
    },
  }
}

function log(message: string, source: "app" | "rails", severity: "info" | "debug" | "warn" = "info", callsite?: string): AppLogEvent {
  return {
    ...envelope(),
    type: "app_log",
    payload: { severity, message, source, tags: [], ...(callsite === undefined ? {} : { callsite }) },
  }
}

function schema(table: string): SqlEvent {
  return query(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod), pg_get_expr(d.adbin, d.adrelid), a.attnotnull, a.atttypid, a.atttypmod, c.collname, col_description(a.attrelid, a.attnum) AS comment, attidentity AS identity, attgenerated as attgenerated FROM pg_attribute a LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum LEFT JOIN pg_type t ON a.atttypid = t.oid LEFT JOIN pg_collation c ON a.attcollation = c.oid AND a.attcollation <> t.typcollation WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    "SCHEMA",
    { ms: 2.8 },
  )
}

function load(model: string, table: string, id: number, cached: boolean, callsite: string): SqlEvent {
  return query(`SELECT "${table}".* FROM "${table}" WHERE "${table}"."id" = $1 LIMIT $2`, `${model} Load`, {
    cached,
    ms: 0.3 + (id % 7) / 10,
    binds: [id, 1],
    callsite,
  })
}

function sampleTimeline(): TimelineEvent[] {
  seq = 0
  const events: TimelineEvent[] = []
  const add = (...more: TimelineEvent[]) => events.push(...more)
  const userAt = "app/controllers/application_controller.rb:31:in 'current_user'"
  const flagAt = "app/models/feature_flag.rb:12:in 'enabled?'"
  const itemAt = "app/views/carts/_item.html.erb:4"
  const lineAt = "app/views/orders/_line.html.erb:7"
  const headerAt = "app/views/layouts/_header.html.erb:18"

  add(log("Processing by OrdersController#create as TURBO_STREAM", "rails"))
  add(
    log(
      '  Parameters: {"authenticity_token" => "[FILTERED]", "order" => {"shipping_address_id" => "41", "note" => "Leave at the door"}, "commit" => "Place order"}',
      "rails",
    ),
  )
  add(schema("users"))
  add(load("User", "users", 7, false, userAt))
  add(query(`SELECT "accounts".* FROM "accounts" WHERE "accounts"."id" = $1 LIMIT $2`, "Account Load", { binds: [3, 1], callsite: userAt }))
  for (const flag of ["new_checkout", "gift_wrap", "eu_vat", "loyalty_points"]) {
    add(
      query(`SELECT "feature_flags".* FROM "feature_flags" WHERE "feature_flags"."key" = $1 LIMIT $2`, "FeatureFlag Load", {
        binds: [flag, 1],
        callsite: flagAt,
      }),
    )
  }
  for (let again = 0; again < 9; again++) {
    add(
      query(`SELECT "feature_flags".* FROM "feature_flags" WHERE "feature_flags"."key" = $1 LIMIT $2`, "FeatureFlag Load", {
        cached: true,
        binds: [["new_checkout", "eu_vat", "gift_wrap"][again % 3]!, 1],
        callsite: flagAt,
      }),
    )
  }
  add(schema("carts"))
  add(query(`SELECT "carts".* FROM "carts" WHERE "carts"."user_id" = $1 LIMIT $2`, "Cart Load", { binds: [7, 1], callsite: "app/controllers/orders_controller.rb:9:in 'create'" }))
  add(
    query(`SELECT "cart_items".* FROM "cart_items" WHERE "cart_items"."cart_id" = $1`, "CartItem Load", {
      binds: [812],
      callsite: "app/controllers/orders_controller.rb:10:in 'create'",
    }),
  )
  add(log("Checking out cart 812 with 12 items", "app", "info", "app/services/checkout.rb:18:in 'call'"))

  // The N+1: every item loads its product, variant and price — most of them a second time.
  const products = [101, 102, 101, 103, 104, 102, 105, 101, 103, 106, 104, 102]
  const seen = new Set<number>()
  for (const product of products) {
    const cached = seen.has(product)
    seen.add(product)
    add(load("Product", "products", product, cached, "app/services/checkout.rb:24:in 'block in call'"))
    add(load("Variant", "variants", product * 10, cached, "app/services/checkout.rb:25:in 'block in call'"))
    add(
      query(`SELECT "prices".* FROM "prices" WHERE "prices"."variant_id" = $1 AND "prices"."currency" = $2 LIMIT $3`, "Price Load", {
        cached,
        binds: [product * 10, "EUR", 1],
        callsite: "app/models/variant.rb:40:in 'price_in'",
      }),
    )
  }
  add(
    query(`SELECT "coupons".* FROM "coupons" WHERE "coupons"."code" = $1 AND "coupons"."expires_at" > $2 LIMIT $3`, "Coupon Load", {
      binds: ["AUTUMN10", "2026-10-29 19:21:04.118302", 1],
      callsite: "app/services/checkout.rb:31:in 'call'",
    }),
  )

  // The order itself: a transaction that commits.
  add(query("BEGIN", "TRANSACTION", { ms: 0.1 }))
  add(
    query(`SELECT 1 AS one FROM "orders" WHERE "orders"."idempotency_key" = $1 LIMIT $2`, "Order Exists?", {
      binds: ["c0a8f3e2-71d4-4b8e-9b1e-5d2f8a6c4e19", 1],
      callsite: "app/models/order.rb:22",
    }),
  )
  add(schema("orders"))
  add(
    query(
      `INSERT INTO "orders" ("user_id", "cart_id", "shipping_address_id", "coupon_id", "total_cents", "currency", "note", "idempotency_key", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING "id"`,
      "Order Create",
      {
        ms: 1.9,
        binds: [7, 812, 41, 5, 18470, "EUR", "Leave at the door", "c0a8f3e2-71d4-4b8e-9b1e-5d2f8a6c4e19", "2026-10-29 19:21:04.31", "2026-10-29 19:21:04.31"],
        callsite: "app/services/checkout.rb:44:in 'call'",
      },
    ),
  )
  for (const product of [101, 102, 103, 104, 105, 106]) {
    add(
      query(
        `SELECT "inventory_levels".* FROM "inventory_levels" WHERE "inventory_levels"."variant_id" = $1 LIMIT $2 FOR UPDATE`,
        "InventoryLevel Load",
        { binds: [product * 10, 1], ms: 0.6, callsite: "app/services/checkout.rb:51:in 'block in call'" },
      ),
    )
  }
  add(
    query(
      `UPDATE "inventory_levels" SET "quantity" = COALESCE("quantity", 0) - 1, "updated_at" = $1 WHERE "inventory_levels"."variant_id" IN ($2, $3, $4, $5, $6, $7)`,
      "InventoryLevel Update All",
      { ms: 1.2, binds: ["2026-10-29 19:21:04.33", 1010, 1020, 1030, 1040, 1050, 1060], callsite: "app/services/checkout.rb:55:in 'call'" },
    ),
  )
  add(query("COMMIT", "TRANSACTION", { ms: 2.3 }))
  add(log("Order 5531 placed for user 7 (18470 EUR cents)", "app", "info", "app/services/checkout.rb:60:in 'call'"))

  // Emptying the cart.
  add(
    query(`DELETE FROM "cart_items" WHERE "cart_items"."cart_id" = $1`, "CartItem Delete All", {
      ms: 0.9,
      binds: [812],
      callsite: "app/services/checkout.rb:63:in 'call'",
    }),
  )

  // Rendering: the order's lines, each looking its product up again.
  add(query(`SELECT "orders".* FROM "orders" WHERE "orders"."id" = $1 LIMIT $2`, "Order Load", { binds: [5531, 1], callsite: "app/controllers/orders_controller.rb:14:in 'create'" }))
  add(query(`SELECT "addresses".* FROM "addresses" WHERE "addresses"."id" = $1 LIMIT $2`, "Address Load", { binds: [41, 1], callsite: "app/views/orders/create.turbo_stream.erb:3" }))
  add(
    query(`SELECT "order_lines".* FROM "order_lines" WHERE "order_lines"."order_id" = $1`, "OrderLine Load", {
      binds: [5531],
      callsite: "app/views/orders/create.turbo_stream.erb:9",
    }),
  )
  for (const product of products) {
    add(load("Product", "products", product, true, lineAt))
    add(load("Variant", "variants", product * 10, true, lineAt))
    add(
      query(`SELECT "product_images".* FROM "product_images" WHERE "product_images"."product_id" = $1 ORDER BY "product_images"."position" ASC LIMIT $2`, "ProductImage Load", {
        cached: product !== 101 && products.indexOf(product) !== products.lastIndexOf(product),
        binds: [product, 1],
        callsite: itemAt,
      }),
    )
  }
  add(log("Rendered orders/_line.html.erb collection of 12 [3 times] (Duration: 188.2ms | GC: 2.0ms)", "rails"))
  add(log("Sending order confirmation for 5531", "app", "info", "app/services/checkout.rb:70:in 'call'"))

  // The notification: a transaction that silently rolls back, opened by a prepended QueryLogs comment.
  add(query("BEGIN", "TRANSACTION", { ms: 0.1 }))
  add(load("NotificationPreference", "notification_preferences", 7, false, "app/models/notification.rb:15"))
  add({
    ...envelope(),
    type: "sql",
    payload: {
      sql: `${TAGS} INSERT INTO "notifications" ("user_id", "kind", "subject_type", "subject_id", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6) RETURNING "id"`,
      name: "Notification Create",
      duration_ms: 0.8,
      cached: false,
      async: false,
      binds: [7, "order_placed", "Order", 5531, "2026-10-29 19:21:04.52", "2026-10-29 19:21:04.52"],
      callsite: "app/models/notification.rb:21:in 'deliver'",
    },
  })
  add(query(`SELECT COUNT(*) FROM "notifications" WHERE "notifications"."user_id" = $1 AND "notifications"."read_at" IS NULL`, "Notification Count", { binds: [7], callsite: "app/models/notification.rb:30" }))
  add(query("ROLLBACK", "TRANSACTION", { ms: 0.2 }))

  // The recommendations sidebar: products not in the order, so mostly queries that ran.
  add(
    query(`SELECT "products"."id" FROM "products" INNER JOIN "recommendations" ON "recommendations"."product_id" = "products"."id" WHERE "recommendations"."user_id" = $1 ORDER BY "recommendations"."score" DESC LIMIT $2`, "Product Pluck", {
      ms: 4.7,
      binds: [7, 10],
      callsite: "app/views/orders/_recommended.html.erb:2",
    }),
  )
  for (const product of [210, 211, 102, 212, 213, 214, 104, 215, 216, 217]) {
    const again = product < 200
    add(load("Product", "products", product, again, "app/views/orders/_recommended.html.erb:5"))
    add(
      query(`SELECT "prices".* FROM "prices" WHERE "prices"."variant_id" = $1 AND "prices"."currency" = $2 LIMIT $3`, "Price Load", {
        cached: again,
        binds: [product * 10, "EUR", 1],
        callsite: "app/models/variant.rb:40:in 'price_in'",
      }),
    )
    add(
      query(`SELECT "product_images".* FROM "product_images" WHERE "product_images"."product_id" = $1 ORDER BY "product_images"."position" ASC LIMIT $2`, "ProductImage Load", {
        cached: again,
        binds: [product, 1],
        callsite: "app/views/orders/_recommended.html.erb:6",
      }),
    )
  }
  add(log("Rendered orders/_recommended.html.erb (Duration: 61.0ms | GC: 0.4ms)", "rails"))

  // The layout's header and footer, after the body: the same few lookups, over and over.
  for (let partial = 0; partial < 18; partial++) {
    add(load("User", "users", 7, true, headerAt))
    add(
      query(`SELECT COUNT(*) FROM "notifications" WHERE "notifications"."user_id" = $1 AND "notifications"."read_at" IS NULL`, "Notification Count", {
        cached: partial > 0,
        binds: [7],
        callsite: headerAt,
      }),
    )
    if (partial % 3 === 0) {
      add(
        query(`SELECT "categories".* FROM "categories" WHERE "categories"."parent_id" IS NULL ORDER BY "categories"."position" ASC`, "Category Load", {
          cached: partial > 0,
          callsite: "app/views/layouts/_nav.html.erb:6",
        }),
      )
    }
  }
  for (const flag of ["new_checkout", "gift_wrap", "loyalty_points"]) {
    add(
      query(`SELECT "feature_flags".* FROM "feature_flags" WHERE "feature_flags"."key" = $1 LIMIT $2`, "FeatureFlag Load", {
        cached: true,
        binds: [flag, 1],
        callsite: flagAt,
      }),
    )
  }
  add(schema("order_lines"))
  add(log("Rendered orders/create.turbo_stream.erb within layouts/application (Duration: 412.3ms | GC: 4.1ms)", "rails"))
  const sql = events.filter((event): event is SqlEvent => event.type === "sql" && event.payload.name !== "SCHEMA")
  const cachedCount = sql.filter((event) => event.payload.cached).length
  add(log(`Completed 200 OK in 1203ms (Views: 690.1ms | ActiveRecord: 288.4ms (${sql.length} queries, ${cachedCount} cached) | GC: 12.0ms)`, "rails"))
  return events
}

function sampleRow(): RequestRow {
  const timeline = sampleTimeline()
  return {
    kind: "request",
    id: SAMPLE_ROW_ID,
    requestId: "prototype-orders-create",
    runId: RUN,
    state: "finished",
    partial: false,
    overBound: false,
    provenElapsed: { ms: 1203, atWall: 1_793_000_000_000 },
    startedAtWall: 1_793_000_000_000,
    method: "POST",
    path: "/orders",
    controller: "OrdersController",
    action: "create",
    params: { order: { shipping_address_id: "41", note: "Leave at the door" }, commit: "Place order" },
    status: 200,
    durationMs: 1203.4,
    dbRuntimeMs: 288.4,
    viewRuntimeMs: 690.1,
    sqlCount: timeline.filter((event) => event.type === "sql").length,
    logCount: timeline.filter((event) => event.type === "app_log").length,
    timeline,
    trailing: [],
    exception: null,
    backtraceCutFrom: null,
    response: null,
    railsRoot: null,
  }
}

const SAMPLE = sampleRow()

/** The live rows, with the canned one after them, so it is the newest in the table. */
export function withSampleRow(rows: readonly ActivityRow[]): ActivityRow[] {
  return [...rows, SAMPLE]
}
