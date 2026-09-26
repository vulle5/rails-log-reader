# How localhost dev tools stop other pages from using them

Research for *Research: How localhost dev tools stop other pages from using them*, on the
map *Map: Rails log reader V2 — a developer tool*. V2 gives the Reader a REPL: it spawns
`bin/rails console` and runs whatever Ruby the page sends. At that point, anything that can
make the Reader's server accept a request can run code as the developer. Already settled: the
Reader is localhost-only, and access from other devices is given up.

This is a **menu**, not a decision. The grilling ticket picks from it. A leaning is marked at
the end.

**Evidence labels.** **[verified]** means an experiment run for this note on 2026-09-26: Bun
1.4.2, Linux 6.6 WSL2 kernel, mirrored networking (`networkingMode=mirrored`,
`hostAddressLoopback=true`), `bindv6only=0`, with Windows `curl.exe` as the Windows-side client.
**[source]** means read from the primary source linked. Headless experiments cannot show which
headers a real browser sends, so every browser-behaviour claim is **[source]** and rests on the
specs.

---

## 1. What the Reader exposes today

- `Bun.serve` is called with `port` and no `hostname` (`reader/src/server/index.ts`,
  `serveOrSaySo`). Routes: `GET /events` (SSE), `GET /earlier`, `GET /app-name-override`,
  `GET /initializer-status`, `POST /initializer-repair`, and `/*` serving the HTML bundle.
  Nothing sets `Access-Control-Allow-*`, and nothing reads `Origin`, `Host` or `Sec-Fetch-*`.
  `development` is `{ hmr: true, console: true }` unless `NODE_ENV=production`.
- **[verified]** With no `hostname`, Bun listens on the dual-stack wildcard: `ss -ltnp` shows
  `*:5391`. It answered on `127.0.0.1`, on `[::1]`, and on the machine's LAN address
  `10.0.0.125` from inside WSL. `server.url` still reports `http://localhost:5391/`, so the
  printed URL hides the fact that the server listens on every interface.
- **[source]** Bun's own type docs say the same: `hostname` defaults to `"0.0.0.0" // listen on
  all interfaces` (`bun-types` 1.4.2 `serve.d.ts`, `HostnamePortServeOptions.hostname`;
  docs: <https://bun.com/docs/runtime/http/server>).
- **[verified]** A request with `Host: attacker.example:5391` and
  `Origin: https://attacker.example` got a normal `200`. Bun does no `Host` or `Origin` check on
  app routes.

This means that today, before any REPL exists:
- a cross-site page can fire `POST /initializer-repair`, a body-less "simple" request (§3);
- a DNS-rebinding page can read `/events`, which is the full log stream, params included (§4);
- another device on the network may be able to reach the Reader (§2).

The REPL raises the stakes from "read logs / rewrite one initializer" to "run arbitrary Ruby".

## 2. Binding: wildcard vs `127.0.0.1` vs `localhost` vs `::1`

### How Bun binds

