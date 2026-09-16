# T-Agent 组件架构

T-Agent 由 Client 和 Engine 两个边界明确的组件构成。

## Client

Client 负责用户界面、Engine 注册、凭证加密保存和多 Engine 数据聚合。Client 安装包默认包含一个本地 Engine，不需要重复安装。

Client 通过标准 `/v1` API 连接远程 Engine。远程 Token 使用 `SESSION_SECRET` 加密后才写入 Client 数据库，不会返回浏览器。

## Engine

Engine 是任务、Todo、Markdown 文档、工作目录和终端执行的权威数据源。独立 Engine 固定监听 `0.0.0.0`，不需要用户名密码，仅使用可撤销的 Bearer Token。Client 保持单用户数据归属，Web `/web` 和手机 H5 `/h5` 使用同一 TOTP 身份验证器鉴权，默认只监听 `127.0.0.1`。手机访问可显式配置 `HOST=0.0.0.0`，或通过 HTTPS 反向代理访问。

Client 初始化和旧版本升级均默认未绑定身份验证器。未绑定时所有业务页面、浏览器 API 和终端 WebSocket 均拒绝访问并引导绑定。首次绑定需要服务启动日志中的 15 分钟初始化码，扫码或手动添加密钥并校验 6 位验证码后，才持久化启用绑定。绑定密钥与待确认密钥使用 `SESSION_SECRET` 派生的 AES-256-GCM 密钥加密；恢复码仅保存 SHA-256 哈希。会话为 12 小时绝对有效期的 SQLite Session，并使用 HttpOnly/SameSite=Strict Cookie，HTTPS 生产环境另设 Secure。旧免登录会话不授予权限。验证码与恢复码均防重放，认证限流持久化到 SQLite。

更换身份验证器需要五分钟内的再次验证，完成后撤销旧会话、旧恢复码并关闭浏览器终端连接。退出也立即关闭当前会话的终端连接，不终止 PTY 及其中正在执行的程序。`/v1` 与旧 `/api/remote/v1` 保留 Engine 的 Bearer Token 边界，明确创建的只读 `/share/:token` 链接仍按分享 Token 授权。

每个 Engine 在 SQLite 中保存稳定的 `engine_id`。Client 使用 `(engine_id, task_id)` 区分不同节点上的资源。

## 授权

- 配对码：`TA-XXXX-XXXX-XXXX`，默认 10 分钟失效且只能使用一次。
- 访问 Token：`tae_...`，只在创建时显示明文，Engine 只保存 SHA-256 哈希。
- 终端 ticket：`tat_...`，30 秒失效且只能使用一次。

Token 角色分为 `readonly`、`operator` 和 `owner`。对外协议使用细粒度 scope，界面只向用户展示三种角色。

Engine 的检查更新、应用更新接口要求 `engine:admin` scope，只有 `owner` Token 可以调用。Client 浏览器只请求本机代理接口；Client 服务端解密已保存的 Token 后调用 Engine，Token 不会进入浏览器。更新完成后 Engine 以非零状态退出，由 systemd、launchd 或等效进程管理器重新拉起。

Docker Engine 使用不可变镜像，不在容器内覆盖应用文件。它仍会检查并展示远程版本，但镜像拉取和容器重建由宿主机更新脚本完成；数据库、任务文件和独立的 Codex 配置目录通过 bind mount 持久化，Engine 容器不持有 Docker Socket。镜像内置 Codex CLI，任务终端可以直接调用 `/usr/local/bin/codex`。

## 文件边界

任务 API 的 `work_dir` 和 `md_path` 接受 Engine 服务器上的任意绝对路径，不使用目录白名单。每个任务可以单独指定工作目录；未指定 `md_path` 时，技术方案默认使用工作目录下的 `DESIGN.md`。实际读写范围由 Engine 进程的操作系统账号权限决定，因此写权限 Token 只应发给可信 Client，Engine 也应使用权限受限的专用账号运行。

## 终端连接

Client 先用 Access Token 请求 `POST /v1/terminal-sessions`，Engine 返回一次性 ticket 和 WebSocket 路径。建立 WebSocket 后 ticket 立即作废。

浏览器重新打开终端时只重建 WebSocket，Engine 中的 PTY 保持运行。关闭或从工作目录重新打开时，Client 使用受认证的 REST 控制接口终止 PTY；后者还会清空旧历史，使下一次连接严格从任务 `work_dir` 创建新 Shell。控制指令不复用终端输入通道，避免被旧 Engine 当作 Shell 输入。
