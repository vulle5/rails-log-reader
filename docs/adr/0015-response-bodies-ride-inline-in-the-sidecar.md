# Response bodies ride inline in the Sidecar

A response's headers and its JSON or XML body travel as their own *Response event*, as one
line in the Sidecar like any other Event. They do not go in a file per body. The body is cut at
the 64 KB every wire field already is, with its original size recorded under `truncated`. The
Sidecar stays the only file the product creates (ADR-0003), and the cap, the truncation notice
and the boot-time 64 MB check all already exist. The cost is a Sidecar that turns over sooner,
and a Reader fold that holds more bytes for the same *Memory bound*. Settled in
[#145](https://github.com/vulle5/rails-log-reader/issues/145), from the research in
[#139](https://github.com/vulle5/rails-log-reader/issues/139).

## The shape

- **Captured by wrapping the body in the Initializer's existing Middleware.** The wrapper
  forwards `to_ary`, `to_path` and `call`, so the server writes exactly what it would have. It
  emits when the body closes, which is after the client has the bytes. It sees every response
  through the stack, including exception pages, routing 404s and mounted Rack apps, and adds no
  middleware.
- **Every response gets one, a hijacked one included.** All headers are read from the
  shared Hash at close, without filtering. A body is kept only when it is JSON (`+json`) or XML
  (`+xml`), already in memory, not `content-encoding`-encoded, and not empty. Otherwise the
  event says why there is no body: another type, streamed, encoded or empty. Nothing is teed
  from a stream, and no binary byte or `send_file` path is recorded. A hijacked response, such
  as a WebSocket upgrade, gets an event that says only that the connection was handed over,
  with no headers and no body, because the app wrote whatever followed itself. So a finished
  request with no Response event means one thing: it was recorded before Response events
  existed. (Amended in [#151](https://github.com/vulle5/rails-log-reader/issues/151). The
  first version gave a hijacked response no event, which left the *Response* tab unable to
  tell a WebSocket upgrade from an old recording.)
- **The body is text, and the headers are pairs.** The body travels as a string holding the
  text the app sent, never as an embedded JSON object. That is what makes the exact text one
  toggle away and a cut body readable. The Reader parses it only when it is shown, with a
  parser that keeps key order, one body at a time. Headers travel as `[[name, value], …]` in
  the order the app set them. (Amended in
  [#189](https://github.com/vulle5/rails-log-reader/issues/189). See ADR-0016.)
- **Its own Event, after `request_finish`.** A wrapper closes after the finish, so the
  Response event always follows it. `request_finish` keeps its meaning and its moment, and a
  request stops being in flight at the same moment as before. The Reader files the Response event under
  its request, never as a *Trailing event*.
- **Always on while the Marker file exists.** There is no separate switch, because the Marker
  file must never become a config file (ADR-0004).

## Considered options

- **A file per body under `log/`, referenced from the Sidecar line.** Refused. It keeps the
  Sidecar lean and lets the Reader load a body only when it is shown. But it breaks "the only
  file the product creates", and it needs a retention bound written by the Initializer, since
  the Reader never writes to Host app files.
- **Reading `payload[:response]` in `process_action`.** Refused. It misses non-controller
  responses, has to skip Live and `send_file` bodies by class, and runs before the response is
  sent.
- **Carrying the body on a `request_finish` moved to the wrapper's close.** Refused. It would
  change what "finish" means and delay the end of *in flight* by the time the socket write
  takes.
- **A byte-counting bound in the Reader, or reading bodies back from the Sidecar on demand.**
  Refused. The first is a second number beside the *Memory bound*. The second is a second read
  path that has to survive boot-time truncation.

## Consequences

- The 64 MB Sidecar holds about 1,000 bodies that are cut at the cap, or about 3,000 to 30,000
  typical 2 to 20 KB JSON responses, before a boot truncates it.
- The Reader's worst case is the *Memory bound*'s 5,000 events times the 64 KB cap, about
  80 MB, for an API-only session where every response is full.
- A cut JSON body can no longer be parsed, so it is shown raw with its original size.
- HTML, PDFs and images have headers and a size but no preview. Binary previews are out of
  scope for this effort. If a later effort wants them, it starts from recording `send_file`
  paths, which cost nothing here.
