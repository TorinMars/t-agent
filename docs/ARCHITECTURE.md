# T-Agent component architecture

T-Agent consists of two components with clear boundaries: the Client and the Engine.

## Client

The Client is responsible for the user interface, Engine registration, encrypted storage of credentials and aggregation of data from several Engines. The Client package includes a local Engine by default, so it does not need to be installed separately.

The Client connects to remote Engines through the standard `/v1` API. A remote Token is encrypted with `SESSION_SECRET` before it is written to the Client database and is never returned to the browser.

## Multi-Client page (removed)

The multi-Client workspace `/clients` was removed in v2.34.0; when logged out only the hidden login entrance is visible.

The target Client configures the workspace origins that may embed it with `CLIENT_FRAME_ORIGINS`; the default CSP frame-ancestors allows the same origin only. The login and binding pages can never be embedded. Once embedding is configured, the HTTPS session cookie uses SameSite=None + Secure and HTTP stays Strict; the browser API and terminal Origin checks are not relaxed. Cross-site use depends on the browser allowing third-party cookies. Clients on the same host with different ports can isolate their sessions with different `CLIENT_SESSION_COOKIE_NAME` values; the default name is still connect.sid.

## Engine

The Engine is the authoritative source of tasks, to-dos, Markdown documents, working directories and terminal execution. The Engine endpoints (`/v1`) need no username or password and only use revocable Bearer Tokens; every Client includes and exposes the same Engine endpoints, and a separately running Engine service is no longer provided. The Client keeps single-user data ownership, and the web UI at `/web` and the mobile H5 at `/h5` are authenticated by the same TOTP authenticator and listen on `127.0.0.1` only by default. Phone access can be enabled explicitly with `HOST=0.0.0.0` or through an HTTPS reverse proxy.

Both a fresh Client and an upgrade from an old version start with no authenticator bound. When logged out (including not yet bound), every address, browser API and terminal WebSocket returns the same 404 as a non-existent address (`lib/login-gate.js`), with no redirect and no 401/403, except the hidden login entrance, the Bearer-token machine endpoints (`/v1`, `/api/remote/v1`), `/health` and public share pages; after a session expires the frontend confirms with the login entrance's `/status` before redirecting. The first binding needs no initial password or setup code and is not restricted to local or remote access: both the web login entrance (`CLIENT_LOGIN_PATH`, default `/torin/hide/login`) and the terminal command `node scripts/client-auth-setup.js` can complete it; they share the same binding API and are protected by authentication rate limiting and a second code confirmation. The binding is only persisted after the QR code is scanned or the key is added manually and the 6-digit code is verified. A logged-in user can replace the authenticator remotely after a recent verification. The binding secret and the pending secret are encrypted with an AES-256-GCM key derived from `SESSION_SECRET`; recovery codes are stored only as SHA-256 hashes. Sessions are SQLite sessions with a rolling 30-day lifetime and default to an HttpOnly/SameSite=Strict cookie; Secure may be left off only for direct local HTTP, while remote production and HTTPS always set Secure, so binding on the local machine also works in production mode. Old no-login sessions grant no permission. Codes and recovery codes are replay-protected, and the authentication rate limit is persisted in SQLite.

Replacing the authenticator needs a verification within the last five minutes; once done, the old sessions and old recovery codes are revoked and browser terminal connections are closed. Logging out also closes the terminal connections of the current session immediately, without terminating the PTY or the programs running in it. `/v1` and the old `/api/remote/v1` keep the Engine's Bearer Token boundary, and explicitly created read-only `/share/:token` links are still authorized by the share Token.

Each Engine keeps a stable `engine_id` in SQLite. The Client uses `(engine_id, task_id)` to tell resources on different nodes apart.

## Authorization

- Pairing code: `TA-XXXX-XXXX-XXXX`, expires after 10 minutes by default and can be used only once.
- Access Token: `tae_...`, the plaintext is shown only when it is created, and the Engine stores only its SHA-256 hash.
- Terminal ticket: `tat_...`, expires after 30 seconds and can be used only once.

Every Engine connection has admin rights (`owner`, scope `*`); view / operate / manage are no longer distinguished. Role parameters in requests are ignored, and restricted Tokens issued earlier are also treated as admin.

The Engine's update-check and apply-update endpoints require the `engine:admin` scope, which every Token has. The Client browser only calls the local proxy endpoints; the Client server decrypts the saved Token and then calls the Engine, so the Token never reaches the browser. After an update the Engine exits with a non-zero status and is started again by systemd, launchd or an equivalent process manager.

This project no longer provides Docker deployment or image builds. If a connected remote Engine is an old version deployed with Docker, it still reports `install_type: docker`: the Client only shows the version and does not trigger an update, and the image must be updated on that Engine's host.

## File boundary

`work_dir` and `md_path` in the task API accept any absolute path on the Engine server, with no directory allowlist. Each task can have its own working directory; when `md_path` is not specified, the design document defaults to `DESIGN.md` in the working directory. The actual read and write scope is decided by the permissions of the operating-system account that runs the Engine process, so a Token with write permission should only be given to trusted Clients, and the Engine should run under a dedicated account with limited permissions.

## Terminal connection

The Client first requests `POST /v1/terminal-sessions` with an Access Token, and the Engine returns a one-time ticket and a WebSocket path. The ticket is invalidated as soon as the WebSocket is established.

When the browser reopens a terminal it only rebuilds the WebSocket and the PTY in the Engine keeps running. For close or reopen-from-working-directory, the Client uses an authenticated REST control endpoint to terminate the PTY; the latter also clears the old history, so the next connection creates a new shell strictly from the task's `work_dir`. Control commands do not reuse the terminal input channel, so an old Engine cannot mistake them for shell input.
