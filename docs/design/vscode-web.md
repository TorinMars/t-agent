# Open in VS Code (browser)

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

A terminal's folder opens in VS Code for the browser, served by the engine that has the folder (`code serve-web`, the web version of VS Code that
the VS Code CLI runs) and shown on the T-Agent page origin under `/vscode/<engine id>/`. This file describes the engine side (the process, Contracts A
and B) and the interface the page server uses for a local engine. The page server side (Contract C: the `/api` routes, the launch ticket and the
cookie, the `/vscode/<engine id>/` proxy, the tunnel and the login gate) and the page UI are described where they are built.

Code: `services/vscode-web.js` (the manager), `routes/vscode-web-engine.js` (Contract B, the shared answer of Contract A), the Contract A routes and
capability in `routes/engine-v1.js`, the WebSocket branch and `OWN_PARSERS` in `server.js`. Tests: `test/vscode-web.test.js`,
`test/vscode-web-engine.test.js`, with the fake CLI `test-support/fake-vscode-cli.js`.

## Decisions

- **Same origin.** VS Code is served on the T-Agent page origin under `/vscode/<engine id>/`, opened with a single-use launch ticket that becomes an
  httpOnly cookie scoped to that path (Contract C). A later optional "VS Code address" setting may change only the origin of `open_url`.
- **Wherever the CLI is found**, with a switch per engine to turn it off and an idle time (default 30 minutes).
- **Data under the T-Agent data home**: `<dataHome>/vscode/server` (`--server-data-dir`) and `<dataHome>/vscode/cli` (`--cli-data-dir`), never
  `~/.vscode*`. When the service runs as root and drops to a terminal user who cannot enter the data home (`/root/.tagent`), the same layout is used
  in that user's home (`~<user>/.tagent/vscode`), with a warning in the log.
- **The license** of the VS Code Server (`--accept-server-license-terms`) is confirmed once per engine: a start answers `VSCODE_LICENSE_REQUIRED`
  until `POST .../vscode/accept-license` was called. The confirmation is the server state key `vscode_license_accepted`.
- **Hidden tasks**: only the start, status and license routes are under `/v1/tasks/:id` and so behind the task visibility guard. VS Code itself opens
  any folder by path (`?folder=`), the same known limit as `/v1/fs/*` ("Per-task visibility" in [service-links.md](service-links.md)).

## The process (services/vscode-web.js)

**One `code serve-web` per engine.** It serves any folder through `?folder=`. Arguments: `serve-web --accept-server-license-terms
--connection-token-file <run>/<id>.token --server-base-path /vscode/<engine id> --server-data-dir <home>/server --cli-data-dir <home>/cli
--disable-telemetry --socket-path <run>/<id>.sock`. `<run>` is `<home>/run`, mode 0700; the token file is 0600 and holds 32 random bytes (hex), made
fresh at every start and removed at the end; the token is never on the command line. A data dir flag or `--disable-telemetry` is passed only when
`serve-web --help` lists it. Without `--socket-path` in the help, or when the socket path would be longer than 100 bytes (the limit of a Unix socket
address), it listens on `--host 127.0.0.1 --port 0` and the port is read from the CLI's "Web UI available at http://127.0.0.1:<port>" line.

**Finding the CLI.** `lib/find-program.js` for `code` (`VSCODE_CLI_PATH` first, then PATH, `~/.local/bin` and the other user and system folders,
then the login shell), then the CLI inside `Visual Studio Code.app` on a Mac. The probe runs `code serve-web --help` (15 s timeout) and needs
`--server-base-path` and `--connection-token-file` in it: no CLI is `VSCODE_NOT_INSTALLED`, a CLI without them (or without `serve-web`) is
`VSCODE_SERVE_WEB_UNSUPPORTED`. The answer is kept 5 minutes (30 seconds when no CLI was found, so an install is noticed soon).

**User and group.** It is spawned as the terminal user (`lib/terminal-user.js` `resolveTerminalUser`, `terminalEnvFor`; never root when the service
drops root), without `SESSION_SECRET` and `VSCODE_IPC_HOOK_CLI` in its environment, in its own process group (`detached`), so a stop ends the server
the CLI starts too.

**States.** `stopped -> starting -> ready | error`. `ensure({ host, proto })` checks, in this order, the switch (`VSCODE_DISABLED`), the CLI and the
license; a refusal is answered as `state: "error"` without changing the stored state, so the next call checks again. Otherwise it spawns the CLI and
answers `starting` at once; the page polls the status. Readiness: `GET /vscode/<engine id>/` over the socket with the token cookie, every 500 ms,
until it answers 200, for at most 5 minutes (the first start downloads the server). A process that exits before it is ready, or while it is ready,
gives `error` with `VSCODE_START_FAILED`, or `VSCODE_DOWNLOAD_FAILED` when its output speaks of a download or the network; so does a start that
misses the deadline, whose process is then killed. `detail` is the last 2 KB of the CLI's output (stdout and stderr), with the token, any `tkn=`
value and any `vscode-tkn=` cookie replaced by `<redacted>`. An error is not sticky: the next `ensure` starts again.

