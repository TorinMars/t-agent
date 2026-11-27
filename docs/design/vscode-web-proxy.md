# VS Code in the browser: the page server

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

VS Code (`code serve-web`, run by the engine that owns the terminal) is shown on the T-Agent page's own origin under `/vscode/<engine id>/`. This file is the page server's part: the start routes of the page, the launch ticket and the cookie, the proxy of HTTP and WebSocket traffic and its three transports. The engine's part (the VS Code process, its settings, Contract A and Contract B on `/v1`) is in its own file. Code: `services/vscode-proxy.js`, `routes/vscode-web.js`, `services/vscode-local-transport.js`, the routes in `routes/tasks.js` and `routes/remote-servers.js`.

## Launch

- This engine: `POST|GET /api/tasks/:id/terminals/:terminalId/vscode` and `POST …/vscode/accept-license`. The task must belong to the person (404 `TASK_NOT_FOUND`); the call goes in-process to the engine's VS Code manager with `{ taskId, terminalId, host, proto, owner }`. A refusal of the manager is answered with its code and status (`VSCODE_NOT_INSTALLED`, `VSCODE_LICENSE_REQUIRED`, ...), anything that is not a code as 500 `VSCODE_START_FAILED`.
- A remote engine: `POST|GET /api/remote-servers/:id/tasks/:taskId/terminals/:terminalId/vscode` and `POST …/vscode/accept-license` call that engine's Contract A with its Engine token (POST start sends `{ host, proto }`). An engine without the capability `vscode:web` in `/v1/info` answers 501 `VSCODE_WEB_UNSUPPORTED`, and is not asked. Its errors (`TASK_NOT_FOUND`, `REMOTE_OFFLINE`, ...) are passed on as everywhere else in that router.
- `host` and `proto`: what the browser used, read like Express with `trust proxy` one hop (X-Forwarded-Host / X-Forwarded-Proto first, then Host); a host that is not `^[A-Za-z0-9.\-\[\]:]{1,255}$` answers 400 `VSCODE_HOST_INVALID`.
- The answer is Contract A plus `open_url` = `<open_path>&ta_launch=<ticket>`, only in state `ready` and only when `open_path` starts with `/vscode/<engine_id>/` (anything else from an engine gets no ticket). The page polls GET while the state is `starting`; every ready answer has a fresh ticket. `Cache-Control: no-store`.
- Ticket: `tvl_` + 24 random bytes, single use, 30 s, in memory (at most 1000 pending), bound to the session that asked, the engine id and the target (this engine, or the `remote_servers` row and its owner).

## The cookie

