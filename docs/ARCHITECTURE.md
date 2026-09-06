# T-Agent 组件架构

T-Agent 由 Client 和 Engine 两个边界明确的组件构成。

## Client

Client 负责用户界面、Engine 注册、凭证加密保存和多 Engine 数据聚合。Client 安装包默认包含一个本地 Engine，不需要重复安装。

Client 通过标准 `/v1` API 连接远程 Engine。远程 Token 使用 `SESSION_SECRET` 加密后才写入 Client 数据库，不会返回浏览器。

## Engine

Engine 是任务、Todo、Markdown 文档、工作目录和终端执行的权威数据源。独立 Engine 不需要用户名密码，仅使用可撤销的 Bearer Token。Client 按单用户免登录模式运行，使用稳定的内部用户 ID 保留数据归属，并默认只监听 `127.0.0.1`。

每个 Engine 在 SQLite 中保存稳定的 `engine_id`。Client 使用 `(engine_id, task_id)` 区分不同节点上的资源。

## 授权

- 配对码：`TA-XXXX-XXXX-XXXX`，默认 10 分钟失效且只能使用一次。
- 访问 Token：`tae_...`，只在创建时显示明文，Engine 只保存 SHA-256 哈希。
- 终端 ticket：`tat_...`，30 秒失效且只能使用一次。

Token 角色分为 `readonly`、`operator` 和 `owner`。对外协议使用细粒度 scope，界面只向用户展示三种角色。

Engine 的检查更新、应用更新接口要求 `engine:admin` scope，只有 `owner` Token 可以调用。Client 浏览器只请求本机代理接口；Client 服务端解密已保存的 Token 后调用 Engine，Token 不会进入浏览器。更新完成后 Engine 以非零状态退出，由 systemd、launchd 或等效进程管理器重新拉起。

## 文件边界

Engine 只能读写 `ENGINE_WORKSPACE_ROOTS` 列出的根目录。任务 API 提供的 `work_dir` 和 `md_path` 必须位于允许的根目录内。

## 终端连接

Client 先用 Access Token 请求 `POST /v1/terminal-sessions`，Engine 返回一次性 ticket 和 WebSocket 路径。建立 WebSocket 后 ticket 立即作废。