**Stop.** `stop()`: SIGTERM to the process group, SIGKILL after 3 s, then the socket and the token file are removed and the `onStop` callbacks run
(every open WebSocket through the manager is closed too). The switch turned off stops a running VS Code. **Idle**: every 30 s, a ready VS Code with
no open WebSocket and no request in flight stops once nothing went through it for the idle minutes (`vscode_web_idle_minutes`, default 30, 1 to
1440). **T-Agent exit**: `process.on('exit')` in `server.js` calls `shutdownShared()`, which SIGKILLs the process group synchronously. A process
left by a T-Agent that ended without its exit handler (SIGKILL, a crash) is found at the next start through `<dataHome>/vscode/serve-web.pid` and killed when
`ps` still shows `serve-web` with this base path.

**Settings** (declared in `lib/server-state-keys.js`, scope device, see [server-state-keys.md](server-state-keys.md)): `vscode_web_enabled`
(`{ enabled }`, default true), `vscode_web_idle_minutes` (`{ minutes }`, default 30), `vscode_license_accepted` (`{ accepted, at }`). They are per
engine on purpose: they are about a program and the processes of that machine. `GET` / `PUT /v1/vscode/settings` (scope `engine:admin`) read and
change the first two: `{ enabled?, idle_minutes? }` -> `{ enabled, idle_minutes, license_accepted }`, 400 `INVALID_VSCODE_SETTINGS`.

## Contract A: start and status (engine, /v1)

Scope `terminal:execute`; under `/v1/tasks/:id`, so the task visibility guard answers 404 `TASK_NOT_FOUND` for a hidden task.

- `GET /v1/tasks/:id/terminals/:terminalId/vscode`: the status, without starting anything. For a stopped VS Code it answers what a start would
  answer first (`VSCODE_DISABLED`, `VSCODE_NOT_INSTALLED`, `VSCODE_SERVE_WEB_UNSUPPORTED`, `VSCODE_LICENSE_REQUIRED`), so the page can ask for the
  license confirmation before the first start.
- `POST` on the same path, body `{ "host": "t.example.com", "proto": "https" }` (the page server's public host as the browser sees it, checked
  against `^[A-Za-z0-9.\-\[\]:]{1,255}$`, and `http` or `https`; 400 `INVALID_VSCODE_HOST` otherwise): starts VS Code when it is not running.
- `POST /v1/tasks/:id/terminals/:terminalId/vscode/accept-license` -> `{ "accepted": true }`.
- `POST /v1/vscode/stop` -> `{ "state": "stopped" }`.

The answer (200, `Cache-Control: no-store`): `{ state, error?, detail?, folder, base_path: "/vscode/<engine id>", open_path:
"/vscode/<engine id>/?folder=<encoded folder>", engine_id }`; `error` and `detail` only in state `error`. The folder is resolved on the engine
(`resolveFolder`): the terminal's own directory (`terminalWorkDir`), else the task's `work_dir`, else the folder of its `md_path`, else the terminal
user's home; never one the client names. 404 `TERMINAL_NOT_FOUND` for a terminal the task does not have. Capability `vscode:web` in `/v1/info`
(listed whether or not the CLI is installed).

## Contract B: the proxied traffic (engine)

`ALL /v1/vscode/web/<hostB64>/<rest...>` and a WebSocket upgrade on the same path, Bearer token with scope `terminal:execute` (the same check as
`requireEngineAuth`; the upgrade uses `authorizeBearer` in `server.js` before the fallthrough that destroys unknown sockets). `<hostB64>` is the
base64url of the public host, checked like the host above after decoding. `<rest>` is everything after `/vscode/<engine id>` in the browser's
address, query included; it is passed on below `--server-base-path /vscode/<engine id>`, so the browser path and VS Code's path are the same string
and nothing is rewritten. A path whose segments decode to `.` or `..` is 404 `VSCODE_PATH_INVALID`. `server.js` keeps the body parsers off
`/v1/vscode/` (`OWN_PARSERS`), so bodies are streamed both ways, and HEAD and Range work as VS Code answers them.

- 503 `VSCODE_NOT_RUNNING` while VS Code is not ready (the upgrade answers 503 on the socket); 502 `VSCODE_PROXY_FAILED` when the socket fails.
- **Request headers** reaching VS Code: `accept`, `accept-language`, `content-type`, `content-length`, `range`, `if-range`, `if-none-match`,
  `if-modified-since`, `cache-control`, `pragma`, `user-agent`, `x-requested-with` (an upgrade: the `sec-websocket-*` headers, `user-agent`,
  `accept-language`), plus `Cookie: vscode-tkn=<token>`, `X-Forwarded-Host: <host>`, `X-Forwarded-Proto` (the scheme the last start named for
  that host, else `https`) and `Origin: <proto>://<host>` (VS Code compares the origin of a WebSocket with the forwarded host). Everything else is
  dropped: the page's cookies, the engine token, `accept-encoding` (an uncompressed body, because a service link tunnel drops `content-encoding`;
  the page server compresses for the browser), forwarded headers of the caller.
