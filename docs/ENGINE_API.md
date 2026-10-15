# Engine API v1

Except for the health check and the pairing endpoint, requests use:

```http
Authorization: Bearer tae_xxx
```

## System and pairing

- `GET /v1/health`
- `POST /v1/pair`
- `GET /v1/info`
- `GET /v1/capabilities`

## Tasks and documents

- `GET /v1/task-groups`
- `POST /v1/task-groups`
- `PUT /v1/task-groups/:id`
- `DELETE /v1/task-groups/:id`
- `GET /v1/tasks`
- `POST /v1/tasks`
- `PATCH /v1/tasks/:id`
- `DELETE /v1/tasks/:id`
- `GET /v1/tasks/:id/documents/:kind`
- `PUT /v1/tasks/:id/documents/:kind`
- `GET /v1/tasks/:id/todos`
- `POST /v1/tasks/:id/todos`
- `PATCH /v1/tasks/:id/todos/:todoId`
- `DELETE /v1/tasks/:id/todos/:todoId`

`kind` supports `technical`, `readme` and `agent`.

A task's `status` stores the `key` returned by the groups. `doing`, `todo` and `done` are system groups that cannot be renamed or deleted; other groups can be renamed and can only be deleted when they have no tasks.

## Terminals

- `GET /v1/tasks/:id/terminals`: list terminals (including `default`, kept for compatibility with old versions).
- `POST /v1/tasks/:id/terminals`: create a terminal record and return `{terminal_id, title}`; the shell starts on the first WebSocket connection.
- `POST /v1/terminal-sessions`
- `WS /v1/terminal-sessions/:sessionId/stream?ticket=...`
- `POST /v1/terminal-sessions/:taskId/control`

Listing and creating need the `terminal:execute` scope. `/v1/info` returns the `terminal:multiple` capability flag.

The body of a ticket request is `{ "task_id": 1, "terminal_id": "terminal ID" }`. The ticket is bound to both the task and the terminal, so the WebSocket URL cannot change the target. Omitting `terminal_id` uses `default`, which stays compatible with the original endpoint and history.

The terminal control body also accepts an optional `terminal_id` and only controls that shell. Each terminal's history is persisted separately; switching or disconnecting does not terminate the shell.

The terminal control body supports:

```json
{ "action": "close" }
```

or:

```json
{ "action": "restart-workdir" }
```

`close` terminates the current PTY and keeps the history; `restart-workdir` terminates the PTY and clears the history, and the next connection creates a new shell from the task's `work_dir`. Both operations need the `terminal:execute` scope.

## Token management

Every Token has admin rights; listing, creating and revoking Tokens needs the `engine:admin` scope:


- `GET /v1/tokens`
- `POST /v1/tokens`
- `DELETE /v1/tokens/:id`

## Engine updates

Checking and applying updates needs the `engine:admin` scope:

- `GET /v1/update/status`
- `POST /v1/update/check`
- `POST /v1/update/apply`, the body must be `{ "confirm": true }`

The apply endpoint returns `202` once it accepts the request. The Client should poll the status endpoint; after the Engine enters the `restarting` stage it exits and relies on systemd, launchd or another process manager to restart it automatically.

## PM2 management

Manages PM2 processes on the machine this Engine runs on; capability name `pm2:manage`, requires the `engine:admin` scope. Errors only return an error code (for example `PM2_NOT_INSTALLED`, `PM2_NOT_RUNNING`, `PM2_BAD_ACTION`, `PM2_COMMAND_FAILED`):

- `GET /v1/pm2/status`: returns `installed`, `running` and the allowlisted process fields, without environment variables or command-line arguments.
- `GET /v1/pm2/:id/logs?stream=out|err&lines=N`: read the tail of a log, at most 256 KiB / 1000 lines.
- `POST /v1/pm2/:id/:action`: `start`, `stop`, `restart`, `reload`.

The Client's proxy is `/api/remote-servers/:id/pm2/...`; when an old Engine has no such routes the proxy returns `501 PM2_UNSUPPORTED`.

## App list (service registry)

Registers the services on the machine this Engine runs on: name, port, IP, domain, access path, description, and the linked PM2 process. Capability name `apps:manage`, requires the `engine:admin` scope (every Token has it). Errors are always returned as `{ "error": "<error code>", "message": "<English description>" }`, with codes such as `APP_NAME_TAKEN` (409), `APP_NOT_FOUND` (404), `APP_URL_INVALID`, `APP_PORT_INVALID`, `APP_DOMAIN_INVALID` and `APP_FIELD_REQUIRED` (400).

