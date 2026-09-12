import type { Envelope } from "../src/shared/wire"

const RUN_ID = "6f1a2c30-4b8e-4a11-9d0e-2f7c5a9b1e44"
const REQUEST_ID = "b3d9f0c2-71a4-4f2d-8f2a-1c6e0d5b7a93"

/**
 * One envelope per event type, as the Initializer would write it for the Example app.
 * `tsc` checking this file against `Envelope` is half of what guards the contract.
 */
export const SAMPLE_ENVELOPES: Envelope[] = [
  {
    v: 3,
    run_id: RUN_ID,
    seq: 1,
    at_mono: 118_492_300_000,
    at_wall: 1_756_915_200_123,
    request_id: null,
    type: "run_header",
    payload: {
      kind: "server",
      rails_version: "8.0.2",
      app_name: "ExampleApp",
      rails_root: "/home/dev/rails-log-reader/example-app",
      pid: 48211,
    },
  },
  {
    v: 3,
    run_id: RUN_ID,
    seq: 2,
    at_mono: 118_492_400_000,
    at_wall: 1_756_915_200_140,
    request_id: REQUEST_ID,
    type: "request_start",
    payload: { method: "GET", path: "/posts/12" },
  },
  {
    v: 3,
    run_id: RUN_ID,
    seq: 3,
    at_mono: 118_493_100_000,
    at_wall: 1_756_915_200_148,
    request_id: REQUEST_ID,
    type: "request_route",
    payload: { controller: "PostsController", action: "show", format: "html", params: { id: "12" } },
  },
  {
    v: 3,
    run_id: RUN_ID,
    seq: 4,
    at_mono: 118_494_050_000,
    at_wall: 1_756_915_200_152,
    request_id: REQUEST_ID,
    type: "sql",
    payload: {
      sql: 'SELECT "posts".* FROM "posts" WHERE "posts"."id" = ? LIMIT ?',
      name: "Post Load",
      duration_ms: 0.41,
      cached: false,
      async: false,
      row_count: 1,
      binds: [12, 1],
    },
  },
  {
    v: 3,
    run_id: RUN_ID,
    seq: 5,
    at_mono: 118_494_900_000,
    at_wall: 1_756_915_200_161,
    request_id: REQUEST_ID,
    type: "app_log",
    payload: {
      severity: "info",
      message: "Rendering posts/show.html.erb within layouts/application",
      source: "rails",
      tags: [],
    },
  },
  {
    v: 3,
    run_id: RUN_ID,
    seq: 6,
    at_mono: 118_501_700_000,
    at_wall: 1_756_915_200_219,
    request_id: REQUEST_ID,
    type: "request_finish",
    payload: { status: 200, duration_ms: 78.3, view_runtime_ms: 61.2, db_runtime_ms: 1.4 },
  },
  {
    v: 3,
    run_id: RUN_ID,
    seq: 7,
    at_mono: 902_118_400_000,
    at_wall: 1_756_915_984_002,
    request_id: null,
    type: "run_end",
    payload: {},
  },
]
