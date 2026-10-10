# Engine API v1

除健康检查和配对接口外，请求使用：

```http
Authorization: Bearer tae_xxx
```

## 系统与配对

- `GET /v1/health`
- `POST /v1/pair`
- `GET /v1/info`
- `GET /v1/capabilities`

## 任务和文档

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

`kind` 支持 `technical`、`readme` 和 `agent`。

任务的 `status` 保存分组返回的 `key`。`doing`、`todo`、`done` 是系统分组，不能重命名或删除；其他分组可以重命名，且只能在没有任务时删除。

## 终端

- `GET /v1/tasks/:id/terminals`：列出终端（包含兼容旧版本的 `default`）。
- `POST /v1/tasks/:id/terminals`：创建终端记录，返回 `{terminal_id, title}`；首次 WebSocket 连接时启动 Shell。
- `POST /v1/terminal-sessions`
- `WS /v1/terminal-sessions/:sessionId/stream?ticket=...`
- `POST /v1/terminal-sessions/:taskId/control`

列表和创建需要 `terminal:execute` scope。`/v1/info` 返回 `terminal:multiple` 能力标记。

创建 ticket 的请求体为 `{ "task_id": 1, "terminal_id": "终端 ID" }`。ticket 同时绑定任务和终端，WebSocket URL 无法更改目标。省略 `terminal_id` 使用 `default`，兼容原有接口和历史。

终端控制请求体也接受可选的 `terminal_id`，只控制对应 Shell。终端的历史分别持久化；切换、断线不会终止 Shell。

终端控制请求体支持：

```json
{ "action": "close" }
```

或：

```json
{ "action": "restart-workdir" }
```

`close` 终止当前 PTY 并保留历史；`restart-workdir` 终止 PTY、清空历史，下一次连接将从任务的 `work_dir` 创建新 Shell。两个操作都需要 `terminal:execute` scope。

## Token 管理

所有 Token 都是管理权限；Token 列表、创建和撤销需要 `engine:admin` scope：


- `GET /v1/tokens`
- `POST /v1/tokens`
- `DELETE /v1/tokens/:id`

## Engine 更新

检查和应用更新需要 `engine:admin` scope：

- `GET /v1/update/status`
- `POST /v1/update/check`
- `POST /v1/update/apply`，请求体必须为 `{ "confirm": true }`

应用接口接受请求后返回 `202`。Client 应轮询状态接口；Engine 进入 `restarting` 阶段后会退出，并依赖 systemd、launchd 或其他进程管理器自动重启。

## PM2 管理

管理这台 Engine 所在机器上的 PM2 进程，能力名 `pm2:manage`，需要 `engine:admin` scope。错误只返回错误码（例如 `PM2_NOT_INSTALLED`、`PM2_NOT_RUNNING`、`PM2_BAD_ACTION`、`PM2_COMMAND_FAILED`）：

- `GET /v1/pm2/status`：返回 `installed`、`running` 和进程白名单字段，不含环境变量与命令行参数。
- `GET /v1/pm2/:id/logs?stream=out|err&lines=N`：读取日志尾部，最多 256 KiB / 1000 行。
- `POST /v1/pm2/:id/:action`：`start`、`stop`、`restart`、`reload`。

Client 的代理为 `/api/remote-servers/:id/pm2/...`；旧版 Engine 没有这些路由时代理返回 `501 PM2_UNSUPPORTED`。

## 应用列表（服务注册表）

登记这台 Engine 所在机器上的服务：名称、端口、IP、域名、访问路径、说明，以及关联的 PM2 进程。能力名 `apps:manage`，需要 `engine:admin` scope（所有 Token 均满足）。错误统一返回 `{ "error": "<错误码>", "message": "<中文说明>" }`，错误码如 `APP_NAME_TAKEN`（409）、`APP_NOT_FOUND`（404）、`APP_URL_INVALID`、`APP_PORT_INVALID`、`APP_DOMAIN_INVALID`、`APP_FIELD_REQUIRED`（400）。