- `GET /v1/apps`: returns `{ pm2: { installed, running, error }, host_ips, hidden_count, apps }`. **Every call automatically registers the PM2 processes that are not registered yet** (ones the user hid are not registered again). Each app contains its saved fields plus the run-time merged `pm2` (run status; `null` when not linked or the process does not exist), `pm2_state` (`unlinked`/`online`/`stopped`/`errored`/`missing`/`unavailable` and so on), `ports` (listening ports detected for the PM2 process and its children; `local_only` means it only listens on the loopback address), `effective_port` and `links` (`ip`, `domain`, `custom`, `primary`; `primary` is used when clicking through).
- `POST /v1/apps`: add manually, returns `201 { app }`.
- `PUT /v1/apps/:id`: partial update; fields that are not sent keep their value, and an empty string clears one.
- `DELETE /v1/apps/:id`: delete. An auto-registered service that is still in PM2 is only hidden and returns `{ deleted: false, hidden: true }`; everything else is really deleted and returns `{ deleted: true, hidden: false }`.
- `POST /v1/apps/restore-hidden`: restore all hidden apps, returns `{ restored }`.
- `POST /v1/apps/register`: **self-registration when a program starts**. Idempotent update by `pm2_name` (preferred when present) or `name` (case-insensitive): creating returns `201 { app, created: true }`, an existing one returns `200 { app, created: false }`; optional fields that are not sent keep their value, so a hand-entered domain is not cleared.

Accepted fields: `name` (required, ≤64), `port` (1-65535), `host` (IP), `domain` (a bare domain or an http(s) address), `scheme` (`http`/`https`), `path` (starts with `/`), `url` (a full http(s) address, preferred when clicking through), `description` (≤500), `pm2_name`. `url`/`domain` only accept http(s) without credentials, because they become clickable links in the UI.

```bash
curl -X POST http://127.0.0.1:3000/v1/apps/register \
  -H "Authorization: Bearer tae_xxx" -H "Content-Type: application/json" \
  -d '{"name":"my-service","port":8080,"domain":"my.example.com","description":"service description"}'
```

The Client's proxy is `/api/remote-servers/:id/apps/...` (it only proxies the list, add, update, delete and restore used by the UI); when an old Engine has no such routes the proxy returns `501 APPS_UNSUPPORTED`. The local UI uses `/api/apps/...` (login session + origin check; the routes match the ones above).

## File sync

Capability `file-sync:manage`; every `/v1/file-sync/*` endpoint needs an Engine owner Token. The browser's local endpoints are `/api/file-sync/*`, and for a remote engine the Client proxies to `/api/remote-servers/:id/file-sync/*`. File content is Base64-encoded, at most 1 MiB per file.

- `GET /v1/file-sync`: the node role, the master connection ID, each file's path / actual local path / default path / local path override / version / backup path, and the last check time and error; a file's `path_required` means a local path must be specified first.
- On a master, `GET /v1/file-sync` also returns `children` (`id`, `name`, `online`, `last_seen_at`, `last_sync_at`, `error`); a node is marked offline after 15 seconds without a heartbeat.
- `GET /v1/file-sync/servers`: the remote connections this node already has (only ID, name and address).
- `PUT /v1/file-sync/files`: the master sets the full list of file paths, with the parameters `{ "files": ["~/.claude/settings.json"] }`.
- `PUT /v1/file-sync/path`: a slave sets its local path mapping, with the parameters `{ "path": "/Users/name/.codex/config.toml", "local_path": "~/.codex/config.toml" }`; clearing `local_path` restores the default.
- `POST /v1/file-sync/pairing`: the master generates a one-time pairing code (`TA-XXXX-XXXX-XXXX`, valid for 10 minutes) and returns `{ code, expires_in_seconds }`.
- `POST /v1/file-sync/join`: join the master in one step with its address and pairing code, with the parameters `{ "url": "192.168.1.5:3000", "code": "TA-..." }`; it calls the master's `/v1/pair` to exchange for a token, saves the remote connection (reused for the same address) and then calls `connect` right away. Errors: `SYNC_PAIRING_CODE_INVALID`, `SYNC_MASTER_URL_INVALID`, `PAIRING_CODE_INVALID_OR_EXPIRED`, `SYNC_SELF_CONNECTION`.
- `POST /v1/file-sync/connect`: connect to an existing remote node and become a slave, with the parameters `{ "server_id": 1 }`; the first download overwrites according to the master's file list and saves a local backup before overwriting. When an absolute path of the master does not exist locally, it waits for a local path mapping.
- `POST /v1/file-sync/disconnect`: return to the default master role, clear the sync list and keep local files and backups.
- `POST /v1/file-sync/run`: run one round of scanning or syncing right away.
- `POST /v1/file-sync/resolve`: the slave explicitly picks the master's version, with the parameters `{ "path": "~/.claude/settings.json" }`; the local file is backed up first.
- `GET /v1/file-sync/manifest`: master only; returns the instance ID and a list of `{ path, revision, hash, content, size }`; a file that does not exist on the master has no content.
- `PUT /v1/file-sync/file`: master only; parameters `{ path, base_revision, generation, content }`; a generation or version mismatch returns `409 SYNC_CONFLICT`, and a path that is not configured returns `404 SYNC_PATH_NOT_CONFIGURED`.
- `POST /v1/file-sync/heartbeat`: a slave registers or refreshes its heartbeat, with the parameters `{ instance_id, name, generation, last_sync_at, error }`; the master updates the record by the stable instance ID.
- `DELETE /v1/file-sync/heartbeat`: a slave deregisters when it disconnects normally, with the parameters `{ instance_id, generation }`. When it disconnects while offline, the master keeps the history record and shows it as offline.
