# Capturing Rack response bodies in the Initializer

Research for **Research: Capturing Rack response bodies in the Initializer** (#139), on the
map **Map: Rails log reader V2 — a developer tool** (#137). It feeds the decision ticket
**Grill: Which responses are captured, and where their bodies live** (#145), and does not
settle it: where bodies are stored, which content types are captured and what the caps are
belong there. Options and their costs are laid out below, with one leaning, marked as such.

The question: how can the Initializer capture a response's headers and body without changing
what the client receives, and without breaking standing constraint 1 (`development.log` stays
pristine) or 2 (inert unless the *Marker file* exists)?

## How this was checked

Every claim is tagged with how it was established:

- **[E]** verified by experiment in this repo. The scripts and their verbatim output live in
  [`capturing-rack-response-bodies/`](capturing-rack-response-bodies/).
- **[S]** read from primary source: the Rack spec, the released gem source of rack, rails,
  puma and the prior-art gems, at the versions cited.

The experiments:

- **`probe.rb`** serves a set of controller actions through the app's real middleware stack,
  on a real in-process Puma. A probe middleware sits exactly where the Initializer's own
  `Middleware` sits (`insert_after ActionDispatch::RequestId`). For each request it records:
  the body's wrapper chain when `@app.call` returns; which of `to_ary`, `each`, `to_path` or
  `call` the server then uses; the headers at return, at close, and as the client got them;
  and a timeline against `request.action_dispatch`'s finish (the Initializer's
  `request_finish`), `rack.response_finished`, and the client's last byte.
  It removes one middleware, `ActiveRecord::Migration::CheckPending`, so it can run without
  a database. That middleware does nothing to a body.
- It ran twice:
  - **Rails 8.1.3.1, Rack 3.2.7, Puma 8.0.2**, inside the Example app. Output:
    [`output-rails81-rack32-puma8.txt`](capturing-rack-response-bodies/output-rails81-rack32-puma8.txt).
  - **Rails 7.1.5.2, Rack 2.2.20, Puma 6.6.1**, in a one-file development-mode app
    (`rails71_rack22.rb`), because the Example app is pinned to Rails 8. Output:
    [`output-rails71-rack22-puma6.txt`](capturing-rack-response-bodies/output-rails71-rack22-puma6.txt).
    That app has no `public/500.html` and does not set `consider_all_requests_local`, so its
    exception and 404 rows have empty bodies. This is unrelated to capture.
- **`cost.rb`** times `JSON.generate` of a body carried as an envelope field, base64 and file
  reads. Output: [`output-cost.txt`](capturing-rack-response-bodies/output-cost.txt).

Active Storage is not loaded in the Example app. So the probe runs, verbatim, the two lines of
Active Storage that produce each body shape:

- `ActiveStorage::FileServer#serve_file`, which is the disk service's
  `DiskController#show`.
- `ActiveStorage::Streaming#send_blob_stream`, which is proxy mode. It sets
  `Content-Length`, then calls `send_stream`.

Rails' own support floor for Rack is `rack >= 2.2.4` in every actionpack from 7.1 to 8.1
(gemspecs), so Rack 2.2 is a real pairing for every Rails the Initializer accepts. **[S]**

## The facts the decision waits on

1. **At the Initializer's Middleware, a normal `render` (JSON, XML, HTML, `send_data`) is
   already a plain `Array` of Strings.** `Rack::ETag`, lower in the default stack, has called
   `to_ary` on it to hash it for 200 and 201 responses. Other statuses (302, 422, a
   `render json:, status: 404`) arrive as `ActionDispatch::Response::RackBody` over a
   `Response::Buffer`, which also answers `to_ary`. Either way the whole body is already in
   memory, and reading it copies nothing. **[E]** on both stacks.
2. **Only three shapes are not in memory**, and Puma drives each one differently. **[E]**
   - `to_path` bodies (`send_file`, `Rack::Files`, the Active Storage disk service): Puma
     `IO.copy_stream`s the file and never calls `each`. The path and `File.size` are free.
   - Live streams (`ActionController::Live`, `send_stream`, the Active Storage proxy):
     `each` pops a queue the action thread is still filling. They can only be seen by teeing
     `each` as it runs.
   - `each`-only bodies (`Enumerator`, template streaming, `Rack::Files` range responses, a
     `Rack::Deflater` placed inside the Initializer): the same as Live streams.
3. **A body can be read without consuming it only by wrapping it.** The capture has to return
   a new body that forwards `to_ary`, `to_path` and `call` exactly as the original answers
   them, and sees the bytes on whichever path the server takes. Calling `each` on the
   original is forbidden by the spec. Calling `to_ary` on it inside `call` is allowed, but on
   Rack 3 it closes `Rails::Rack::Logger`'s `BodyProxy` and fires `request_finish` early.
   **[S]**, with the wrapper **[E]**.
4. **The body is final enough at the existing Middleware.** Everything that rewrites a body in
   the default stack (`ETag`, `ConditionalGet`'s 304, `Head`, `DebugExceptions`' error pages)
   sits below it. Only `Rack::Sendfile` (x-sendfile) and anything a Host app inserts at the
   top sit above it. The headers Hash is shared and mutated in place, so reading it at close
   gives what the client got. `content-length` and `transfer-encoding` are the exception:
   Puma computes them on the wire. **[E]**
5. **Close comes after the bytes are written, so a capture emitted there adds no latency to
   the response itself.** It does occupy the Puma thread afterwards. The capture's close is
   always later than `request_finish`, so a body Event would be a *Trailing event* under
   today's definition unless something changes. **[S]** for Puma's order, **[E]** for the
   timeline.
6. **The signals available before reading are:**
   - `content-type`: always there, except on 204 and 304.
   - `content-disposition` and `content-transfer-encoding: binary`: set by `send_file` and
     `send_data`.
   - `content-encoding`: set when a `Rack::Deflater` sits below the Initializer.
   - An up-front length: only on some responses. Rails renders arrive with no
     `content-length`, but the Array's byte sum is free. `to_path` has `File.size`. A Live
     stream has no length until it ends, and Live deletes a `Content-Length` the controller
     set itself (the Active Storage proxy's).

   **[E]**
7. **Cost is dominated by where the bytes are stored, not by capturing them.**
   - Capturing costs roughly nothing: a reference to an Array that already exists.
   - The first 64 KB of a file reads in about 7 µs.
   - `JSON.generate` of a 62 KB body takes about 0.05 ms.
   - Stored inline, a JSON body grows about 9% from escaping, and binary grows 33% as base64.
   - Next to today's Sidecar lines (mean 333 B, p99 566 B), a 64 KB body is about 200 lines'
     worth. The 64 MB Sidecar holds about a thousand of them.

   **[E]**
8. **For `send_file`, a path is enough to find the bytes, and nothing makes them stay there.**
   The Reader is local and already reads the Host app's files, so it can read the path on
   demand. But nothing guarantees the file still exists, or is unchanged, by the time the
   developer looks. **[S]**

The details and evidence follow.

## 1. The shapes a body takes

What the Initializer's Middleware receives from `@app.call`, by source. The wrapper chains are
the probe's own output. The outermost `Rack::BodyProxy` is always `Rails::Rack::Logger`'s,
which fires `request.action_dispatch`'s finish, and so the Initializer's `request_finish`
([railties `rails/rack/logger.rb` L33–L51](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/rack/logger.rb#L33-L51)).

| Source | Body at the Middleware (Rails 8.1 / Rack 3.2) | Server path (Puma) | Readable without consuming? | Size known up front |
| --- | --- | --- | --- | --- |
| `render json:` / `xml:` / `html:`, `send_data`, status 200/201 | `BodyProxy > Array` | `to_ary` | Yes. It is an Array. | Sum of `bytesize`. No header. |
| Same with another status (302 redirect, 4xx `render`) | `BodyProxy > BodyProxy > RackBody > Response::Buffer` | `to_ary` | Yes, through the `to_ary` the server calls | Same |
| 304 from `ConditionalGet`, any `HEAD` | `BodyProxy > Array` (empty) | `to_ary` | Nothing to read | 0 |
| Exception page (`DebugExceptions`), routing 404 | `BodyProxy > Array` | `each` | Yes | `content-length` header is set |
| `send_file` | `… > RackBody > Response::FileBody` | `to_path`. `each` is never called. | Path yes, bytes not seen | `File.size(path)` |
| `Rack::Files` (Active Storage disk service) | `… > RackBody > Rack::Files::Iterator` | `to_path` | Path yes, bytes not seen | `content-length` header is set |
| `Rack::Files` answering a `Range` | `… > RackBody > Rack::Files::BaseIterator` (no `to_path`) | `each` | Only by teeing `each` | `content-length` header is set |
| `ActionController::Live` (SSE) | `… > RackBody > Live::Buffer` | `each`, which blocks on a queue | Only by teeing `each` | None. `transfer-encoding: chunked`. |
| `send_stream` / Active Storage proxy | `… > RackBody > Live::Buffer` | `each` | Only by teeing `each` | None. Live deleted the controller's `Content-Length`. |
| `self.response_body = Enumerator` | `… > RackBody > Enumerator` | `each` | Only by teeing `each` | None |
| `Rack::Deflater` inserted with `config.middleware.use` | `… > Deflater::GzipStream > RackBody > Buffer` | `each` | Only by teeing, and the bytes are gzip | None. `content-encoding: gzip`. |

**[E]** for every row: see `output-rails81-rack32-puma8.txt`.

Source notes behind the table, all **[S]**:

- **`Rack::ETag` makes renders into Arrays on Rack 3.** For 200 and 201 responses whose body
  answers `to_ary` and that carry no `etag` or `last-modified`, it calls `body.to_ary` and
  puts that Array in the response
  ([rack `etag.rb` L28–L45](https://github.com/rack/rack/blob/v3.2.7/lib/rack/etag.rb#L28-L45)).
  It sits below the Initializer's Middleware in the default stack (`bin/rails middleware` in
  the Example app: `… RequestId, <Initializer>, … Rack::Head, Rack::ConditionalGet,
  Rack::ETag, Rack::TempfileReaper`).
- **`ActionDispatch::Response::RackBody`** answers `to_ary`, `each`, `call` and `to_path` only
  when the underlying stream does. Its `close` is `Response#abort`
  ([actionpack `response.rb` L543–L585](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/http/response.rb#L543-L585)).
  `Response#body=` keeps a `to_path` body as it is and wraps anything else in a `Buffer`
  ([L384–L398](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/http/response.rb#L384-L398)).
  `send_file` sets a `FileBody` that exposes only `to_path` and a chunked `each`
  ([L402–L427](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/http/response.rb#L402-L427)).
  Status codes with no body get a bare `[]`
  ([L594–L600](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/http/response.rb#L594-L600)).
- **`Live::Buffer`'s `each` pops a `SizedQueue` of 10** that the action thread fills. Its
  `write` deletes `Content-Length` and sets `Cache-Control: no-cache` on the first write
  before commit
  ([actionpack `live.rb` L193–L290](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_controller/metal/live.rb#L193-L290),
  L216–L220).
  - The action runs in its own thread, and `process` returns as soon as the response commits
    ([L307–L349](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_controller/metal/live.rb#L307-L349)).
  - `send_stream` is Live
    ([L382–L396](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_controller/metal/live.rb#L382-L396)).
  - Rails 7.1 hides the buffer's `to_ary` with `undef_method`
    ([7.1 `live.rb` L173](https://github.com/rails/rails/blob/v7.1.5.2/actionpack/lib/action_controller/metal/live.rb#L173)).
    Rails 8.1 gets the same effect from `respond_to?` delegating to the queue.
- **Active Storage has three serving paths**, and each lands on a different row above:
  - **Disk service, the default redirect mode.** `resolve_model_to_route` defaults to
    `:rails_storage_redirect`
    ([`active_storage.rb` L363](https://github.com/rails/rails/blob/v8.1.3.1/activestorage/lib/active_storage.rb#L363)).
    The redirect ends at `DiskController#show`, which calls `serve_file`. That is
    `Rack::Files.new(nil).serving(…)` set as `response_body`, a `to_path` body
    ([`disk_controller.rb` L12–L14](https://github.com/rails/rails/blob/v8.1.3.1/activestorage/app/controllers/active_storage/disk_controller.rb#L12-L14),
    [`file_server.rb` L7–L20](https://github.com/rails/rails/blob/v8.1.3.1/activestorage/app/controllers/concerns/active_storage/file_server.rb#L7-L20)).
  - **Proxy mode.** It sets `Content-Length`, then calls `send_blob_stream`, which is
    `send_stream`, so the body is a Live stream
    ([`blobs/proxy_controller.rb` L14–L22](https://github.com/rails/rails/blob/v8.1.3.1/activestorage/app/controllers/active_storage/blobs/proxy_controller.rb#L14-L22),
    [`streaming.rb` L63–L70](https://github.com/rails/rails/blob/v8.1.3.1/activestorage/app/controllers/concerns/active_storage/streaming.rb#L63-L70)).
  - **A cloud service in redirect mode.** The file never passes through Rails at all.
- **`Rack::Files`** exposes `to_path` only on the full-file `Iterator`. A range response is a
  `BaseIterator`, which answers only `each`
  ([rack `files.rb` L121–L186](https://github.com/rack/rack/blob/v3.2.7/lib/rack/files.rb#L121-L186)).
- **Template streaming** (`render stream: true`) yields an `ActionView::StreamingTemplateRenderer::Body`
  that renders the template *during* `each`
  ([actionpack `streaming.rb` L172–L180](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_controller/metal/streaming.rb#L172-L180),
  [actionview `streaming_template_renderer.rb` L13–L28](https://github.com/rails/rails/blob/v8.1.3.1/actionview/lib/action_view/renderer/streaming_template_renderer.rb#L13-L28)).
  This was not run.
- **Rack 3 `call` bodies and hijacking.** Rails never produces a `call` body:
  `RackBody#respond_to?(:call)` delegates to a stream, and no Rails stream answers `call`. A
  mounted non-Rails Rack app can. Under a full or partial hijack (Action Cable) the server
  ignores the body entirely
  ([SPEC.rdoc "Hijacking"](https://github.com/rack/rack/blob/v3.2.7/SPEC.rdoc#L166-L186)).
  These are shapes to skip, not to capture. **[S]**, not run.

### Rails 7.1 on Rack 2.2 is different in one important way

Rack 2.2's `ETag` does not check `to_ary`. It iterates **any** body that lacks `to_path` with
`each`, collects the parts, and hands back `BodyProxy(parts)`
([rack 2.2 `etag.rb` L26–L72](https://github.com/rack/rack/blob/v2.2.20/lib/rack/etag.rb#L26-L72)).
Rails' own docs warn that this buffers Live responses and offer setting `Last-Modified` as a
workaround
([`live.rb` L42–L55](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_controller/metal/live.rb#L42-L55)).
**[S]**

Observed on Rails 7.1, Rack 2.2 and Puma 6.6.1: the SSE action, `send_stream`, the
`Enumerator`, and the gzip stream from an inner `Rack::Deflater` all reach the Middleware as a
fully materialised `Array`. The Middleware returns 104 ms later for the SSE action, after the
whole stream has run, and every one of them gains an `etag`. **[E]**

So on Rack 2.2 almost everything except `to_path` is already an Array by the time the
Initializer sees it. The streaming cases only exist on Rack 3.

## 2. Reading without consuming

The rules the Rack 3 spec sets ([SPEC.rdoc "The Body"](https://github.com/rack/rack/blob/v3.2.7/SPEC.rdoc#L226-L250)),
all **[S]**:

- "The Body must either be consumed or returned." `close` must be called at least once. A
  middleware that replaces a body must close the original.
- "Middleware must not call `each` directly on the Body. Instead, middleware can return a new
  Body that calls `each` on the original Body."
- "Middleware may call `to_ary` directly on the Body and return a new Body in its place. …
  If the Body responds to both `to_ary` and `close`, its implementation of `to_ary` must call
  `close`."
- "The `to_path` method does not consume the body." The file's contents must be "identical to
  that produced by calling `each`".
- Rack 2.2's spec has no such rules. It says only `each`, the optional `to_path`, and that
  `close` is called after iteration
  ([2.2 SPEC.rdoc L269–L287](https://github.com/rack/rack/blob/v2.2.20/SPEC.rdoc#L269-L287)).

What that leaves, in the Initializer's position:

- **Wrap, don't read.** The Middleware returns a wrapper that forwards `respond_to?` for
  `to_ary`, `to_path` and `call` to the body it wraps, so the server keeps choosing the path
  it would have chosen:
  - Puma prefers `to_ary`, then `to_path`, then `each`
    ([puma `response.rb` L163–L186](https://github.com/puma/puma/blob/v8.0.2/lib/puma/response.rb#L163-L186)).
  - On the `to_ary` path the wrapper sees the whole Array.
  - On the `each` path it tees each chunk into a capped buffer while yielding it on
    unchanged.
  - On the `to_path` path it sees only the path.

  The probe's `Tee` is exactly this, and in every case the client received the same status,
  bytes and headers as without it. **[E]**
- **Hiding `to_path` would cost the file transfer.** A wrapper that answered `each` but not
  `to_path` would push `send_file` from Puma's `IO.copy_stream` onto 16 KB `each` chunks
  ([`response.rb` L402–L427](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/http/response.rb#L402-L427)).
  It would also make `Rack::Sendfile` unable to hand the file to a front proxy, because
  `Sendfile` reads `to_path` through the wrapper from above the Initializer. The probe saw
  `Sendfile` do exactly that in the x-sendfile run. **[S]** and **[E]**
- **Don't call `to_ary` inside `call`.** It is permitted, but on Rack 3 `BodyProxy#to_ary`
  closes the proxy
  ([rack `body_proxy.rb` L44–L56](https://github.com/rack/rack/blob/v3.2.7/lib/rack/body_proxy.rb#L44-L56)).
  The outermost proxy is `Rails::Rack::Logger`'s, so `request_finish` would fire inside the
  Initializer's own `call`, before the response had left. The probe observed this ordering
  when *Puma* calls `to_ary`: `to_ary` at 30.36 ms, then `request.action_dispatch` finish at
  30.37, then the wrapper's close at 30.40. **[E]**
- **The wrapper's own `to_ary`.** The spec says it must call `close`. Doing that literally
  would move the capture's emission in front of the socket write. Puma closes the body after
  writing regardless
  ([`response.rb` L108–L131](https://github.com/puma/puma/blob/v8.0.2/lib/puma/response.rb#L108-L131)),
  so there are two ways to handle it:
  - Emit from `rack.response_finished` where it exists, and let `close` only release.
  - Defer emission to the close the server makes after writing, as the probe did.
    `Rack::Lint`, the only thing that would object, is not in a Rails development stack:
    `Rails::Server#middleware` is empty
    ([railties `server_command.rb` L50–L52](https://github.com/rails/rails/blob/v8.1.3.1/railties/lib/rails/commands/server/server_command.rb#L50-L52)),
    and puma-dev boots `config.ru` with no rackup defaults.

  **[S]**
- **Reading `payload[:response]` from `process_action.action_controller` instead.** That
  payload does carry the `ActionDispatch::Response`
  ([`instrumentation.rb` L77](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_controller/metal/instrumentation.rb#L77)).
  But `Response#body` is not a safe read on all shapes
  ([`response.rb` L369–L378](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/http/response.rb#L369-L378)):
  - For a `Buffer` it joins the parts into a new String. That is harmless.
  - For a Live buffer, `body` runs `each`, which **pops the queue the server is reading
    from**. It would steal the stream.
  - For a `FileBody`, `body` is `File.binread` of the whole file.

  It also fires before `ETag`, `ConditionalGet` and `Head`, and never fires for routing
  failures, exception pages or mounted Rack apps. Safe only if gated by stream class to
  `Response::Buffer`. **[S]**
- **`send_file`'s path from a notification.** `send_file.action_controller` carries
  `path:` in its payload
  ([`instrumentation.rb` L36–L41](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_controller/metal/instrumentation.rb#L36-L41)).
  `send_data.action_controller` carries only the options, not the data. **[S]**

## 3. Where the body is final, and how it fits the Middleware and `request_finish`

The default Rails 8.1 stack, from `bin/rails middleware` in the Example app **[E]**, with the
Initializer's position marked:

```
ActionDispatch::HostAuthorization
Rack::Sendfile                         ← swaps a to_path body for an x-sendfile header (above)
ActionDispatch::Static                 ← public/ files never reach the Initializer
Propshaft::Server                      ← /assets never reach the Initializer
ActionDispatch::Executor               ← completes via rack.response_finished on Rails 8.1
ActionDispatch::ServerTiming           ← adds server-timing (header only)
ActiveSupport::Cache::Strategy::LocalCache::Middleware
Rack::Runtime                          ← adds x-runtime (header only)
Rack::MethodOverride
ActionDispatch::RequestId              ← adds x-request-id (header only)
>>> RailsLogReader::Middleware         ← insert_after ActionDispatch::RequestId
ActionDispatch::RemoteIp
Propshaft::QuietAssets
Rails::Rack::Logger                    ← its BodyProxy close is request_finish
ActionDispatch::ShowExceptions         ← renders error pages
ActionDispatch::DebugExceptions        ← renders error pages
… Reloader, Callbacks, CheckPending, Cookies, Session, Flash, CSP …
Rack::Head                             ← HEAD: closes the body, returns []
Rack::ConditionalGet                   ← 304: closes the body, returns []
Rack::ETag                             ← Rack 3: to_ary for 200/201; Rack 2: each on anything but to_path
Rack::TempfileReaper
(routes)
```

Everything that decides *what the bytes are* for an ordinary request sits below the
Initializer, so the body its Middleware sees is the body the client gets. The exceptions:

- **`Rack::Sendfile` with `x_sendfile_header` set.** The body the client gets is empty, with
  `content-length: 0` and an `x-sendfile` header. The Initializer still sees the `to_path`
  body, which is arguably *better* for a preview. Observed on both stacks **[E]**. Rails
  leaves `x_sendfile_header` unset by default, and `Sendfile` ignores the request header on
  purpose
  ([rack `sendfile.rb` L130–L170](https://github.com/rack/rack/blob/v3.2.7/lib/rack/sendfile.rb#L130-L170)).
  **[S]**
- **`Rack::Deflater`, which is not in the default stack.** Where it lands depends on how the
  Host app adds it:
  - `config.middleware.use Rack::Deflater` appends it to the *bottom*, below the Initializer.
    The Initializer then sees gzip bytes with `content-encoding: gzip`, and the body becomes
    an `each`-only `GzipStream`. **[E]**
  - Inserted above the Initializer, it is invisible to capture.
  - `Deflater` skips 204 and 304, `no-transform`, and responses that are already encoded
    ([rack `deflater.rb` L46–L80](https://github.com/rack/rack/blob/v3.2.7/lib/rack/deflater.rb#L46-L80)).
    **[S]**
- **Anything a Host app or gem inserts at the very top.** rack-mini-profiler is the common
  one (`insert(0, …)`). It rewrites HTML bodies after the Initializer has seen them. **[S]**
  (prior art below).

**Headers:** the Hash is shared, so read it at close.

- `RequestId`, `Runtime` and `ServerTiming` all add their headers to the same Hash object on
  the way out.
- In both runs the Hash as read at the wrapper's close matched what the client got,
  `x-request-id`, `x-runtime`, `server-timing` and `x-sendfile` included. **[E]**
- The two exceptions are `content-length` and `transfer-encoding`, which Puma decides while
  writing and never puts in the Hash. An Array body with no `content-length` header went out
  with one. **[E]**
- A capture that wants "the headers the client got" reads them at close and derives the
  length itself.

**Order of the end of a request.** **[E]** on Rails 8.1, Rack 3.2 and Puma 8:

```
to_ary / each / to_path by the server
  → request.action_dispatch finish (request_finish)    — for to_ary: fired by BodyProxy#to_ary, before the write
  → socket write
  → body close (the capture's wrapper)                 — Puma: `ensure app_body.close`
  → rack.response_finished callbacks (reverse order)   — Executor completes here on Rails 8.1
```

- **Rails 7.1, Rack 2.2, Puma 6.6.1.** Rack 2.2's `BodyProxy` delegates `to_ary` without
  closing
  ([2.2 `body_proxy.rb`](https://github.com/rack/rack/blob/v2.2.20/lib/rack/body_proxy.rb)),
  so `request_finish` fires at close. The wrapper's close still precedes it, by nesting
  order: the wrapper closes Logger's proxy from inside its own `close`. There is **no
  `rack.response_finished`** in the env. **[E]**
- **Puma support.** Puma added `rack.response_finished` in 7.0.0 (Puma `History.md`,
  "Add support for `rack.response_finished` (#3681)") and fills it for every request
  ([puma `client_env.rb` L152](https://github.com/puma/puma/blob/v8.0.2/lib/puma/client_env.rb#L152)).
  It is a Rack 3.0 spec key
  ([SPEC.rdoc L141–L143](https://github.com/rack/rack/blob/v3.2.7/SPEC.rdoc#L141-L143)).
- **Rails support.** `ActionDispatch::Executor` uses it only from **Rails 8.1**: 8.1.3.1 has
  it, and 8.0.3 and 7.2.3 do not
  ([8.1 `executor.rb` L15–L16](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/middleware/executor.rb#L15-L16);
  actionpack 8.1 CHANGELOG, "Add support for `rack.response_finished` callbacks in
  ActionDispatch::Executor"). Before that it completes from a `BodyProxy` outside the
  Initializer. The Initializer's own comment in `install_request_events` ties this to "Rack
  3.1 and up". Per source it is Rails 8.1 plus a server that fills the key. **[S]**

In both orders, `Current.request_id` is still set when the capture's wrapper closes: the
Executor's `to_complete` reset runs later. The safer design still captures the id into the
wrapper at `call` time rather than reading `Current` at close. **[S]** and **[E]**, with the
request id present in both runs.

**What this means for fitting the body onto the wire:**

- The capture always completes *after* `request_finish` has been emitted, on every stack.
- Under today's vocabulary, a body Event emitted then is a *Trailing event*. That definition
  says trailing events are "structurally rare" and "genuinely surprising", which a body on
  every request would not be.
- There are three ways out, and each is a wire decision:
  - **A new event type** the Reader files under its request, not in the trailing section.
  - **Moving `request_finish`** from Logger's notification to the capture wrapper's own
    close. That makes it strictly later, and it would then mean "response written".
  - **Carrying the body on `request_finish`.** That only works if the finish is moved.

  **[S]**, as a reading of `CONTEXT.md` against the observed order.

## 4. Signals available before reading

At the Initializer's Middleware, before any byte is touched **[E]**:

| Signal | JSON / XML render | `send_data` PDF | `send_file` / `Rack::Files` | Live / `send_stream` | Inner Deflater |
| --- | --- | --- | --- | --- | --- |
| `content-type` | `application/json; charset=utf-8`, `application/xml; charset=utf-8` | `application/pdf` | `image/png` (from `type:` or the extension) | as set | original type |
| `content-length` | **absent**. Puma adds it. | absent | `send_file`: absent. `Rack::Files`: present. | absent. Live deletes it. | absent. Deflater deletes it. |
| free exact size | `array.sum(&:bytesize)` on the `to_ary` path | same | `File.size(to_path)`, about 1 µs | only at the end, counted while teeing | only at the end |
| `content-disposition` | — | `inline; filename=…` | `send_file`: yes. `Rack::Files`: set by Active Storage. | yes for `send_stream` | — |
| `content-transfer-encoding: binary` | — | yes | `send_file`: yes | no | — |
| `content-encoding` | — | — | — | — | `gzip` |
| body String encoding | `UTF-8` | `ASCII-8BIT` | n/a | chunk-dependent: `ASCII-8BIT` for the PNG | `ASCII-8BIT` |

Consequences:

- **Text versus binary is decided by `content-type`, and every response has one.** The
  exceptions are 204 and 304, which the spec forbids to carry one
  ([SPEC.rdoc L212–L218](https://github.com/rack/rack/blob/v3.2.7/SPEC.rdoc#L212-L218)).
  Rails assigns `text/html` when a controller set nothing
  ([`response.rb` L535–L541](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/http/response.rb#L535-L541)).
  **[S]**
  - `+json` and `+xml` suffixes (`application/problem+json`, `application/atom+xml`) belong
    to the text core.
  - `send_file`'s default type is `application/octet-stream` when nothing better is known.
  - httplog's `text_based?` shows the trap of a denylist: it treats `application/*` as text
    except `octet-stream` and `pdf`, so `application/zip` passes
    ([httplog `http_log.rb` L346–L352](https://github.com/trusche/httplog/blob/v1.8.0/lib/httplog/http_log.rb#L346-L352)).

  An allowlist (JSON, XML, `text/*`) is the safer shape. **[S]**
- **A size cap can be applied up front** for the Array and `to_path` shapes. It cannot for
  the streaming shapes. There the tee keeps the first *cap* bytes and keeps *counting* the
  rest, so the original length is still known at close for the "showing 64 KB of 812 KB"
  message `truncated` already gives. **[E]**: the tee counted every byte of every `each` body.
- **An encoding check is still needed after the content-type check.**
  - A JSON body is always UTF-8.
  - A binary body reaches `JSON.generate` only by crashing it. The probe's first run died on
    `"\xE2" from ASCII-8BIT to UTF-8` when it tried to carry the PDF's bytes. **[E]**
  - The Initializer's existing `scrub_utf8` already turns such a String into
    `"<N bytes of binary data>"`, and re-tags a BINARY String that is valid UTF-8, such as a
    JSON file served by `send_file`
    ([`reader/rails/rails_log_reader.rb`](../../reader/rails/rails_log_reader.rb), `scrub_utf8`).
    **[S]**
- **`content-encoding: gzip` bodies** need a bounded inflate to preview:
  `Zlib::GzipReader#read(cap)`. Otherwise they are skipped. rack-mini-profiler's answer is to
  rewrite the request's `Accept-Encoding` to `identity`, which changes what the client
  receives and is therefore not open to the Initializer (prior art below). **[S]**

## 5. What capturing costs

**Memory while a body is held.** **[S]** for the reasoning, **[E]** for the shapes.

- *Array shapes.* The Array exists anyway until the server finishes writing. Keeping a
  reference until close adds nothing. A capped copy is at most one `byteslice` of *cap*
  bytes, plus the transient JSON line.
- *Streaming shapes.* The tee holds up to *cap* bytes per in-flight stream for as long as
  that stream runs. Anything past the cap is only counted.
- *`to_path`.* Nothing is held. Reading the first 64 KB of a file at close takes about
  0.007 ms. Reading a whole 10 MB file takes about 4.4 ms. **[E]** `output-cost.txt`.

**Latency added to the request.**

- **To the client, about zero** when emission happens at close or in
  `rack.response_finished`, because Puma writes the whole response (the final chunk of a
  chunked one included) before either
  ([`response.rb` L108–L131](https://github.com/puma/puma/blob/v8.0.2/lib/puma/response.rb#L108-L131)).
  **[S]**
- **The Puma thread** is held for the emit instead. That delays only the next request that
  thread or that keep-alive connection serves:
  - `JSON.generate` of a 62 KB body as an envelope field: about 0.05–0.065 ms.
  - Of a 714 KB body: about 0.39 ms.
  - Joining an Array and checking its encoding: at most 0.035 ms at 714 KB.
  - Then one `write(2)` of the line. ADR-0003 already relies on appends like this being
    cheap.

  **[E]**
- **Teeing `each`** costs one `byteslice` and `<<` per chunk until the cap. It is not
  measured separately. **[S]**

**Size next to today's Sidecar lines.** Measured over the main checkout's
`example-app/log/rails_log_reader.jsonl`, 8,548 lines **[E]**:

| type | n | mean | p50 | max |
| --- | --- | --- | --- | --- |
| all | 8548 | 333 B | 303 B | 13,272 B |
| `app_log` | 5539 | 320 B | 303 B | 775 B |
| `sql` | 2574 | 350 B | 324 B | 601 B |
| `request_start` | 131 | 240 B | 243 B | 251 B |
| `request_route` | 131 | 323 B | 322 B | 440 B |
| `request_finish` | 131 | 705 B | 311 B | 13,272 B (a backtrace) |

A JSON body, carried as one field of an envelope **[E]** `output-cost.txt`:

| records | body | line | ratio |
| --- | --- | --- | --- |
| 1 | 174 B | 242 B | 1.39× (mostly envelope) |
| 10 | 1.7 KB | 1.9 KB | 1.12× |
| 100 | 17 KB | 19 KB | 1.09× |
| 350 | 62 KB | 67 KB | 1.09× |
| 4000 | 714 KB | 778 KB | 1.09× |

An XML body grows only 1.01×, since it has few characters JSON must escape. Base64 of binary
is 1.33×. **[E]**

What those sizes mean against the existing bounds. This is arithmetic from the figures above
and `CONTEXT.md` / ADR-0003, **[S]**:

- **Disk.** The Sidecar's 64 MB cap is checked at boot. It holds about 200,000 of today's
  lines, or about 1,000 bodies at a 64 KB cap. At 2–20 KB per body, which is a 10–100 record
  JSON index, that is about 3,000–30,000 requests before the next boot truncates the file.
- **Line.** A 64 KB body fits under the existing 256 KB line cap, and under the 64 KB field
  cap exactly. A body over the field cap is cut by `cut_oversized_fields` like any other
  field, and its original size is recorded in `truncated`. A cut JSON body is no longer
  parseable, so the pretty view has to fall back to raw for it.
- **Reader memory.** The *Memory bound* counts **events**, not bytes, at 5,000. In the sample
  above, requests were 1.5% of events. In an API-heavy app a request can be as few as 4
  events (start, route, finish, body), so a 5,000-event window can hold about 1,250 bodies:
  up to about 80 MB at a 64 KB cap. That is an estimate, not a measurement.

## 6. `send_file`: recording the path versus copying the bytes

**What a path gives.** `FileBody#to_path` and `Rack::Files::Iterator#to_path` are the file
the client gets. The spec guarantees the contents are identical to `each`, and asking does not
consume the body **[S]**. The probe read `path` and `File.size` at close on both stacks without
disturbing the transfer **[E]**. The *Reader* is local and already reads the Host app's files
(standing constraint 3, ADR-0003), so it could read that path when the developer opens the
preview. Nothing would ever be copied.

**What it does not guarantee:**

- **The file may be gone.** `send_file tempfile.path` followed by the Tempfile being
  unlinked is a common pattern for generated PDFs.
- **The file may have changed.** An overwritten export would preview as its new contents.
- **The file may be outside the app.** `send_file` accepts any readable path
  ([`data_streaming.rb` L77–L86](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_controller/metal/data_streaming.rb#L77-L86)).
  A Reader that served "whatever path the Sidecar names" would be a local file-read
  primitive. It should serve only paths it read from the Sidecar, and it is localhost-only.
- **Active Storage disk files are the stable case.** Keys are content-addressed. Active
  Storage *proxy* mode is not a path at all: it is a Live stream, and its bytes are seen only
  by teeing.

**[S]**

**What copying costs.**

- *Inline in the Sidecar:* base64 at 1.33×, and 64 KB of bytes is 87 KB on the line. A 1 MB
  image does not fit a 256 KB line at all. **[E]**
- *As a separate file:* raw bytes. Reading the whole file at close is about 0.08 ms per MB,
  plus the write. **[E]**
- Copying bytes that are *already* in memory is a different case. `send_data`'s bytes come
  back from `to_ary` for free, since `send_data` is `render body:`
  ([`data_streaming.rb` L122–L125](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_controller/metal/data_streaming.rb#L122-L125)).
  So a PDF from `send_data` costs only its storage. **[S]** and **[E]**

The shape of the trade:

- **A path** is free, and exact at the moment of the response, but only while the file
  stays.
- **A copy** is durable, but pays storage on every binary response, including ones nobody
  opens.
- **A hybrid** is possible: path for `to_path` bodies, capped copy for in-memory bodies.

## 7. Prior art

- **rack-mini-profiler 5.0.0.** It inserts itself at the top of the stack
  ([`railtie.rb` L61](https://github.com/MiniProfiler/rack-mini-profiler/blob/v5.0.0/lib/mini_profiler_rails/railtie.rb#L61)).
  Only for 2xx `text/html`, decided from the header before touching the body, it calls
  `body.each` directly, rewrites the body into a new `Rack::Response`, and closes the original
  ([`mini_profiler.rb` L431–L461](https://github.com/MiniProfiler/rack-mini-profiler/blob/v5.0.0/lib/mini_profiler.rb#L431-L461)).
  Two lessons:
  - It gates by content-type before reading.
  - Calling `each` directly is what the Rack 3 spec now forbids middleware to do, and it would
    buffer a Live stream.

  When a `Rack::Deflater` sits below it, it rewrites the request's `Accept-Encoding` to
  `identity` so the body stays readable
  ([`railtie.rb` L185–L195](https://github.com/MiniProfiler/rack-mini-profiler/blob/v5.0.0/lib/mini_profiler_rails/railtie.rb#L185-L195),
  [`mini_profiler.rb` L289–L291](https://github.com/MiniProfiler/rack-mini-profiler/blob/v5.0.0/lib/mini_profiler.rb#L289-L291)).
  That changes what the client receives, so it is not an option here. **[S]**
- **meta_request 0.8.6** (the Rails side of RailsPanel) **does not capture response bodies
  at all.** Its `AppRequestHandler` collects notification events for a request and, in an
  `ensure` around `@app.call`, writes them as **one JSON file per request** to
  `tmp/data/meta_request/<request_id>.json`, with a pool size that prunes the oldest
  (meta_request 0.8.6 gem source,
  [`middlewares/app_request_handler.rb`](https://github.com/dejan/rails_panel/blob/master/meta_request/lib/meta_request/middlewares/app_request_handler.rb)
  L12–L30,
  [`storage.rb`](https://github.com/dejan/rails_panel/blob/master/meta_request/lib/meta_request/storage.rb)
  L11–L42). That is the one precedent here for per-request side files with a pruning bound.
  Its write happens before the server has even read the body. **[S]**
- **httplog 1.8.0** logs *outgoing* HTTP responses, not Rack ones, but faces the same two
  questions. **[S]**
  - *Binary:* it refuses with `(not showing binary data)` unless the content type is
    text-based.
  - *Gzip:* it decompresses when `content-encoding` says so, and forces the body to the
    declared charset
    ([`http_log.rb` L115–L140](https://github.com/trusche/httplog/blob/v1.8.0/lib/httplog/http_log.rb#L115-L140),
    L336–L352).
- **rack-attack 6.8.0** instruments `rack.attack` and `<type>.rack_attack` with only
  `request:` in the payload. There is no response and no body. It is not prior art for this
  question
  ([`attack.rb` L39–L46](https://github.com/rack/rack-attack/blob/v6.8.0/lib/rack/attack.rb#L39-L46)).
  **[S]**
- **Rails' own tests.**
  - `ActionDispatch::Integration` reads the body only after `Rack::MockResponse` has fully
    buffered it, as the terminal consumer. That consumption is safe only because nothing else
    reads that body afterwards
    ([rack `mock_response.rb` L48–L96](https://github.com/rack/rack/blob/v3.2.7/lib/rack/mock_response.rb#L48-L96);
    [`test_response.rb` L14–L16](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/testing/test_response.rb#L14-L16)).
  - `TestResponse#parsed_body` picks a parser by the response's `media_type`: JSON to a Hash,
    HTML to Nokogiri, and raw otherwise
    ([L50–L56](https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/testing/test_response.rb#L50-L56)).
    That is the same "decide by media type, fall back to raw" shape the Reader's value viewer
    needs.

  **[S]**

## 8. Options for the decision ticket

Not decided here. Each option lists what it costs against evidence above.

**Capture site**

- **A. Wrap the body in the existing Middleware** (a forwarding tee).
  - What it sees: every response through the stack. That includes exception pages, routing
    404s, mounted Rack apps, and the Rack-final 304 and `HEAD` emptiness.
  - It sees every shape, and never changes the server's path.
  - It emits at close or in `rack.response_finished`, after the client has the bytes.
  - It is one more object per request. It must forward `to_ary`, `to_path` and `call`
    faithfully, and skip hijacked responses.
  - It adds no middleware, because the Initializer already has one, so constraint 2's list is
    unchanged. It writes nothing to `development.log`, so constraint 1 holds.
- **B. Read `payload[:response]` in `process_action.action_controller`.**
  - No Rack wrapping.
  - Safe only for `Response::Buffer`. It must skip Live (reading steals the stream) and
    `FileBody` (reading loads the whole file) by class.
  - It misses non-controller responses, and runs before `ETag`, `ConditionalGet` and `Head`.
    That matches the Initializer's existing preference for `controller_status` over the
    Rack-final one.
  - It runs *inline, before the response is sent*, unless the emit is deferred. That adds the
    emit's cost to the request's latency.
- **C. Both**: B for the body of controller renders, A only for shapes B cannot read. More
  paths, one more failure mode.

**Where the body lives** (the ticket's three, plus a hybrid)

- **1. Inline in the Sidecar**, as a new event type or a field on a moved `request_finish`.
  - Zero new files or machinery. Truncation and the `truncated` notice already exist, and
    the 64 KB field cap is a natural cap.
  - It grows the Sidecar quickly: about 1,000 capped bodies per 64 MB.
  - The Reader's event-counted *Memory bound* is not a byte bound, so bodies can make the
    Reader's memory much larger.
  - Binary needs base64, at 1.33×, and does not fit the line cap beyond about 190 KB.
- **2. A file per body under `log/`**, with the Sidecar line carrying a reference and size.
  - It keeps the Sidecar lean and the *Memory bound* honest, since the Reader loads a body
    only when shown.
  - It breaks "the only file the product creates" (`CONTEXT.md`, *Sidecar*). It needs a
    retention bound written by the *Initializer*, because the Reader never writes to Host app
    files. The existing boot-time 64 MB check is the model for that, and meta_request's pool
    is precedent.
  - It still sits under `/log/*`, so there is still no `.gitignore` edit.
- **3. A path reference for `to_path` bodies** (`send_file`, Active Storage disk).
  - Free, exact, no copy.
  - Only valid while the file exists and is unchanged.
  - The Reader must restrict itself to paths the Sidecar named.
- **4. Hybrid**: inline, capped, for text; path for `to_path` binaries; binary from memory
  (`send_data`) either skipped or stored as in 2.

**Caps and filters that the evidence supports making up front**

- Content-type allowlist: JSON, `+json`, XML, `+xml`, and optionally `text/*`. Everything
  else is recorded as headers and size only.
- Byte cap known up front for Array and `to_path` bodies, and enforced while teeing for
  streams.
- `content-encoding: gzip` either inflated to the cap or skipped.
- 204, 304, `HEAD`, hijacked responses and x-sendfile'd responses are never read.

**Leaning** (a leaning, not a decision):

- **A**, with emission from the wrapper's close.
- Bodies as their own event type, so `request_finish` keeps its meaning and position. The
  Reader would file that event under its request rather than treating it as a *Trailing
  event*.
- JSON and XML inline under the existing 64 KB field cap.
- `to_path` binaries as a path plus size, read by the Reader on demand.
- Response headers captured beside the body, read from the shared Hash at close.
- Why: it reuses the Initializer's one Middleware and the existing truncation machinery. It
  adds no file. It keeps the client's bytes and timing unchanged, and it prices binary at
  zero until #145 wants more. The *Memory bound*'s event-count blind spot is the cost to
  weigh.

## Not verified

- **Rails 7.2 was not run.** Its `RackBody`, `Buffer` and `Executor` match 7.1 or 8.1 in the
  parts that matter. The only relevant 7.2 → 8.1 difference is the Executor's
  `rack.response_finished`. **[S]**
- **Template streaming (`render stream: true`), a Rack 3 `call` body from a mounted app, and
  a hijacked response were not run.** Source only.
- **The Host app's real JSON sizes are unknown.** The size table uses synthetic bodies. The
  Example app renders HTML, not JSON.
- **The probe ran on Puma only.** Other servers may choose between `to_ary`, `to_path` and
  `each` differently. The spec makes all three correct, and the wrapper forwards all three.