- **Response headers**: `set-cookie`, `service-worker-allowed` and hop-by-hop headers are dropped; `location` loses any `tkn` parameter and, when it
  points at VS Code's own address (localhost, 127.0.0.1), becomes a path. The engine's own `Content-Security-Policy` (frame-ancestors) is taken off,
  so the page server sees VS Code's headers only.
- Every request and WebSocket message touches the idle timer.

## The local transport (the interface the page server calls in-process)

For a local engine the page server does not go through `/v1`: it calls the manager of its own process. The interface is stable:

```js
const { getVscodeWeb } = require('./services/vscode-web');
const { vscodeTerminalAnswer } = require('./routes/vscode-web-engine');
const vscode = getVscodeWeb();

// Contract A for /api/tasks/:id/terminals/:terminalId/vscode, with the task row the session may see:
await vscodeTerminalAnswer({ task, terminalId, start: false });                        // GET: the status
await vscodeTerminalAnswer({ task, terminalId, start: true, body: { host, proto } });  // POST: start
vscode.acceptLicense();                       // -> { accepted: true }   (accept-license; resolveFolder(task, terminalId) checks the terminal first)
await vscode.stop();                          // -> { state: 'stopped' }

// HTTP, shaped like http.request. `path` is the full browser path (/vscode/<engine id>/..., query included, the launch ticket already taken out),
// `headers` the browser request's headers (filtered by the manager), `host` the public host. onResponse gets an http.IncomingMessage whose
// `headers` and `rawHeaders` are already filtered as in Contract B. Throws VSCODE_NOT_RUNNING (statusCode 503) or VSCODE_PATH_INVALID (404).
const upstream = vscode.request({ method, path, headers, host }, response => { /* status, headers, pipe the body */ });
browserRequest.pipe(upstream);

// WebSocket, as raw bytes: the `req`, `socket`, `head` of the server's 'upgrade' event, after the page server's own cookie and origin check.
// It answers 503 / 404 / 502 on the socket itself.
vscode.upgrade(req, socket, head, { path, host });

// Or a ws client (for a transport that relays messages): headers of the browser's upgrade, sec-websocket-protocol is kept. Throws like request().
const ws = vscode.openWebSocket({ path, headers, host });

vscode.status();          // { state, error?, detail?, base_path, engine_id }, synchronous, never the token
await vscode.check();     // the status a page reads before it starts (see GET of Contract A)
vscode.basePath();        // '/vscode/<engine id>'
vscode.onStop(callback);  // runs when VS Code stops for any reason; returns the function that removes it
vscode.touch();           // counts as activity for the idle timer
vscode.socketTarget();    // { socketPath } or { host, port } while running, for diagnostics; never the token
vscode.settings(); await vscode.setSettings({ enabled, idle_minutes });
```

The connection token never leaves the manager: no function returns it, and `request` / `upgrade` / `openWebSocket` add it themselves.

## Security notes

- **Same origin.** VS Code runs its own scripts, webviews and extensions on the T-Agent page origin, under `/vscode/<engine id>/`. Anything that runs
  in VS Code's pages can call the page's `/api` with the person's session (the path-scoped cookie limits only what the browser sends to
  `/vscode/...`, not what a script on the origin can request). This is the price of one origin; the planned "VS Code address" setting can move
  `open_url` to an origin of its own. The engine strips `service-worker-allowed`, so VS Code's service worker cannot claim the page's scope.
- **The token never leaves the engine**: not in a status, an error, a log or a URL. It is in a 0600 file for the CLI, in the `vscode-tkn` cookie of
  the requests the engine makes, and taken out of `Location`, `Set-Cookie` and the kept output.
- **Ticket and cookie** (Contract C, page server): a single-use 30-second launch ticket in `open_url`, exchanged for an httpOnly `ta_vscode` cookie
  scoped to `/vscode/<engine id>/`, bound to the issuing session; it grants nothing under `/api`.
- **License**: accepted once per engine by the person, through `accept-license`, never implied.
- **Scope**: every route needs a token with `terminal:execute` (today every token has every scope); VS Code gives a full terminal and file access as
  the terminal user, the same as a terminal of T-Agent.

## Known limits

- The first start downloads the VS Code Server (about 60 to 100 MB) from Microsoft and needs internet on the engine; until it is there the state is
  `starting` (a failed download ends in `VSCODE_DOWNLOAD_FAILED`). Later starts use the copy kept under `<dataHome>/vscode`.
- Full function (service workers, webviews, the clipboard) needs a secure context: HTTPS, or `localhost`. Over plain HTTP from another machine VS Code
  loads but some parts do not work.
- Over a service link tunnel a WebSocket message is at most 32 MiB (close code 1009) and the streams are shared with terminals.
- VS Code opens any folder of the engine by path, whatever the task visibility of a linked service says (see Decisions).
- A T-Agent killed with SIGKILL leaves VS Code running until the next start of VS Code, which ends it (the pid file).
- Nothing of this was tried with a real VS Code CLI in the tests: they use the fake CLI. The flags follow the CLI's `serve-web --help`.
