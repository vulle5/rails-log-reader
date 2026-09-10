import type { BindValue, Envelope, EventType, Severity } from "../src/shared/wire"
import { BOOT_MONO, EPOCH } from "./sidecar.fixtures"

/**
 * The seed: `prototype/reader-layout`'s replay stream, carried forward as Sidecar
 * envelopes.
 *
 * The prototype's own comment says why it is this dense — "the crafted scenarios above are
 * too quiet to judge anything by", and the quiet original flattered every design. The same
 * is true of a test: a fold that holds up over four hand-written events proves very little
 * about one reading a busy dev app. So the whole stream is here, its crafted scenarios
 * still buried in ordinary traffic: four requests in flight at once, an N+1 shape, a 500
 * with a backtrace, a request that hangs, a `rake` Run and a `rails console` Run writing
 * into the same file as the server.
 *
 * Three things are ported rather than copied, because the prototype predates the wire:
 *
 * - its `req_start` carried the controller, which the wire splits into `request_start` and
 *   `request_route` — and that split is what lets this seed carry a request that **never
 *   routed**, the case the prototype had no way to express;
 * - its SQL text carried its own binds, the way `development.log` prints them; here they
 *   are a `binds` array, which is where the Initializer puts them;
 * - `seq` restarts at 1 in each of the three Runs, so the file's own append order is the
 *   only thing that orders them against each other.
 */

export const SERVER_RUN = "srv-91204"
export const RAKE_RUN = "rake-91887"
export const CONSOLE_RUN = "con-92014"

type Emission = {
  at: number
  runId: string
  /** Set only where a test is about `at_wall` disagreeing with append order. */
  wall?: number
  requestId: string | null
  type: EventType
  payload: unknown
}

const emissions: Emission[] = []

/**
 * Generic in the event type, so `tsc` checks every payload below against the wire — which
 * is half of what guards the contract, exactly as `wire.fixtures.ts` says of itself.
 */
function emit<T extends EventType>(emission: {
  at: number
  runId: string
  wall?: number
  requestId: string | null
  type: T
  payload: Extract<Envelope, { type: T }>["payload"]
}) {
  emissions.push(emission)
}

// ---- the server Run -------------------------------------------------------

function start(at: number, requestId: string, method: string, path: string, wall?: number) {
  emit({ at, runId: SERVER_RUN, wall, requestId, type: "request_start", payload: { method, path } })
}

/** Emitted only when a controller is entered, so leaving it out is how a 404 is written. */
function route(at: number, requestId: string, controller: string, action: string, format = "html") {
  emit({
    at,
    runId: SERVER_RUN,
    requestId,
    type: "request_route",
    payload: { controller, action, format, params: {} },
  })
}

function finish(
  at: number,
  requestId: string,
  status: number,
  durationMs: number,
  viewMs: number,
  dbMs: number,
  exception?: { class: string; message: string; backtrace: string[] },
) {
  emit({
    at,
    runId: SERVER_RUN,
    requestId,
    type: "request_finish",
    payload: {
      status,
      duration_ms: durationMs,
      view_runtime_ms: viewMs,
      db_runtime_ms: dbMs,
      ...(exception === undefined ? {} : { exception }),
    },
  })
}

function sql(
  at: number,
  requestId: string | null,
  name: string,
  text: string,
  durationMs: number,
  cached = false,
  runId = SERVER_RUN,
) {
  const [statement, binds] = splitBinds(text)
  emit({
    at,
    runId,
    requestId,
    type: "sql",
    payload: {
      sql: statement,
      name,
      duration_ms: durationMs,
      cached,
      async: false,
      row_count: 1,
      binds,
    },
  })
}

function log(
  at: number,
  requestId: string | null,
  severity: Severity,
  message: string,
  runId = SERVER_RUN,
  wall?: number,
) {
  emit({
    at,
    runId,
    wall,
    requestId,
    type: "app_log",
    payload: { severity, message, source: sourceOf(message), tags: [] },
  })
}

function header(at: number, runId: string, kind: "server" | "console" | "rake", pid: number) {
  emit({
    at,
    runId,
    requestId: null,
    type: "run_header",
    payload: {
      kind,
      rails_version: "8.0.2",
      app_name: "ExampleApp",
      rails_root: "/home/dev/example-app",
      pid,
    },
  })
}

