# 交接说明（2026-10 · 截至 v2.29.0，提交 ab93e17）

给接手的 Claude / 开发者：先读 `AGENTS.md`（开发与发布规则）和本文件，再动手。

## 当前状态

- 分支 `main`，最新发布 **v2.29.0**，已推送到 `origin/main`，工作区干净。
- 用户通过客户端检测 `main` 上的 `VERSION.json` 更新，代码改动完成并验证后按 `AGENTS.md` 升版本、提交、推送（用户已授权自动发布）。
- 这台服务器性能很差：**不要跑全量 `npm test`、不要装依赖、不要起浏览器**。需要验证时一次只跑一个测试文件，例如 `nice -n 19 node --max-old-space-size=256 --test test/<文件>.test.js`。

## 这一轮完成的工作（按时间）

| 版本 | 内容 |
|---|---|
| 2.26.x | 终端运行状态：左侧任务项和终端标签用外圈跑马灯（执行中）、绿色呼吸灯（完成待确认）显示，状态由服务端判定（`lib/terminal-activity.js`），前端轮询 `GET /api/tasks/terminal-activity`，打开终端时 `POST /api/tasks/:id/terminal/ack` 确认 |
| 2.27.0 | Claude Code / Codex 的 hook 上报：PTY 注入 `TA_HOOK_URL` / `TA_HOOK_TOKEN`，接口 `POST /hooks/terminal-activity`；hook 配置在 `rules/claude/settings.json`、`rules/codex/hooks.json`，由 `scripts/agent-sync.py` 合并到本机（`ta` 启动时触发） |
| 2.28.0→2.28.2 | 先误删后恢复：**用户要去掉的只是独立运行的 Engine 服务**（`apps/engine`、`compose.engine.yml`、`install.sh --mode engine`、Docker engine 镜像目标），**Client 内置 Engine、Client A 连接 Client B 的功能必须保留** |
| 2.28.1 | 页面头部去掉“Client 切换”按钮（`/clients` 页面与路由保留） |
| 2.28.3 | 远程 Engine 连接失败时只显示“检查服务状态”提示，不显示任务/终端等操作页面 |
| 2.29.0 | 远程 Engine 与本地功能一致：前端改成“数据源”模式，见下文 |

## 架构要点（改代码前必读）

**前端数据源模式**（v2.29.0 的核心）
- `public/js/tasks.js`：本地和每个远程 Engine 是一个“数据源”（`sources` Map），共用同一套界面。当前数据源的任务在 `tasks` / `selectedId`，切换用 `activateSource(key)`。
- 请求基础路径：本地 `/api/tasks`，远程 `/api/remote-servers/:id/tasks`，用 `taskUrl()` 拼；localStorage 键用 `storageId()`（本地沿用原键名，远程带 `remote:ID:` 前缀）；终端缓存键是 `[sourceKey, taskId, terminalId]`。
- 能力开关：`can('documents:write')` 等。本地 `caps === null` 表示全部可用；远程由 `Engines` 读取 `GET /api/remote-servers/:id/info` 后调用 `Tasks.setSourceAccess()` 设置，`readonly` 角色会去掉写类能力。远程数据源在拿到能力前是空集合（按只读处理）。
- `public/js/engines.js`（全局 `Engines`，取代已删除的 `remote-tasks.js`）：只管连接列表、引擎标签、配对、更新、编辑/移除连接、“无法连接”提示。
- 终端运行状态按数据源分别轮询：`public/js/terminal-activity.js`（当前数据源 1.5 秒，其他 10 秒）。

**后端**
- Client 内置 Engine：`routes/engine-v1.js`（`/v1`），服务在 `services/engine-tasks.js`。Client 代理在 `routes/remote-servers.js`，流式转发在 `services/remote-stream.js`。
- 本地 `routes/tasks.js` 与 Engine 的同类接口通过共用模块保持一致：`lib/file-watch-sse.js`、`services/task-assets.js`。
- 新增 Engine 能力（写在 `/v1/info` 的 `capabilities`，`api_version` 仍为 1）：`tasks:reorder`、`documents:create`、`documents:watch`、`files:assets`、`paths:validate`、`terminal:activity`。旧版 Engine 缺这些能力时前端自动降级。
- `test/task-parity.test.js`：同一套断言分别对本地路由、Engine、Client 代理运行，新增接口时请同步补。