**[source]** Bun's listener (`bsd_create_listen_socket`,
[bun-usockets `bsd.c` @36cd151](https://github.com/oven-sh/bun/blob/36cd1514eccf589b71874c69333b25d6a1bb3019/packages/bun-usockets/src/bsd.c))
calls `getaddrinfo(host, …, AI_PASSIVE, AF_UNSPEC)`. It tries every **IPv6** result first and
then every IPv4 result, and it **returns the first socket that binds**. So it binds exactly one
address. `IPV6_V6ONLY` is off unless `ipv6Only: true`, so a wildcard `::` socket also accepts
IPv4.

### What each value means

| `hostname` | Binds (Linux here) | Reachable from | Notes |
|---|---|---|---|
| *(none)* | `*` (`[::]`, dual-stack) **[verified]** | loopback v4+v6, LAN address **[verified]** | Today's behaviour. |
| `"127.0.0.1"` | `127.0.0.1` **[verified]** | `127.0.0.1` only; `::1` refused; LAN refused **[verified]** | Unambiguous on every OS. |
| `"::1"` | `[::1]` **[verified]** | `::1` only; `127.0.0.1` refused **[verified]** | |
| `"localhost"` | Whatever `getaddrinfo` returns first, **preferring IPv6** **[source: bsd.c]** | Depends on the OS's hosts file | Here: `127.0.0.1` **[verified]**. This machine's `/etc/hosts` maps `localhost` to `127.0.0.1` only, and `getent ahosts localhost` returns no `::1`. |

**`"localhost"` is OS-dependent.** On a system whose hosts file lists `::1 localhost`, Bun's
"IPv6 first" loop would bind `[::1]` only, and `curl http://127.0.0.1:5273` would then be
refused. That is **inferred** from `bsd.c`; macOS was not tested here. Vite's docs warn about
the same class of problem: resolution order can make "browsers … use a different resolved
address than the one Vite is listening to"
([vite.dev `server.host`](https://vite.dev/config/server-options#server-host)).

**Browsers do not need `::1`.** **[source]** The Fetch Standard pins how a browser resolves
`localhost`: when the host's public suffix is `localhost`, *resolve an origin* returns
« `::1`, `127.0.0.1` » without asking DNS
([Fetch §Resolving domains](https://fetch.spec.whatwg.org/#resolve-an-origin)). A tab opened at
`http://localhost:5273` therefore still reaches a server bound only to `127.0.0.1`.

### WSL2 (the user's setup)

- **[verified]** With mirrored networking, Windows `curl.exe` reached a WSL server bound to
  `127.0.0.1` through both `http://127.0.0.1:…` and `http://localhost:…`. It could **not**
  reach a WSL server bound to `::1`. That matches Microsoft's list for mirrored mode: "Connect
  … using the localhost address `127.0.0.1`. IPv6 localhost address `::1` is not supported"
  ([learn.microsoft.com/windows/wsl/networking](https://learn.microsoft.com/en-us/windows/wsl/networking#mirrored-mode-networking)).
  So on WSL, binding `::1`, or `localhost` on a distro that maps it to `::1`, would break the
  Windows-side browser.
- **[source]** Mirrored mode also lists "Connect to WSL directly from your local area network
  (LAN)" as a feature. Inbound traffic is filtered by the Hyper-V firewall, which is on by
  default from WSL 2.0.9 (same page). A wildcard bind in mirrored mode is therefore one firewall
  rule away from being on the LAN. **[verified]** partly: from inside WSL, the wildcard server
  answered on the LAN address `10.0.0.125`. Windows → `10.0.0.125` failed. Reachability from a
  second device was not tested.
- **[source]** In default NAT mode, `localhostForwarding` (default `true`) makes "ports bound to
  wildcard or localhost in the WSL 2 VM … connectable from the host via `localhost:port`"
  ([wsl-config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#main-wsl-settings)).
  So `127.0.0.1` works for the Windows browser in both modes.
- **[verified]** One consequence cuts the other way: in mirrored mode, **any Windows process**
  can reach a WSL service on `127.0.0.1`. The loopback boundary spans both OSes.

### What binding buys and what it doesn't

A loopback bind stops **other machines**. It does nothing against the attacks below, because
they all run inside the developer's own browser, which is itself on loopback. Rails
`web-console`'s allowed-IPs model has the same limit (§6).

## 3. What a page on another origin can do to `http://localhost:5273`

Everything here is **[source]**, from the specs linked. **[verified]** entries replay the same
request with `curl` to show what the server sees.

### The ground rules

- **The same-origin policy blocks reads, not sends.** A CORS-safelisted method is `GET`, `HEAD`
  or `POST`, and a safelisted `Content-Type` is only `application/x-www-form-urlencoded`,
  `multipart/form-data` or `text/plain`
  ([Fetch §CORS-safelisted request-header](https://fetch.spec.whatwg.org/#cors-safelisted-request-header)).
  Such requests go out **without a preflight**, and the server runs its handler. CORS only
  decides whether the page may *read* the response.
- **`fetch(url, { mode: "no-cors" })`** "restricts requests to using CORS-safelisted methods and
  CORS-safelisted request-headers" and yields an opaque response
  ([Fetch §request mode](https://fetch.spec.whatwg.org/#concept-request-mode)). That is enough
  to deliver a `text/plain` body such as `system("…")` to a handler that reads the raw body.
  **[verified]** A `curl` replay of that request (`POST`, `Content-Type: text/plain`,
  `Origin: https://attacker.example`, `Sec-Fetch-Site: cross-site`) reached a `Bun.serve`
  handler, which logged the body. Nothing in Bun stopped it.
- **Top-level form POST.** `<form method=POST action=http://localhost:5273/…>` is a navigation.
  It needs no script on the target and cannot be blocked by CORS.

### WebSocket

The handshake is **not subject to the same-origin policy or CORS**. The browser sends `Origin`,
and the server alone decides. RFC 6455 §10.2: servers "SHOULD verify the |Origin| field … If the
origin indicated is unacceptable … respond … with … 403"
([RFC 6455](https://www.rfc-editor.org/rfc/rfc6455#section-10.2)). The Fetch Standard appends
`Origin` whenever the request mode is `websocket`
([Fetch §append a request Origin header](https://fetch.spec.whatwg.org/#append-a-request-origin-header)).

- **[verified]** A `Bun.serve` route that calls `server.upgrade(req)` accepted a handshake with
  `Origin: https://attacker.example` and sent it messages. **Bun adds no Origin check to
  app-defined upgrades.**
- **[verified]** Bun's own dev-server HMR socket `/_bun/hmr` does check. It answered
  `403 Blocked: Origin header does not match the dev server` for a foreign `Origin`, `101` for a
  matching one, and `101` for no `Origin`.

This is the attack class behind webpack-dev-server
[CVE-2018-14732 / GHSA-cf66-xwfp-gvc4](https://github.com/advisories/GHSA-cf66-xwfp-gvc4) ("the
origin of requests to the websocket server … are not validated") and Vite
[CVE-2025-24010 / GHSA-vg6x-rcgg-rjx6](https://github.com/advisories/GHSA-vg6x-rcgg-rjx6)
cause [2] ("Lack of validation on the Origin header for WebSocket connections … an attacker can
read and write messages").

A REPL over WebSocket with no `Origin` check is remote code execution from any tab.

### EventSource

`new EventSource(url)` builds a *potential-CORS request* with the `Anonymous` CORS state, which
is mode `cors`
([HTML §9.2 EventSource constructor](https://html.spec.whatwg.org/multipage/server-sent-events.html#dom-eventsource)).
It is a plain `GET` with no custom headers, so there is **no preflight**:

- the request reaches the server, and the stream starts server-side;
- the response is readable only if it passes the CORS check. Without
  `Access-Control-Allow-Origin` the browser fails the connection and the page sees nothing.

**[verified]** The Reader sends no `Access-Control-Allow-Origin`, so a cross-origin page cannot
read `/events`. A DNS-rebinding page can, because to the browser it is same-origin (§4).

### What headers the server gets to check

- **`Origin`** ([Fetch §append a request Origin header](https://fetch.spec.whatwg.org/#append-a-request-origin-header)):
  - Always present on CORS-mode requests (including `EventSource` and CORS `fetch`) and on
    WebSocket handshakes.
  - Present on every non-`GET`/`HEAD` request, CORS or not, so **every cross-origin POST**
    carries it.
  - For a non-CORS POST, the value becomes the literal **`null`** under referrer policy
    `no-referrer`. It also becomes `null` under the default `strict-origin-when-cross-origin`
    when an **`https` page posts to an `http` URL**, which is exactly
    `https://attacker.example` → `http://localhost:5273`.

  So an allowlist must reject `null` as well as foreign origins. Plain `GET` subresources
  (`<img>`, `<script>`) carry **no** `Origin`.
- **`Sec-Fetch-Site`** takes the values `same-origin`, `same-site`, `cross-site` or `none` (user
  typed the URL or opened a bookmark)
  ([Fetch Metadata §set-site](https://w3c.github.io/webappsec-fetch-metadata/#sec-fetch-site-header)).
  It is only sent when the target is a **potentially trustworthy URL**
  ([§append the Fetch metadata headers](https://w3c.github.io/webappsec-fetch-metadata/#abstract-opdef-append-the-fetch-metadata-headers-for-a-request)).
  `http://localhost`, `*.localhost`, `127.0.0.0/8` and `::1` qualify
  ([Secure Contexts §is origin potentially trustworthy](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)).
  Under DNS rebinding the URL is `http://attacker.example`, which is not trustworthy, so the
  header is **absent** exactly when it is most needed. It helps as belt-and-braces; it cannot be
  the primary check.
- **Ports do not make a different site.** "For … same site, the port and domain components are
  ignored" ([HTML §Sites](https://html.spec.whatwg.org/multipage/browsers.html#concept-site-same-site)).
  A page on `http://localhost:3000` (the Host app, or any other dev server) is **`same-site`**
  with the Reader, not `cross-site`. Three consequences:
  - a check for "not `cross-site`" lets every other localhost dev server through;
  - `SameSite` cookies do not separate them either;
  - "Cookies do not provide isolation by port"
    ([RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5)).

  The only boundary that separates `localhost:3000` from `localhost:5273` is the **origin**,
  meaning an exact `Origin` match *including the port*.

### Browser gates: Private Network Access and Local Network Access

Everything here is **[source]**.

- **PNA** (Chrome) required CORS preflights with `Access-Control-Request-Private-Network`
  ([WICG PNA](https://wicg.github.io/private-network-access/)). Its one shipped piece, from
  Chrome 94, blocks **non-secure (HTTP) public** pages from reaching private addresses including
  localhost
  ([Chrome blog, PNA update](https://developer.chrome.com/blog/private-network-access-update)).
  The wider PNA rollout "is on hold"; **LNA replaced it**
  ([Chrome blog, LNA](https://developer.chrome.com/blog/local-network-access)).
- **LNA** (Local Network Access) puts a **permission prompt** in front of requests that cross to
  a more private address space.
  - Where it applies: public → local, public → loopback, and local → loopback. **"loopback →
    anything"** is not a local network request
    ([LNA explainer](https://github.com/explainers-by-googlers/local-network-access/blob/main/explainer.md)).
  - The address space is judged on the IP address actually connected to, "for each new
    connection … as DNS rebinding attacks may otherwise trick the user agent"
    ([LNA spec §DNS rebinding](https://wicg.github.io/local-network-access/#dns-rebinding)).
  - Chrome shipped the prompt in **142** for fetch, subresources and subframes
    ([Chrome blog](https://developer.chrome.com/blog/local-network-access)). WebSockets are
    gated from **147**
    ([blink-dev Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/O6GMKt44Ups);
    [chromestatus 5197681148428288](https://chromestatus.com/feature/5197681148428288)).
  - Firefox rolled LNA out from **151**, turned it on "by default for all users" in **153**, and
    added WebSockets in **154**
    ([151](https://www.firefox.com/en-US/firefox/151.0/releasenotes/),
    [153](https://www.firefox.com/en-US/firefox/153.0/releasenotes/),
    [154](https://www.firefox.com/en-US/firefox/154.0/releasenotes/)).
  - WebKit has LNA work in review
    ([WebKit PR #72725](https://github.com/WebKit/WebKit/pull/72725)). Shipping in Safari was
    not confirmed.
- **Why the Reader cannot rely on it:**
  1. **Top-level navigations are not gated in Chromium.** The spec says "Chromium only applies
     LNA restrictions to iframe navigations currently"
     ([LNA spec §Integration with Fetch](https://wicg.github.io/local-network-access/#integration-with-fetch)).
     A cross-site `<form method=POST target=_blank>` still lands.
  2. **Loopback → loopback is exempt.** Any page served from localhost, whether the Host app
     with an XSS bug, another dev server, or a malicious package's dev server, is not gated.
  3. It is a prompt. A user can click Allow, and enterprise policy can turn it off
     (`LocalNetworkAccessRestrictionsTemporaryOptOut`, same blink-dev thread).
  4. Browser coverage and versions vary: Safari is unconfirmed, and older versions are
     ungated.

  webpack-dev-server's advisory makes the same point in reverse: a bug that Chrome 94+ happened
  to mask still hit Firefox users
  ([GHSA-9jgg-88mc-972h](https://github.com/advisories/GHSA-9jgg-88mc-972h)). Browser gates are a
  bonus, not a defence.

## 4. DNS rebinding and `Host`-header allowlists

**How it works.**
1. The user visits `http://attacker.example:5273`, served from the attacker's IP.
2. The attacker drops the DNS TTL and re-points the name at `127.0.0.1`.
3. The page's `fetch("/repl")` now reaches the Reader.
4. To the browser this is **same-origin** (`attacker.example:5273`), so the page can read
   responses, open WebSockets and read `EventSource` streams. The `Origin` equals the `Host`,
   and neither is the Reader's name.

Vite's advisory walks through exactly this, cause [3]: "Non-HTTPS servers are vulnerable to DNS
rebinding attacks without validation on the Host header"
([GHSA-vg6x-rcgg-rjx6](https://github.com/advisories/GHSA-vg6x-rcgg-rjx6)).

**The fix is to check `Host`.** A rebound request still carries `Host: attacker.example:5273`,
because the browser sends the name it thinks it is talking to. Checking that `Origin` matches
`Host` (Jupyter's `check_origin` does exactly `origin_host == host`,
[jupyter_server `base/handlers.py`](https://github.com/jupyter-server/jupyter_server/blob/main/jupyter_server/base/handlers.py))
does **not** stop rebinding. The `Host` value itself has to be on an allowlist.

**Published cases** (all **[source]**):
- **webpack-dev-server 2.4.3 (2017).** "We added a check for the correct `Host` header … This
  allowed evil websites to access your assets", shipped as a breaking patch release
  ([release v2.4.3](https://github.com/webpack/webpack-dev-server/releases/tag/v2.4.3)). Today it
  is `devServer.allowedHosts: 'auto'`; `'all'` "bypasses host checking. **THIS IS NOT
  RECOMMENDED** as apps that do not check the host are vulnerable to DNS rebinding attacks"
  ([webpack docs](https://webpack.js.org/configuration/dev-server/#devserverallowedhosts)).
- **webpack-dev-server CVE-2025-30360.** Its WebSocket `Origin` check "always allows IP address
  `Origin` headers", so any site served *from an IP* could hijack the socket
  ([GHSA-9jgg-88mc-972h](https://github.com/advisories/GHSA-9jgg-88mc-972h)). The lesson: IP
  literals are safe to allow in **`Host`**, because they cannot be rebound, but **not in
  `Origin`**. Its sibling **CVE-2025-30359** stole source through a cross-site
  `<script src="http://localhost:8080/main.js">`
  ([GHSA-4v9v-hfq4-rm2v](https://github.com/advisories/GHSA-4v9v-hfq4-rm2v)). A `GET` that
  returns executable JS is readable cross-origin by design.
- **Vite CVE-2025-24010** (fixed in 6.0.9 / 5.4.12 / 4.5.6). There were three causes:
  `Access-Control-Allow-Origin: *` by default, no WebSocket `Origin` check, and no `Host` check.
  The fix added **`server.allowedHosts`**, where "localhost and domains under `.localhost` and
  all IP addresses are allowed by default". Setting it to `true` "allows any website to send
  requests to your dev server through DNS rebinding attacks." `server.cors` now defaults to a
  localhost-only origin regex
  ([advisory](https://github.com/advisories/GHSA-vg6x-rcgg-rjx6);
  [vite.dev server options](https://vite.dev/config/server-options#server-allowedhosts)). The
  fix also added a WebSocket token check (`legacy.skipWebSocketTokenCheck` is the opt-out).
- **Jupyter** `ServerApp.allow_remote_access`: "By default, requests get a 403 forbidden
  response if the 'Host' header shows that the browser thinks it's on a non-local domain … This
  protects against 'DNS rebinding' attacks … Local IP addresses (such as 127.0.0.1 and ::1) are
  allowed as local, along with hostnames configured in local_hostnames." It defaults to
  "Disallow remote access if we're listening only on loopback addresses"
  ([jupyter_server `serverapp.py`](https://github.com/jupyter-server/jupyter_server/blob/main/jupyter_server/serverapp.py)).
- **Rails itself.** `config.hosts` is "used by the HostAuthorization middleware … to help
  prevent DNS rebinding attacks"
  ([Rails guides, configuring](https://github.com/rails/rails/blob/main/guides/source/configuring.md#confighosts)).
  In development it defaults to
  `[".localhost", ".test", IPAddr.new("0.0.0.0/0"), IPAddr.new("::/0")]`
  ([`host_authorization.rb`](https://github.com/rails/rails/blob/main/actionpack/lib/action_dispatch/middleware/host_authorization.rb)).
  That is the same shape: names under `localhost` plus any IP literal.
- **Bun's own dev server already does this, for its own routes only.**
  - **[verified]** With `development: { hmr: true }`, a request with
    `Host: rebind.attacker.example` for the HTML page and for `/_bun/hmr` got
    `403 Blocked: Host header does not match the dev server`. `POST /post` and the SSE route
    under the same `Host` got **`200`**.
  - **[verified]** With `development: false`, the HTML page was served under any `Host`.
  - **[source]** The code is `is_allowed_host_header` and `is_allowed_dev_origin` in
    [`src/runtime/bake/DevServer.rs` @36cd151, lines 1353–1478](https://github.com/oven-sh/bun/blob/36cd1514eccf589b71874c69333b25d6a1bb3019/src/runtime/bake/DevServer.rs#L1353-L1478).
    Allowed hosts are `localhost`, `*.localhost`, any IP literal ("A host that the resolver reads
    as a number is never looked up, so DNS cannot rebind it"), or the configured `hostname`.
    Allowed `Origin` hosts are `localhost`, `*.localhost`, or an exact match with `Host`, and
    `null` is rejected. The Origin check **ignores the port**, so a page on `localhost:3000`
    would pass it. That is fine for HMR, but too loose for a REPL (§3).

  This is a ready-made template: a few dozen lines, written by the runtime the Reader already
  uses.

## 5. Secret tokens: what they cost and what they add

Everything here is **[source]**.

### Jupyter

- **Mechanism.** A random token (`binascii.hexlify(os.urandom(24))`,
  [`auth/identity.py`](https://github.com/jupyter-server/jupyter_server/blob/main/jupyter_server/auth/identity.py))
  is printed as `http://localhost:8888/?token=…`. It is also accepted as
  `Authorization: token …`. After the first visit a cookie is set, and "you won't need to use the
  token again, unless you switch browsers, clear your cookies, or start a Jupyter server on a new
  port" ([Jupyter Server security docs](https://jupyter-server.readthedocs.io/en/latest/operators/security.html)).
- **It layers everything.** Token, plus `Host` allowlist, plus `Origin` check on API and
  WebSocket requests, plus `_xsrf`.
- **Launch.** It opens the browser through a local **redirect file**, so the token is not
  visible on the command line to "other users on a multi-user system". The option's own help
  says that on "Windows Subsystem for Linux (WSL) … launching a browser using a redirect file can
  lead the browser failing to load" (`use_redirect_file`, `serverapp.py`).

### VS Code server

- **Mechanism.** `--connection-token` / `--connection-token-file` / `--without-connection-token`.
  The default is a UUID, persisted to `<user-data-dir>/token` with mode `0600`, so it survives
  restarts
  ([`serverConnectionToken.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/server/node/serverConnectionToken.ts)).
- **Delivery.** The token arrives as `?tkn=`. The server swaps it for a `vscode-tkn` cookie
  (`SameSite=Lax`, one week) and **302s to a clean URL** so the token leaves the address bar and
  the `Referer` ([`webClientServer.ts` `_handleRoot`](https://github.com/microsoft/vscode/blob/main/src/vs/server/node/webClientServer.ts)).

### Rails `web-console`

- **Mechanism.** An **allowed-IPs** list: "By default, only requests coming from IPv4 and IPv6
  localhosts are allowed" ([README](https://github.com/rails/web-console/blob/main/README.markdown)).
- **Why that is not the real defence.** Against a malicious *page*, the allowlist does nothing:
  the victim's own browser comes from `127.0.0.1`. Three other things carry the load
  ([`middleware.rb`](https://github.com/rails/web-console/blob/main/lib/web_console/middleware.rb),
  [`session.rb`](https://github.com/rails/web-console/blob/main/lib/web_console/session.rb)):
  - eval requests must be **XHR `PUT`** (`request.xhr? && request.put?`), and both the method and
    the `X-Requested-With` header force a CORS preflight that a cross-origin page cannot pass;
  - they must name an **unguessable session id**, `SecureRandom.hex(16)`, handed out only in the
    error page's response headers;
  - the session exists only while an error page is live.
- **The IP model has failed before.** It was bypassed by a forged `X-Forwarded-For`
  ([CVE-2015-3224 / GHSA-67j6-xv27-w6ww](https://github.com/advisories/GHSA-67j6-xv27-w6ww)).

### What a token buys beyond `Host` + `Origin`

- **Local non-browser clients.** Any process or OS user on the machine can hit
  `127.0.0.1:5273` and forge `Host` and `Origin` freely. On WSL mirrored mode that includes
  **every Windows process** (§2). Only a secret stops them. On a single-user laptop, a process
  running as the same user can already run `bin/rails console` itself, so the gain there is
  small. On shared machines it is real.
- **Defence in depth** if an `Origin`/`Host` check has a bug. webpack-dev-server's IP-literal
  `Origin` mistake (CVE-2025-30360) is the example.
- **Another localhost origin.** A page on `localhost:3000` cannot read a token held in the
  Reader tab's memory or `sessionStorage`, which are origin-scoped. It **can** get a token held
  in a **cookie**: cookies ignore ports, and `SameSite` treats all localhost ports as one site
  (§3). An exact-port `Origin` check already stops this case.

### What a token costs

- **Delivery.** The URL is no longer just "`localhost:5273`". It needs a printed tokenised URL,
  an auto-opened browser (which Jupyter's own docs say is fragile on WSL), or a persisted token
  file. That conflicts with `port.ts`'s stated design: "`rails-log-reader` and 5273 is the whole
  of what a developer has to keep in their head".
- **Reloads and new tabs** need a cookie, which is not port-isolated, or re-entry.
- **`EventSource` and `WebSocket` cannot set headers**, so the token rides in the query string
  or the first WebSocket message.
- **Leakage.** The token can leak through terminal scrollback, shell history, `Referer` (hence
  VS Code's redirect), and screenshots.

## 6. The menu

Each entry lists what it stops, what it leaves open, and what it costs the user.

| # | Defence | Stops | Leaves open | Cost to the user |
|---|---|---|---|---|
| **A** | **Bind `127.0.0.1`** (explicit `hostname`) | Other devices on the LAN, including WSL mirrored-mode LAN exposure | Every in-browser attack (§3–4); local processes | ~None: LAN access already given up. `::1`-only clients are refused, but browsers fall back per Fetch. **Avoid** `"localhost"` (OS-dependent, may bind `::1` only) and `"::1"` (unreachable from Windows under WSL mirrored mode **[verified]**). |
| **B** | **`Host` allowlist** on every route and upgrade: `localhost`, `127.0.0.1`, `[::1]`, optionally `*.localhost`, with any port or exactly the Reader's port | DNS rebinding: reads of `/events` and `/earlier`, REPL calls, and WebSocket via a rebound name, in every browser | Cross-site "send-only" requests (C) | ~None for local use. **Breaks a third-party tunnel** (ngrok and similar forward their own `Host`) unless that host is allowlisted. The map names a tunnel as the other-device escape hatch, and a tunnel would also expose the REPL to the internet, so the two decisions interact. |
| **C** | **Exact `Origin` allowlist** on every state-changing request, on every WebSocket handshake, and on `/events`: the Reader's own origin *with port*, `null` rejected, and a missing `Origin` allowed only for non-browser clients (browsers always send it on POST, CORS and WebSocket) | Cross-site POST / no-cors fetch / form POST; cross-site WebSocket hijacking; other **localhost ports** (Host app XSS, other dev servers), which LNA and `Sec-Fetch-Site` both let through | DNS rebinding alone (pair with B); local non-browser clients; `GET` subresources (no `Origin`), so nothing sensitive or side-effecting may sit behind a plain `GET` | Small. Must allow each spelling the user may open (`localhost` / `127.0.0.1` / `[::1]` × the actual port). |
| **C′** | **`Sec-Fetch-Site`**: reject when present and not `same-origin` (allow `none` for navigations) | Same as C in modern browsers | Absent under DNS rebinding and in old browsers, so only a supplement to C | ~None |
| **D** | **Non-simple request shape** for the eval endpoint: require `Content-Type: application/json` or a custom header, rejected server-side when missing; **never send `Access-Control-Allow-Origin`** | Cross-origin `fetch` (the preflight fails) and form POSTs, as web-console does with XHR + `PUT`. Never answering with `ACAO` closes Vite's cause [1]. | WebSocket (no preflight); DNS rebinding | ~None. Only works if the server enforces the header; the preflight does the rest. |
| **E** | **Per-run secret token** (Jupyter / VS Code style), held in page memory or `sessionStorage` and sent as a header (query or first message for SSE/WebSocket) | Everything C and B stop, plus local non-browser clients and other OS users, plus bugs in C or B | A malicious process running as the same user, which can run the console itself anyway | **Real.** The tokenised URL has to be delivered; reloads and bookmarks break or need a persisted token or cookie; the token can leak. Conflicts with the "just 5273" ergonomics. |
| **F** | **Rely on browser LNA** (Chrome 142+/147+ WebSocket, Firefox 153+/154+ WebSocket) | Public → loopback subresource requests in current Chrome and Firefox, behind a prompt | Top-level navigations (Chromium), loopback → loopback, the user clicking Allow, Safari, old versions | None to adopt, but it is ambient rather than something the Reader controls. Not a defence on its own. |

**Transport note.** The REPL's transport choice changes which rows it needs. **SSE + POST**
inherits D's preflight protection for the POST, and the stream is unreadable cross-origin
without `ACAO`. **WebSocket** gets no browser-side protection at all, so C on the handshake is
mandatory.

**Existing-surface note.** `POST /initializer-repair` takes no body today, so any cross-site page
can trigger it with a form or a no-cors `fetch`. It needs B + C (or D) regardless of the REPL.

## 7. Leaning (not a decision)

The leaning is **A + B + C + D as the baseline**, applied to *every* route (including `/events`
and `/initializer-repair`), with C′ as a cheap supplement.

- A, B and D cost the user nothing. C costs a few lines, and Bun's `DevServer.rs` is a template
  for B and C, tightened to compare ports.
- Together they stop every in-browser attack found here: cross-site sends, WebSocket hijacking,
  DNS rebinding, and other localhost ports.
- This is also the combination Vite, webpack-dev-server, Jupyter and Bun's own dev server
  converged on, after the CVEs above.

**E (token) is the genuine open question for grilling.** It is what Jupyter and VS Code server
add on top. It buys protection against local non-browser clients (notably any Windows process
under WSL mirrored mode, and other OS users) and against a bug in B or C. It costs the "just
5273" ergonomics. A middle path to weigh is a token scoped to the **REPL only**, leaving log
viewing token-free.

**F is not a defence** the Reader can count on.