/**
 * The prototype's SQL text carried its binds the way `development.log` prints them; the
 * wire keeps the statement raw and the values apart. `Rails.logger`'s own origin is read
 * from `caller_locations` by the Initializer and is guessed here from the line's shape,
 * which is the one thing the Initializer refuses to do — a fixture may, since it is
 * writing down what the answer was, not deciding it.
 */
function splitBinds(text: string): [string, BindValue[]] {
  const suffix = text.indexOf("  [[")
  if (suffix === -1) return [text, []]

  const binds = [...text.slice(suffix).matchAll(/\["[^"]*",\s*([^\]]*)\]/g)].map((match) => {
    const value = (match[1] ?? "").trim()
    try {
      return JSON.parse(value) as BindValue
    } catch {
      return value
    }
  })
  return [text.slice(0, suffix), binds]
}

const RAILS_OWN = [/^=> /, /^\[ActiveJob\]/, /^Rendering /, /^Started /, /^Listening /, /^Loading /, /^DEPRECATION/]

function sourceOf(message: string): "app" | "rails" {
  return RAILS_OWN.some((shape) => shape.test(message)) ? "rails" : "app"
}

// --- boot noise: unattributed, before any request ---------------------------
header(0, SERVER_RUN, "server", 48_211)
log(0, null, "info", "=> Booting Puma")
log(60, null, "info", "=> Rails 8.0.2 application starting in development")
log(120, null, "info", "=> Run `bin/rails server --help` for more startup options")
sql(400, null, "SCHEMA", "SELECT sqlite_version(*)", 0.3)
log(900, null, "info", "Listening on http://127.0.0.1:3000")

// --- the money shot: four requests in flight at once, queries interleaved ----
const A = "a1b2c3d4"
const B = "b7f0e112"
const C = "c3319a05"
const D = "d90ff4e6"

start(2000, A, "GET", "/api/v1/feed?page=1")
route(2010, A, "Api::V1::FeedController", "index", "json")
start(2040, B, "GET", "/api/v1/notifications")
route(2050, B, "Api::V1::NotificationsController", "index", "json")
start(2090, C, "GET", "/api/v1/me")
route(2100, C, "Api::V1::MeController", "show", "json")
start(2150, D, "POST", "/api/v1/analytics/events")
route(2160, D, "Api::V1::AnalyticsController", "create", "json")

sql(2210, A, "User Load", 'SELECT "users".* FROM "users" WHERE "users"."id" = ? LIMIT ?  [["id", 4021], ["LIMIT", 1]]', 0.6)
sql(2240, C, "User Load", 'SELECT "users".* FROM "users" WHERE "users"."id" = ? LIMIT ?  [["id", 4021], ["LIMIT", 1]]', 0.4)
sql(2270, B, "User Load", 'SELECT "users".* FROM "users" WHERE "users"."id" = ? LIMIT ?  [["id", 4021], ["LIMIT", 1]]', 0.4, true)
log(2290, D, "info", "AnalyticsController#create payload: 14 events, 3.2kb")
sql(2320, A, "Post Load", 'SELECT "posts".* FROM "posts" WHERE "posts"."published" = ? ORDER BY "posts"."created_at" DESC LIMIT ? OFFSET ?  [["published", 1], ["LIMIT", 20], ["OFFSET", 0]]', 4.1)
sql(2360, B, "Notification Load", 'SELECT "notifications".* FROM "notifications" WHERE "notifications"."user_id" = ? AND "notifications"."read_at" IS NULL ORDER BY "notifications"."created_at" DESC  [["user_id", 4021]]', 1.9)
sql(2400, C, "Profile Load", 'SELECT "profiles".* FROM "profiles" WHERE "profiles"."user_id" = ? LIMIT ?  [["user_id", 4021], ["LIMIT", 1]]', 0.5)
sql(2430, D, "AnalyticsEvent Create", 'INSERT INTO "analytics_events" ("name", "user_id", "payload", "created_at") VALUES (?, ?, ?, ?)', 1.2)
sql(2470, C, "Subscription Load", 'SELECT "subscriptions".* FROM "subscriptions" WHERE "subscriptions"."user_id" = ? AND "subscriptions"."active" = ? LIMIT ?  [["user_id", 4021], ["active", 1], ["LIMIT", 1]]', 0.7)
finish(2560, C, 200, 470, 1.1, 1.6)
sql(2600, D, "AnalyticsEvent Create", 'INSERT INTO "analytics_events" ("name", "user_id", "payload", "created_at") VALUES (?, ?, ?, ?)', 0.9)
finish(2680, B, 200, 640, 12.4, 2.3)
finish(2760, D, 201, 610, 0.4, 8.8)