The first `GET`/`HEAD` with `ta_launch` exchanges the ticket for the cookie `ta_vscode` and answers 302 to the same address without the ticket (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`). The ticket is used up by any try, also a wrong one (another engine's path, a POST). The cookie: `tvc_` + 24 random bytes, `Path=/vscode/<engine id>/`, `HttpOnly`, `SameSite=Lax`, `Secure` when the browser came over HTTPS, `Expires` at the session's expiry. It maps, in memory, to the session id, the owner, the engine id and the target; a new launch of the same session and engine replaces the older value (the browser replaced it too).

Every request then needs that cookie for the engine of its path and a session that is still signed in (`client-auth` `sessionActive`). The cookie is no credential anywhere else: nothing under `/api`, `/v1` or the pages reads it, and its path keeps the browser from sending it there. A restart of the server forgets the cookies; the page opens VS Code again with a new ticket.

Session end: logout and the change of the authenticator (`app.locals.disconnectClientSession` / `disconnectAllClientSessions` in server.js) forget the session's cookies and tickets and close its VS Code sockets with 1008; the browser side of every VS Code socket also carries `clientSessionId`, so server.js's 30 s check closes it like a terminal. A sweep every 30 s forgets cookies of sessions that ended otherwise (expiry, a device signed out in Settings), and a socket checks its session at most once a second on the messages it carries.

## The proxy

`ALL /vscode/<engine id>/*` (routes/vscode-web.js) is mounted in server.js right after the access gate: local-only mode keeps it to this machine like everything else. It sits before the page session (the session middleware and its cookie settings are skipped for `/vscode/`, so VS Code's hundreds of requests neither touch nor renew the session nor get its cookie), before the access log, the login gate and the body parsers (`OWN_PARSERS` has `vscode` and `v1/vscode`; bodies are streamed). It is not under `/api`, whose gate wants `X-Requested-With` and sets `no-store`. The login gate reserves `vscode` (no login path may start with it) and never redirects it home.

Refusals: a path that is not `/vscode/<engine id>/…` (the engine id `^[A-Za-z0-9-]{1,64}$`, at least the slash after it), a segment that is `.`, `..` or empty (one trailing slash is allowed), that does not decode or that decodes to something with `/`, `\`, `%` or a control character, a missing, unknown or other engine's cookie, a session that ended, a remote row that is gone or has another owner: all get exactly the login gate's 404 for that path (`Cannot GET /vscode/...`, the same headers; compression runs only after the authentication, so not even a `Vary` header differs). The WebSocket upgrade gets `404 Not Found`, or 403 without a same-origin `Origin` header (the check of the terminals).

Forwarding:

- Every segment is re-encoded with `encodeURIComponent` (so `@` travels as `%40`), the query is kept as it came except `ta_launch` and any byte outside printable ASCII, `#` and `\`, which are percent-encoded.
- Request headers: `content-type`, `content-length`, `accept`, `range`, `if-none-match` only, plus `Authorization: Bearer <engine token>` to a remote engine. Never cookie, origin, referer, user agent, forwarded or other `x-*` headers, and never `accept-encoding` (VS Code answers uncompressed; the tunnel drops `content-encoding`).
- Response headers: the tunnel's allowlist for every transport alike (`content-type`, `content-length`, `last-modified`, `etag`, `content-range`, `accept-ranges`, `content-disposition`, `cache-control`, `location`), plus `X-Content-Type-Options: nosniff`. Never `set-cookie` or `service-worker-allowed`.
- `location`: resolved against the request's path; when its path is under `/vscode/<engine id>` it becomes that path with its query and fragment, on this origin, without a `tkn` or `ta_launch` parameter (an absolute address on 127.0.0.1 or the forwarded host becomes relative). A redirect that leads elsewhere loses its `location`.
- Text answers are compressed for the browser (`compression`, after the authentication).
- The head of the answer must arrive within 30 s of the request (a wait in the tunnel's queue included): 504 `REMOTE_TIMEOUT`, the upstream request cancelled. After the head there is no limit (downloads). A failed connection is 502 with the code (`REMOTE_CONNECTION_FAILED`, `REMOTE_OFFLINE`, `REMOTE_TUNNEL_BUSY`, ...). Nothing logs a query, a ticket, a cookie or a token.

## Transports

- **This engine**: in-process, through `services/vscode-local-transport.js`, which wraps the manager of `services/vscode-web.js` (`getVscodeWeb()`, required lazily; tests set a fake one with `setManagerForTests`). The calls the page server makes: `start`, `status`, `acceptLicense` (`{ taskId, terminalId, host, proto, owner }` -> Contract A, a refusal rejects with the code as message and `statusCode`); `request({ method, path, headers, body, host, proto, signal })` -> `{ status, headers, body }` with `path` the browser path and query (the same string VS Code's `--server-base-path` serves), `body` a readable stream or null and `signal` an AbortSignal; `openWebSocket({ path, headers, host, proto })` -> an object that behaves like a `ws` WebSocket. The socket is bridged here (not handed the raw upgrade), so that the browser side carries the session for logout. Changes of the manager's interface stay in that module.
- **Direct**: a remote engine with an http(s) base: `http(s)://<base>/v1/vscode/web/<base64url of the host><browser path><query>` and the same path over ws(s) for the WebSocket (`perMessageDeflate` off, no redirects followed).
- **Tunnel**: a service link (`tunnel://<link id>`): `getHub().request` and `openWebSocket` to the same path, `authorization` the only header of the WebSocket. At most 24 HTTP requests per link at once (a semaphore; the rest wait in order), so VS Code's bursts of hundreds of static files leave most of the tunnel's 128 streams to terminals and everything else. A WebSocket message above 32 MiB closes both sides with 1009: from the browser it is checked here before sending (the tunnel would otherwise close with 1013), from the engine the tunnel's client reports its local socket's oversized message as 1009.

WebSocket flow control: over the tunnel the browser socket's send buffer holds back the tunnel's credit (`limitBy`); a direct or local upstream is paused while the browser holds more than 4 MiB unsent, and the browser socket is paused while the engine side holds more than 4 MiB, each until it is down to 1 MiB.

## Known limits

- Cookies and tickets live in memory: a restart of the page server asks for a new launch.
- Hidden tasks (per-task visibility of a link) are refused by the engine's start route only; an open VS Code can reach any folder the terminal user can, the same known limit as `/v1/fs/*`.
- Only verified with a fake VS Code, a fake engine and a real tunnel on loopback (test/vscode-proxy.test.js, test/vscode-proxy-routes.test.js, test/vscode-proxy-server.test.js), never with a real `code serve-web` or a real remote link.
