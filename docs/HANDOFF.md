# 交接说明（2026-10 · 截至 v2.33.0）

给接手的 Claude / 开发者：先读 `AGENTS.md`（开发与发布规则）和本文件，再动手。

## 当前状态

- 分支 `main`，最新发布 **v2.33.0**，已推送到 `origin/main`，工作区干净。
- 用户通过客户端检测 `main` 上的 `VERSION.json` 更新，代码改动完成并验证后按 `AGENTS.md` 升版本、提交、推送（用户已授权自动发布）。
- 开发机已换成性能正常的 macOS，可以跑全量测试和浏览器脚本（先 `npm ci`、`npx playwright install chromium`）。`npm test` 并发时 pty 用例偶发 `posix_spawnp failed`，单独跑或 `node --test test/` 均通过。

## 这一轮完成的工作（按时间）

| 版本 | 内容 |
|---|---|
| 2.26.x | 终端运行状态：左侧任务项和终端标签用外圈跑马灯（执行中）、绿色呼吸灯（完成待确认）显示，状态由服务端判定（`lib/terminal-activity.js`），前端轮询 `GET /api/tasks/terminal-activity`，打开终端时 `POST /api/tasks/:id/terminal/ack` 确认 |
| 2.27.0 | Claude Code / Codex 的 hook 上报：PTY 注入 `TA_HOOK_URL` / `TA_HOOK_TOKEN`，接口 `POST /hooks/terminal-activity`；hook 配置在 `rules/claude/settings.json`、`rules/codex/hooks.json`，由 `scripts/agent-sync.py` 合并到本机（`ta` 启动时触发） |
| 2.28.0→2.28.2 | 先误删后恢复：**用户要去掉的只是独立运行的 Engine 服务**（`apps/engine`、`compose.engine.yml`、`install.sh --mode engine`、Docker engine 镜像目标），**Client 内置 Engine、Client A 连接 Client B 的功能必须保留** |
| 2.28.1 | 页面头部去掉“Client 切换”按钮（`/clients` 页面与路由保留） |
| 2.28.3 | 远程 Engine 连接失败时只显示“检查服务状态”提示，不显示任务/终端等操作页面 |
| 2.29.0 | 远程 Engine 与本地功能一致：前端改成“数据源”模式，见下文 |
| 2.29.1 | **移除全部 Docker 部署与镜像构建**：删除 `Dockerfile`、`compose.client.yml`、`docker-client.sh`、`docker/`、`.github/workflows/docker-client.yml`、相关脚本、测试和 `docs/DOCKER_CLIENT.md`；`update-manager` 不再有 `docker` 安装类型。`public/js/engines.js` 仍保留对**远程** Engine 上报 `install_type: docker` 的展示处理（旧 Docker Engine 仍可能存在） |
| 2.29.2 | 终端状态跑马灯改为沿边框路径（`offset-path`）按距离匀速移动，取代按角度旋转的 `conic-gradient`（后者在矩形四边的线速度忽快忽慢） |
| 2.29.3 | macOS 没有 `/proc`，前台进程只能拿到 `node`，没有 hook 时的输出兜底判定失效、Codex/Claude 跑马灯一直转；改为用 `ps -t <tty>` 读取前台进程组命令行（`lib/terminal-activity.js`） |
| 2.29.4 | 修复终端 tab 在“正在查看的终端完成”时整组翻倍：`TerminalActivity.acknowledge` 同步通知监听器并重入 `TerminalTabs.render()`，改为先画完再确认（`test/terminal-tabs.test.js`）；跑马灯亮点缩短变细、被元素裁剪并加淡色轨道 |
| 2.30.0 | ① 布局对调：引擎切换栏在顶部（`#engine-tabs`），主导航（Tasks / 实用工具，`.main-nav`）在左侧，工具面板放进 `.layout`，工具页左侧导航保持可见；移除引擎栏收起功能。② 实用工具跟随引擎：`public/js/tools.js` 按当前引擎改用 `/api/pm2` 或 `/api/remote-servers/:id/pm2`；Engine 新增 `/v1/pm2/*` 与能力 `pm2:manage`，Client 代理旧版 Engine 返回 `501 PM2_UNSUPPORTED`。③ **所有 Engine 连接统一为管理权限**：`services/engine-auth.js` 忽略请求角色、鉴权一律 owner（含此前签发的只读/操作令牌，库中记录未改），配对 UI 与 CLI 不再选角色 |
| 2.30.1 | ① 第三方前端库自托管：marked 15.0.12、mermaid 12.1.0、xterm 5.5.0、addon-fit 0.10.0 固定版本放在 `public/vendor`（`scripts/vendor-libs.json` 记录地址与 SHA-256，`scripts/fetch-vendor.js` 下载校验），主页面与分享页不再访问 CDN；mermaid 懒加载；`/vendor` 单独启用 gzip（新增依赖 `compression`）并对带版本号的文件长期缓存。注意：原来不带版本的 marked 地址实际返回的是 15.0.12 而不是最新的 18.x，这里固定的就是它。② macOS 前台进程识别改为全局共享的异步 `ps`（原先每个终端每 0.5 秒同步执行一次）。③ 新增 `.github/workflows/test.yml`，推送时只跑 `node --test test/`（Linux 上首次运行结果尚未确认） |
| 2.30.2 | 修复右键菜单（`#context-menu`）被顶部栏盖住：引擎标签移到顶部栏后，菜单在顶部栏范围内弹出，而“已安装应用”（window-controls-overlay）模式下顶部栏是 `z-index: 1000` 的系统拖动区域；菜单提到 `z-index: 1100` 并声明 `-webkit-app-region: no-drag`（`scripts/test-context-menu-browser.cjs`）。其它弹层（普通 modal 等）在该模式下仍低于顶部栏，属原有行为。另：修复 CI 的 `npm ci` 失败——本机 npm 配的是公司内部镜像，v2.30.1 新增 `compression` 时把 `npm.corp.kuaishou.com` 地址写进了 `package-lock.json`，已改回 registry.npmjs.org，并新增 `test/lockfile.test.js` 防止再次混入；**以后在本机装依赖请加 `--registry=https://registry.npmjs.org`** |
| 2.30.3 | 修复“引擎更新停在安装依赖、界面不再变动”：更新里的 `npm ci` 原先用 npm 默认的重试/超时（对一个不可达地址实测 70.5 秒才报错，v2.30.1 的锁文件里有 3 个这样的内网地址），且界面只显示固定文字。现在 `lib/update-command.js` 的 `runWithProgress` 每 2 秒把“已用时间 + npm 最近一行输出”写进更新状态（本机与远程 Engine 界面都直接显示 `status.message`），30 秒无输出提示可能网络不通；`services/update-manager.js` 的 `npmEnv()` 设置 `fetch-retries=1`、`fetch-timeout=60s`、`loglevel=http`（同样的不可达地址 2.4 秒报错，已设置的环境值不覆盖） |
| 2.30.4 | 终端从历史记录恢复时重置残留的鼠标模式（提交 `5ad966d`） |
| 2.30.5 | 选中任务时始终显示内容标签页（提交 `73672c4`） |
| 2.30.6 | **修复“一键安装的服务无法在线更新，提示有未提交修改”**：更新原先用 `git status --porcelain` 判定，未被跟踪也未被忽略的杂文件（`.DS_Store`、`nohup.out`、编辑器或 Agent 创建的 `.claude/` 等）也会让更新被拦住，而且提示不说是哪些文件。现在 `lib/git-update-workspace.js` 的 `trackedChanges` 只统计**被跟踪文件**的修改（`--untracked-files=no`），未跟踪文件放行，由 `git merge --ff-only --no-overwrite-ignore` 在同名冲突时自行拒绝（`test/git-update-workspace.test.js` 用真实 git 验证了文件不会被覆盖）；被跟踪文件有修改时 `error_details` 列出文件名（最多 8 个），界面原本就会显示。强制更新行为不变（仍备份未跟踪文件）。**没能复现用户服务器上具体是哪些文件触发的**——全新克隆后 `npm ci`、启动服务、`build:monaco` 工作区都是干净的；如果升级后仍被拦，请让用户在安装目录运行 `git status --porcelain` 并把输出发来 |
| 2.31.0 | **应用列表**（主导航与“实用工具”并列，跟随当前引擎）：新增 `apps` 表和 `/api/apps`、`/v1/apps`（能力 `apps:manage`）、远程代理 `/api/remote-servers/:id/apps`。PM2 进程自动登记（用户删除仍在运行的会“隐藏”而不是删除，避免被同步回来），也支持手动新增和程序 `POST /v1/apps/register` 自注册（按名称/`pm2_name` 幂等）。端口用 `lsof`/`ss` 对 PM2 进程树检测并区分仅本机监听；`url`/`domain` 只接受 http(s) 且不含账号密码；编辑框只回显已保存的值，自动检测值只做占位符。前端 `public/js/apps.js`，`tools.js` 泛化为“任务/工具/应用”三页切换并按功能（`pm2:manage`/`apps:manage`）判断引擎能力。测试：`test/apps-*.test.js`、`test/port-detector.test.js`、`scripts/test-apps-ui-browser.cjs`；`scripts/test-pm2-ui-browser.cjs` 的夹具因 `tools.js` 依赖应用面板而同步更新。**未验证**：Linux 上 `ss` 分支只有解析单测，没有真机；远程引擎代理只在本机用两个本地服务模拟过。 |
| 2.31.1 | **修复“磁盘代码已更新但服务没重启时，检查更新却显示已是最新”**：检查更新拿远程版本和磁盘 `VERSION.json` 比较，手动 `git pull`、强制恢复仓库或上次更新中途失败后，磁盘比内存里运行的新，却报 `current`（日志里 `restart_required: true` 已经算出来了但界面没用）。现在新增状态 `restart_pending`（“需要重启服务”）：Git 安装用 `requiresRestart(runningCommit, HEAD)`，安装包方式比较启动时版本号；有更高远程版本时仍是 `available`；红点、一键检查的结果框和设置里都会提示并列出 PM2 / launchd / systemd 的重启命令；重启后持久化的旧状态被清除。测试：`test/update-restart-pending.test.js`（含变异验证）、`test/one-click-update.test.js`，并用真实 git 仓库复现过“旧提交启动 → 磁盘换成新提交 → restart_pending → 重启后 current”。注意：**只有这台服务重启并加载 v2.31.1 之后才有这个提示**，已经在跑旧代码的进程仍然会报“已是最新” |
| 2.32.0 | **Client 安装脚本默认改由 PM2 管理**（补上之前被我遗漏的需求）：`install.sh` 新增 `--pm2` / `--system-service`，默认 `pm2 start server.js --name t-agent --cwd <项目目录>` 并 `pm2 save`；没有 PM2 时 `npm install -g pm2`；端口被占用不启动并提示；重复运行改为 `pm2 restart t-agent --update-env`。**已注册 LaunchAgent / systemd 的老安装默认继续沿用**，只有加 `--pm2` 才迁移（先停用并移除旧服务）。`uninstall.sh` 同步删除 PM2 里的进程。这样 t-agent 自己也会出现在“应用列表”和“PM2 进程管理”里。测试：`test/install-project.test.js`（沙箱里用桩替换 npm/pm2/launchctl，仅 macOS 运行，沙箱 PATH 里不放真实 pm2）。**注意**：这台 Mac 上 t-agent 目前仍由 launchd（`com.tagent.client`）管理，需要用户自己运行 `./install.sh --pm2` 才会迁移——迁移会重启服务并中断所有终端会话。**没做**：之前搁置的“数据目录与项目目录分离”（用户说不需要）；完整改动保存在嵌套克隆 `tasks/t-agent/t-agent` 的 `stash@{0}` 里 |
| 2.33.0 | **移除“实用工具”页里的“PM2 进程管理”面板**（用户要求；PM2 的操作都在“应用列表”里）。删除：`index.html` 的 PM2 卡片和实用工具页的“当前引擎”提示、`tools.js` 里的 `pm2` 面板模块、面板专用样式（`.pm2-logs`、`#pm2-log-text`）、`scripts/test-pm2-ui-browser.cjs`。**保留**（应用列表在用）：后端 `/api/pm2/*`、Engine `/v1/pm2/*`、远程代理、能力 `pm2:manage`，以及样式 `pm2-table`/`pm2-badge`/`pm2-actions`/`pm2-logs-bar`；后端测试 `test/pm2-manager.test.js`、`test/pm2-engine.test.js` 不变。`/api/pm2/status` 现在界面不再调用，但接口保留以兼容旧版 Client。PM2 操作的界面覆盖由 `scripts/test-apps-ui-browser.cjs` 承担 |

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
2. ~~全量测试~~ 已在 v2.29.0 上验证：`test/` 265 个、13 个浏览器脚本全部通过（2026-10-07）。
3. **Codex 交互式（TUI）hook 不触发——已决定不处理（2026-10-07）**：`codex exec` 下 hook 正常，交互式会话实测 0 个事件，疑似 hook 由常驻的 `codex app-server --managed-daemon` 执行、其环境没有 `TA_HOOK_URL`（未证实）。用户决定 Codex 只靠输出判断状态（v2.29.3 起 macOS 也能识别前台 `codex`），不再排查 hook；Claude Code 的 hook 不受影响。

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