// --- A keeps going: the ~30 query N+1, with logger calls sandwiched in -------
log(2800, A, "info", "Feed cache MISS for user 4021 (key: feed/v3/4021/page/1)")
for (let i = 0; i < 20; i += 1) {
  sql(
    2860 + i * 55,
    A,
    "Author Load",
    `SELECT "users".* FROM "users" WHERE "users"."id" = ? LIMIT ?  [["id", ${5100 + i * 7}], ["LIMIT", 1]]`,
    0.3 + (i % 4) * 0.1,
  )
  if (i === 6) log(2860 + i * 55 + 20, A, "warn", "N+1 suspected: Post#author loaded 7 times without includes")
  if (i === 13) log(2860 + i * 55 + 20, A, "debug", "FeedSerializer: 14/20 posts serialized")
}
sql(4020, A, "ActiveStorage::Attachment Load", 'SELECT "active_storage_attachments".* FROM "active_storage_attachments" WHERE "active_storage_attachments"."record_type" = ? AND "active_storage_attachments"."record_id" IN (?, ?, ?, ?, ?)', 2.8)
log(4090, A, "info", "Feed cache WRITE (key: feed/v3/4021/page/1, ttl: 300s)")
sql(4140, A, "Post Count", 'SELECT COUNT(*) FROM "posts" WHERE "posts"."published" = ?  [["published", 1]]', 1.4)
finish(4220, A, 200, 2220, 38.6, 41.2)

// --- unattributed background job noise --------------------------------------
log(4400, null, "info", "[ActiveJob] [DeliverWebhookJob] [9f2c1a] Performing DeliverWebhookJob")
sql(4460, null, "Webhook Load", 'SELECT "webhooks".* FROM "webhooks" WHERE "webhooks"."endpoint_id" = ?  [["endpoint_id", 88]]', 0.8)
log(4560, null, "info", "[ActiveJob] [DeliverWebhookJob] [9f2c1a] Performed DeliverWebhookJob in 141.2ms")

// --- a 500 with a backtrace --------------------------------------------------
const E = "e5510b77"
start(5000, E, "POST", "/api/v1/orders")
route(5010, E, "Api::V1::OrdersController", "create", "json")
sql(5060, E, "User Load", 'SELECT "users".* FROM "users" WHERE "users"."id" = ? LIMIT ?  [["id", 4021], ["LIMIT", 1]]', 0.4)
log(5100, E, "info", "OrdersController#create for cart 77213")
sql(5150, E, "Cart Load", 'SELECT "carts".* FROM "carts" WHERE "carts"."id" = ? LIMIT ?  [["id", 77213], ["LIMIT", 1]]', 0.6)
sql(5210, E, "TRANSACTION", "BEGIN", 0.1)
sql(5260, E, "Order Create", 'INSERT INTO "orders" ("cart_id", "user_id", "total_cents", "created_at") VALUES (?, ?, ?, ?)', 1.7)
sql(5330, E, "TRANSACTION", "ROLLBACK", 0.1)

const BACKTRACE = [
  "app/models/order.rb:44:in `block in recalculate_total!'",
  "app/models/order.rb:43:in `each'",
  "app/models/order.rb:43:in `recalculate_total!'",
  "app/controllers/api/v1/orders_controller.rb:19:in `create'",
  "actionpack (8.0.2) lib/action_controller/metal/basic_implicit_render.rb:6:in `send_action'",
  "actionpack (8.0.2) lib/abstract_controller/base.rb:226:in `process_action'",
  "actionpack (8.0.2) lib/action_controller/metal/rendering.rb:193:in `process_action'",
  "activesupport (8.0.2) lib/active_support/callbacks.rb:120:in `run_callbacks'",
  "actionpack (8.0.2) lib/action_controller/metal/rescue.rb:23:in `process_action'",
  "railties (8.0.2) lib/rails/rack/logger.rb:41:in `call_app'",
  "puma (6.6.0) lib/puma/configuration.rb:279:in `call'",
  "puma (6.6.0) lib/puma/server.rb:443:in `process_client'",
]
log(5380, E, "error", "NoMethodError (undefined method `price_cents' for nil):")
finish(5460, E, 500, 460, 0.8, 2.9, {
  class: "NoMethodError",
  message: "undefined method `price_cents' for nil",
  backtrace: BACKTRACE,
})