- `GET /v1/apps`：返回 `{ pm2: { installed, running, error }, host_ips, hidden_count, apps }`。**每次调用都会把 PM2 里还没登记的进程自动登记**（已被用户隐藏的不会再登记）。每个应用包含已保存的字段，以及运行时合并出的 `pm2`（运行状态，无关联或进程不存在时为 `null`）、`pm2_state`（`unlinked`/`online`/`stopped`/`errored`/`missing`/`unavailable` 等）、`ports`（对 PM2 进程及其子进程检测到的监听端口，`local_only` 表示只监听回环地址）、`effective_port` 和 `links`（`ip`、`domain`、`custom`、`primary`，点击跳转用 `primary`）。
- `POST /v1/apps`：手动新增，返回 `201 { app }`。
- `PUT /v1/apps/:id`：局部修改，没传的字段保持原值，传空字符串清空。
- `DELETE /v1/apps/:id`：删除。自动登记且仍在 PM2 里的服务只是隐藏，返回 `{ deleted: false, hidden: true }`；其余真正删除 `{ deleted: true, hidden: false }`。
- `POST /v1/apps/restore-hidden`：恢复全部已隐藏的应用，返回 `{ restored }`。
- `POST /v1/apps/register`：**程序启动时自注册**。按 `pm2_name`（有则优先）或 `name`（不区分大小写）幂等更新：新建返回 `201 { app, created: true }`，已存在返回 `200 { app, created: false }`，没传的可选字段保持原值，不会清掉手填的域名。

可传字段：`name`（必填，≤64）、`port`（1-65535）、`host`（IP）、`domain`（裸域名或 http(s) 地址）、`scheme`（`http`/`https`）、`path`（以 `/` 开头）、`url`（完整 http(s) 地址，优先用于点击跳转）、`description`（≤500）、`pm2_name`。`url`/`domain` 只接受不含账号密码的 http(s)，因为它们会在界面里变成可点击的链接。

```bash
curl -X POST http://127.0.0.1:3000/v1/apps/register \
  -H "Authorization: Bearer tae_xxx" -H "Content-Type: application/json" \
  -d '{"name":"my-service","port":8080,"domain":"my.example.com","description":"服务说明"}'
```

Client 的代理为 `/api/remote-servers/:id/apps/...`（只代理界面用到的列表、新增、修改、删除、恢复）；旧版 Engine 没有这些路由时代理返回 `501 APPS_UNSUPPORTED`。本机界面使用 `/api/apps/...`（登录会话 + 来源校验，路由与上面一致）。

## 文件同步

能力 `file-sync:manage`，所有 `/v1/file-sync/*` 接口需要 Engine owner Token。浏览器本机接口为 `/api/file-sync/*`，远程引擎由 Client 代理到 `/api/remote-servers/:id/file-sync/*`。文件内容用 Base64 编码，单文件最多 1 MiB。

- `GET /v1/file-sync`：节点角色、主服务器连接 ID、文件路径/本机实际路径/版本/备份路径、最近同步时间与错误。
- `GET /v1/file-sync/servers`：本节点已有的远程连接（仅 ID、名称和地址）。
- `PUT /v1/file-sync/files`：主服务器设置完整文件路径清单，参数 `{ "files": ["~/.claude/settings.json"] }`。
- `POST /v1/file-sync/connect`：连接已有远程节点并改为附属服务器，参数 `{ "server_id": 1 }`；首次下载按主服务器文件清单覆盖，覆盖前保存本地备份。
- `POST /v1/file-sync/disconnect`：恢复默认主服务器角色，清空同步清单，保留本地文件和备份。
- `POST /v1/file-sync/run`：立即执行一轮扫描或同步。
- `POST /v1/file-sync/resolve`：附属服务器明确选用主服务器的版本，参数 `{ "path": "~/.claude/settings.json" }`，先备份本地文件。
- `GET /v1/file-sync/manifest`：仅主服务器可用，返回实例 ID 与 `{ path, revision, hash, content, size }` 文件列表；主服务器不存在的文件没有内容。
- `PUT /v1/file-sync/file`：仅主服务器可用，参数 `{ path, base_revision, generation, content }`；代次或版本不符返回 `409 SYNC_CONFLICT`，未配置路径返回 `404 SYNC_PATH_NOT_CONFIGURED`。
