# torin-x-web

个人任务管理 + MD 文档预览，支持 GitHub OAuth 登录、内置终端、PWA 安装。

---

## 安装

支持 macOS 和主流 Linux 服务器发行版。脚本会安装 Node 依赖，并在首次运行时交互询问用户名和密码来创建本地账号与 `.env` 配置；网页端不提供注册功能。脚本会注册开机自启服务：macOS 使用 LaunchAgent，Linux 使用 systemd。

```bash
chmod +x install.sh
./install.sh
```

可在非交互环境传入账号、密码与端口：

```bash
./install.sh --port 13148 --username admin --password '请换成强密码' --tasks-dir /srv/t-agent-tasks
```

已有 `.env` 不会被覆盖；仅在显式传入 `--port` 或 `--tasks-dir` 时更新相应值。使用 `./install.sh --help` 查看完整参数。

### 手动配置（可选）

```bash
cp .env.example .env
```

编辑 `.env`：

```env
PORT=3000
SESSION_SECRET=随机字符串（越长越好）
# 用 node scripts/gen-password.js <用户名> <密码> 生成
AUTH_USERS=用户名:salt:hash
TASKS_BASE_DIR=/你想存放任务 md 文件的目录
```

检查更新相关配置：

```env
GITHUB_VERSION_URL=https://raw.githubusercontent.com/owner/repository/main/VERSION.json
UPDATE_GIT_REMOTE=origin
UPDATE_GIT_BRANCH=main
UPDATE_CHECK_INTERVAL_SECONDS=1800
UPDATE_ADMIN_USERS=你的本地用户名
```

定时检查只读取 GitHub 上的 `VERSION.json`。只有更新管理员在页面二次确认后，服务才会检查工作区、备份 SQLite、执行 fast-forward 更新、安装依赖、构建并请求守护进程重启。未设置 `GITHUB_VERSION_URL` 时，会尝试根据 Git `origin` 和目标分支推导 Raw 链接。

### 安装依赖

需要 Node.js 18+。

```bash
npm install
```

> `node-pty` 依赖原生编译，需要系统有 Python3 和 C++ 编译工具。
> macOS: `xcode-select --install`
> Linux: `apt install build-essential python3`

### 启动

```bash
npm start
```

访问 http://localhost:3000，用本地账号登录即可。

---

## 功能

- 任务管理（新建/编辑/删除，状态流转：待办→进行中→已完成）
- 关联本地 `.md` 文件，实时预览（支持 Mermaid 流程图）
- 内置终端（每个任务独立 PTY，切换保留历史）
- 右侧 TOC 大纲，支持折叠
- 快速链接栏
- PWA，可安装为桌面应用

---

## 目录结构

```
torin-x-web/
├── server.js        # 入口
├── config.js        # 配置读取
├── db/              # SQLite 初始化
├── routes/          # API 路由
├── middleware/      # 鉴权中间件
├── public/          # 前端静态文件
└── data/            # SQLite 数据库（自动创建，勿提交）
```