// --- the hanging request: starts, emits, never finishes ----------------------
const H = "f0ad9c31"
start(6000, H, "GET", "/admin/reports/monthly.csv")
route(6010, H, "Admin::ReportsController", "monthly", "csv")
log(6080, H, "info", "Building monthly report for 2026-07 (this may take a while)")
sql(6200, H, "Order Load", 'SELECT "orders".* FROM "orders" WHERE ("orders"."created_at" BETWEEN ? AND ?)', 812.4)
log(7100, H, "debug", "ReportBuilder: 41,209 orders loaded, aggregating")
sql(7400, H, "LineItem Load", 'SELECT "line_items".* FROM "line_items" WHERE "line_items"."order_id" IN (SELECT "orders"."id" FROM "orders" WHERE ("orders"."created_at" BETWEEN ? AND ?))', 4210.7)
log(11800, H, "warn", "ReportBuilder: still aggregating (41,209 orders, 0 rows written)")
// ...and nothing more. This one hangs.

// --- a request that never reached a controller ------------------------------
// Not in the prototype, which had no way to say it: its req_start carried the controller,
// so a routing failure could not be written down. Buried in the traffic like the rest.
const MISTYPED = "9c1e04ab"
start(6400, MISTYPED, "GET", "/api/v1/notifcations")
finish(6470, MISTYPED, 404, 7.2, 0, 0)

// --- some late traffic so the hang is visible above live rows ---------------
const F = "1b4d77aa"
start(8000, F, "GET", "/api/v1/feed?page=2")
route(8010, F, "Api::V1::FeedController", "index", "json")
sql(8070, F, "User Load", 'SELECT "users".* FROM "users" WHERE "users"."id" = ? LIMIT ?  [["id", 4021], ["LIMIT", 1]]', 0.3, true)
sql(8130, F, "Post Load", 'SELECT "posts".* FROM "posts" WHERE "posts"."published" = ? ORDER BY "posts"."created_at" DESC LIMIT ? OFFSET ?  [["published", 1], ["LIMIT", 20], ["OFFSET", 20]]', 3.6)
log(8200, F, "info", "Feed cache HIT for user 4021 (key: feed/v3/4021/page/2)")
finish(8290, F, 200, 290, 9.1, 3.9)

const G = "77c0de91"
start(9000, G, "DELETE", "/api/v1/sessions/current")
route(9010, G, "Api::V1::SessionsController", "destroy", "json")
sql(9060, G, "Session Destroy", 'DELETE FROM "sessions" WHERE "sessions"."id" = ?  [["id", 90211]]', 0.9)
log(9110, G, "info", "Signed out user 4021")
finish(9180, G, 204, 180, 0.0, 0.9)

// The one place `at_wall` disagrees with append order: the machine's clock is stepped back
// two seconds by NTP while this request is being served. Nothing may reorder because of it.
const I = "2ee81b40"
start(10_000, I, "GET", "/api/v1/search?q=rails+logs", EPOCH + 8_000)
route(10_010, I, "Api::V1::SearchController", "index", "json")
log(10_060, I, "info", 'Search query: "rails logs" (user 4021)', SERVER_RUN, EPOCH + 8_060)
sql(10_140, I, "Post Search", 'SELECT "posts".* FROM "posts" WHERE (to_tsvector(body) @@ plainto_tsquery(?)) LIMIT ?  [["q", "rails logs"], ["LIMIT", 25]]', 62.9)
log(10_260, I, "warn", 'Slow search: 62.9ms for "rails logs" — consider an index')
sql(10_330, I, "User Load", 'SELECT "users".* FROM "users" WHERE "users"."id" IN (?, ?, ?, ?)', 0.7)
finish(10_420, I, 200, 420, 6.2, 63.6)

