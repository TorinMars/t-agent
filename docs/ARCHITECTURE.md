# T-Agent 组件架构

T-Agent 是单用户 Client：任务、Todo、Markdown 文档、工作目录和终端执行都由 Client 所在的机器保存和运行。需要使用多台机器时，在每台机器上各安装一个 Client，用下面的多 Client 页面在浏览器里切换。

## Client

Client 负责用户界面、任务与文档管理、终端 PTY、文件浏览器、更新检查，以及 Client 自己的身份验证。Web `/web` 和手机 H5 `/h5` 使用同一 TOTP 身份验证器鉴权，默认只监听 `127.0.0.1`。手机访问可显式配置 `HOST=0.0.0.0`，或通过 HTTPS 反向代理访问。

## 多 Client 页面

`/clients` 是独立的浏览器工作台，可在登录前访问，仅在 localStorage 保存名称、地址与选中项。每个 Client 使用独立 iframe，首次选中时加载；切换仅隐藏旧页面，刷新、编辑地址或移除时才释放对应页面。工作台不代理业务请求、不共享凭证，只接受来自已配置 origin 和对应 iframe window 的加载状态消息。

目标 Client 通过 `CLIENT_FRAME_ORIGINS` 配置可内嵌的工作台 origin；默认 CSP frame-ancestors 只允许同源。登录和绑定页面始终禁止内嵌。配置内嵌后，HTTPS 会话 Cookie 使用 SameSite=None + Secure，HTTP 保持 Strict；浏览器 API 与终端 Origin 校验不放宽。跨站使用依赖浏览器允许第三方 Cookie。同一主机不同端口的 Client 可用不同 `CLIENT_SESSION_COOKIE_NAME` 隔离会话，默认名称仍为 connect.sid。

## 身份验证

Client 初始化和旧版本升级均默认未绑定身份验证器。未绑定时所有业务页面、浏览器 API 和终端 WebSocket 均拒绝访问并引导绑定。首次绑定无需初始密码或初始化码，不限制本机或远程：网页 `/auth/setup` 与终端 `node scripts/client-auth-setup.js` 均可完成，二者共用同一绑定 API，并受认证限流与二次校验码确认保护。扫码或手动添加密钥并校验 6 位验证码后，才持久化启用绑定。已登录用户可在近期验证后远程更换验证器。绑定密钥与待确认密钥使用 `SESSION_SECRET` 派生的 AES-256-GCM 密钥加密；恢复码仅保存 SHA-256 哈希。会话为 30 天滚动有效期的 SQLite Session，并默认使用 HttpOnly/SameSite=Strict Cookie；仅直连本机 HTTP 可不设 Secure，远程生产环境和 HTTPS 均设置 Secure，确保生产模式也能在本机绑定。旧免登录会话不授予权限。验证码与恢复码均防重放，认证限流持久化到 SQLite。

更换身份验证器需要五分钟内的再次验证，完成后撤销旧会话、旧恢复码并关闭浏览器终端连接。退出也立即关闭当前会话的终端连接，不终止 PTY 及其中正在执行的程序。明确创建的只读 `/share/:token` 链接仍按分享 Token 授权。

## 文件边界

任务 API 的 `work_dir` 和 `md_path` 接受 Client 服务器上的任意绝对路径，不使用目录白名单。每个任务可以单独指定工作目录；未指定 `md_path` 时，技术方案默认使用工作目录下的 `DESIGN.md`。实际读写范围由 Client 进程的操作系统账号权限决定，因此 Client 应使用权限受限的专用账号运行。

## 终端连接

浏览器通过已认证的会话建立 `/terminal/ws` WebSocket，并按任务和终端 ID 连接对应的 PTY。浏览器重新打开终端时只重建 WebSocket，PTY 保持运行。关闭或从工作目录重新打开时，浏览器使用受认证的 REST 控制接口终止 PTY；后者还会清空旧历史，使下一次连接严格从任务 `work_dir` 创建新 Shell。控制指令不复用终端输入通道，避免被当作 Shell 输入。

## 终端运行状态

服务端为每个终端判定 idle、running、done 三种状态：普通命令按 PTY 前台进程判断，Claude Code、Codex 等常驻交互程序优先使用它们的 hook 事件上报，没有 hook 时按输出节奏判断。浏览器轮询 `GET /api/tasks/terminal-activity`，打开已完成的终端时通过 `POST /api/tasks/:id/terminal/ack` 确认。