## 还没验证 / 需要接手验证的事

1. **没有在真实浏览器里看过 v2.29.0 的前端效果**。重构改动面大（`tasks.js` 约 2100 行），只靠单元测试夹具验证。请在能开浏览器的电脑上手动过一遍：
   - 本地任务：切换任务、编辑文档、待办增删改、拖拽排序、新建/编辑/删除、终端、文件浏览器、分组新建/重命名/删除。
   - 切到远程 Engine：同上，另确认 Finder / VS Code / 分享按钮已隐藏、引擎标签的跑马灯/呼吸灯、`readonly` Token 的只读表现、离线时的提示页。
2. **全量 `npm test` 没跑过**（服务器扛不住）。在性能正常的机器上跑一次。已知基线：约 13 个 `scripts/test-*-browser.cjs` 需要浏览器和系统共享库（`libnss3` 等），本服务器上跑不起来，与代码无关。浏览器脚本里涉及远程引用的 3 个已更新但从未运行过：`test-file-panel-navigation-browser.cjs`、`test-terminal-keys-browser.cjs`、`test-desktop-layout-browser.cjs`。
3. **Docker 镜像构建结果没核实**：推送 `main` 会触发 `.github/workflows/docker-client.yml`（只构建 client 镜像），每次都没看构建是否成功。
4. **Codex hook 在真实会话里没触发过**：`rules/codex/hooks.json` 里的事件名（`SessionEnd`、`PermissionRequest` 等）按官方文档写，`codex exec` 加载未报错，但需要用户在 Codex 里 `/hooks` 信任后才会真正执行，未验证。

## 已知限制 / 遗留事项

- 远程终端的运行状态依赖 Engine 机器上也运行过一次 `ta`（hook 配置同步）；通过 ssh 进入远程机器再运行 Agent 时环境变量带不过去，只能按输出节奏判断。
- Agent 状态判定：有 hook 时以 hook 为准；Esc/Ctrl+C 中断不触发 Stop hook，靠“执行中且静默 20 秒”兜底；没有 hook 的 Agent 按输出判断（1.5 秒内连续多次输出为执行中，静默约 3 秒为等待）。
- 旧数据库里的 `remote_servers`、`engine_*`、`remote_access_tokens` 表保留，**不要删**（包含用户已保存的远程连接）。新建数据库仍会创建这些表。
- 这台服务器上还有一个旧的独立 Engine 在 Docker 里运行（`node apps/engine/server.js`，已运行很久）。`apps/engine` 代码已从仓库删除，**以后重建那个镜像会失败**；是否停掉由用户决定，不要擅自处理。
- `VERSION.json` 里的 `min/max_remote_api_version`、`api_version`、`schema_version` 字段**不要随意修改**，旧客户端靠它识别更新。
- 本地 `GET /api/tasks/:id/file` 没有加 `Content-Security-Policy: sandbox`（Engine 和代理的远程文件有）。本地行为保持原样，如需统一再单独决定。

## 工作方式提醒（来自这次的教训）

- **大范围删除前先把要删的清单列给用户确认**。v2.28.0 因为把“独立 Engine”理解成“整个 Engine 功能”而误删，花了一个版本恢复。
- 清理测试进程**不要用 `pkill -f` 模糊匹配**：它会匹配到自己的 shell，也可能误杀线上进程。按 PID 精确结束。线上 Client 在 `/www/wwwroot/t-agent/`（systemd `t-agent.service`），这里的目录是开发副本。
- 自动模式分类器会拒绝“修改 Agent 自身配置”的操作（例如写 `~/.claude`、改 `agent-sync.py` 的同步范围）。遇到拒绝要停下来向用户说明，不要换种方式绕过；用户明确授权后再做。
- 推送前检查版本字段一致、`git diff --check`、只暂存明确的文件列表，推送后核对 `HEAD` 与 `origin/main` 一致。