// --- background traffic -----------------------------------------------------
// The crafted scenarios above are too quiet to judge anything by. A real dev app under a
// mobile client emits constantly, so this fills the timeline with ordinary noise: short
// requests, chatty logger calls, and unattributed job output.

const PATHS: [string, string, string, string][] = [
  ["GET", "/api/v1/feed?page=1", "Api::V1::FeedController", "index"],
  ["GET", "/api/v1/me", "Api::V1::MeController", "show"],
  ["GET", "/api/v1/notifications", "Api::V1::NotificationsController", "index"],
  ["POST", "/api/v1/analytics/events", "Api::V1::AnalyticsController", "create"],
  ["GET", "/api/v1/conversations", "Api::V1::ConversationsController", "index"],
  ["GET", "/api/v1/conversations/812/messages", "Api::V1::MessagesController", "index"],
  ["PATCH", "/api/v1/me/settings", "Api::V1::SettingsController", "update"],
  ["GET", "/api/v1/uploads/presign", "Api::V1::UploadsController", "presign"],
  ["GET", "/health", "HealthController", "show"],
]

const CHATTER: [Severity, string][] = [
  ["debug", "CACHE GET feed/v3/4021 -> hit"],
  ["info", "Authenticated user 4021 via bearer token"],
  ["debug", "Serializer: 20 records in 4.1ms"],
  ["info", "Rendering JSON (0 templates)"],
  ["debug", "Rack::Attack: throttle check passed (127.0.0.1)"],
  ["debug", "Marking notification 9912 as delivered"],
  ["info", "Enqueued TrackEventJob (Job ID: 7a1f) to Async(default)"],
  ["debug", "Redis GET session:4021 (0.2ms)"],
  ["warn", "Deprecated param `sort_by` used by client 3.11.0"],
  ["debug", "ETag miss, rendering fresh body"],
]

const QUERIES: [string, string][] = [
  ["User Load", 'SELECT "users".* FROM "users" WHERE "users"."id" = ? LIMIT ?  [["id", 4021], ["LIMIT", 1]]'],
  ["Session Load", 'SELECT "sessions".* FROM "sessions" WHERE "sessions"."token" = ? LIMIT ?  [["token", "…"], ["LIMIT", 1]]'],
  ["Conversation Load", 'SELECT "conversations".* FROM "conversations" WHERE "conversations"."user_id" = ? ORDER BY "conversations"."updated_at" DESC LIMIT ?  [["user_id", 4021], ["LIMIT", 30]]'],
  ["Message Load", 'SELECT "messages".* FROM "messages" WHERE "messages"."conversation_id" = ? ORDER BY "messages"."created_at" ASC  [["conversation_id", 812]]'],
  ["Setting Update", 'UPDATE "settings" SET "digest_frequency" = ?, "updated_at" = ? WHERE "settings"."id" = ?'],
  ["Notification Count", 'SELECT COUNT(*) FROM "notifications" WHERE "notifications"."user_id" = ? AND "notifications"."read_at" IS NULL'],
]

/** The prototype's own PRNG, so the seed is the same stream on every run. */
let seed = 1337
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = <T>(choices: T[]): T => choices[Math.floor(random() * choices.length)] as T

for (let n = 0; n < 46; n += 1) {
  const at = 1800 + Math.floor(random() * 10600)
  const requestId = Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")
  const [method, path, controller, action] = pick(PATHS)
  start(at, requestId, method, path)
  route(at + 6, requestId, controller, action, "json")

  let t = at
  const howMany = 2 + Math.floor(random() * 6)
  let dbMs = 0
  for (let i = 0; i < howMany; i += 1) {
    t += 15 + Math.floor(random() * 70)
    if (random() < 0.55) {
      const [name, statement] = pick(QUERIES)
      const duration = Math.round((0.2 + random() * 3.5) * 10) / 10
      dbMs += duration
      sql(t, requestId, name, statement, duration, random() < 0.2)
    } else {
      const [severity, message] = pick(CHATTER)
      log(t, requestId, severity, message)
    }
  }
  t += 20 + Math.floor(random() * 60)
  finish(t, requestId, random() < 0.04 ? 422 : 200, t - at, Math.round(random() * 90) / 10, Math.round(dbMs * 10) / 10)
}

// unattributed background noise, steadily, the whole time
const JOBS = ["TrackEventJob", "DeliverWebhookJob", "RefreshFeedCacheJob", "PurgeUploadsJob", "SendDigestJob"]
for (let n = 0; n < 26; n += 1) {
  const at = 1000 + n * 440 + Math.floor(random() * 200)
  const job = pick(JOBS)
  const jobId = Math.floor(random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")
  log(at, null, "info", `[ActiveJob] [${job}] [${jobId}] Performing ${job}`)
  if (random() < 0.6) sql(at + 30 + Math.floor(random() * 40), null, "Job Load", pick(QUERIES)[1], Math.round(random() * 20) / 10)
  log(at + 80 + Math.floor(random() * 160), null, "info", `[ActiveJob] [${job}] [${jobId}] Performed ${job} in ${Math.round(random() * 900) / 10}ms`)
}

// --- the second Run: a long rake task, interleaved with live traffic ---------
// It starts mid-stream and is still running when the stream ends. Every event of it is
// unattributed — there is no request — and its `seq` counts from 1 while the server's is
// already in the hundreds, which is the whole reason append order is the global key.
header(3200, RAKE_RUN, "rake", 91_887)
log(3200, null, "info", "rake reports:rebuild — 41,209 orders to process", RAKE_RUN)
for (let n = 0; n < 118; n += 1) {
  const at = 3260 + n * 78 + Math.floor(random() * 40)
  const [name, statement] = pick(QUERIES)
  sql(at, null, name, statement, Math.round((0.2 + random() * 6) * 10) / 10, false, RAKE_RUN)
  if (n % 12 === 5) {
    log(
      at + 20,
      null,
      "info",
      `reports:rebuild — ${(n + 1) * 340} / 41,209 orders (${Math.round(((n + 1) / 118) * 100)}%)`,
      RAKE_RUN,
    )
  }
  if (n === 61) log(at + 30, null, "warn", "reports:rebuild — batch 62 retried after a lock timeout", RAKE_RUN)
}

// --- a third Run: someone poking at `rails c` while all this happens ---------
header(7300, CONSOLE_RUN, "console", 92_014)
log(7300, null, "info", "Loading development environment (Rails 8.0.2)", CONSOLE_RUN)
sql(8100, null, "User Load", 'SELECT "users".* FROM "users" WHERE "users"."email" = ? LIMIT ?  [["email", "…"], ["LIMIT", 1]]', 1.1, false, CONSOLE_RUN)
sql(9450, null, "Order Count", 'SELECT COUNT(*) FROM "orders" WHERE "orders"."user_id" = ?  [["user_id", 4021]]', 3.4, false, CONSOLE_RUN)
log(9500, null, "warn", "DEPRECATION WARNING: Rails.application.config_for called with a String", CONSOLE_RUN)
sql(11_200, null, "Order Update", 'UPDATE "orders" SET "state" = ?, "updated_at" = ? WHERE "orders"."id" = ?', 2.2, false, CONSOLE_RUN)

// ---- the file --------------------------------------------------------------

/**
 * Every emission in append order, stamped as the Initializer would: `seq` per Run, both
 * clocks off the emission's own moment. Sorting happens exactly here and never again —
 * this stands in for the kernel serialising three processes' `O_APPEND` writes.
 */
export const DENSE_TRAFFIC: Envelope[] = (() => {
  const perRun = new Map<string, number>()

  return [...emissions]
    .sort((one, other) => one.at - other.at)
    .map((emission) => {
      const seq = (perRun.get(emission.runId) ?? 0) + 1
      perRun.set(emission.runId, seq)

      return {
        v: 2,
        run_id: emission.runId,
        seq,
        at_mono: BOOT_MONO + emission.at * 1_000_000,
        at_wall: emission.wall ?? EPOCH + emission.at,
        request_id: emission.requestId,
        type: emission.type,
        payload: emission.payload,
      } as Envelope
    })
})()

/** The request whose `at_wall` was stepped backwards, for the test that says so. */
export const CLOCK_STEPPED_BACK = { requestId: I, path: "/api/v1/search?q=rails+logs" }

/** The request that never reached a controller. */
export const NEVER_ROUTED = { requestId: MISTYPED, path: "/api/v1/notifcations" }

/** The request that starts, emits, and never finishes. */
export const HANGS = { requestId: H, path: "/admin/reports/monthly.csv" }
