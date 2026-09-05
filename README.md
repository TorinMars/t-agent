# T-Agent

组件化任务工作台：Client 统一管理本机和多台远程 Engine，Engine 负责任务数据、Markdown 文档、工作目录和终端执行。

Client 安装包已经包含本地 Engine，无需再安装一次。无界面服务器可以只安装 Engine，再通过一次性配对码或 Token 接入 Client。

详见 [组件架构](docs/ARCHITECTURE.md) 和 [Engine API](docs/ENGINE_API.md)。

---

## 安装

支持 macOS 和主流 Linux 发行版。脚本会安装 Node.js 依赖并注册开机自启服务：macOS 使用 LaunchAgent，Linux 使用 systemd。

### 安装 Client（内含本地 Engine）

安装完成后可直接管理本机任务，也可继续连接多台远程 Engine。

```bash
curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/bootstrap.sh | T_AGENT_MODE=client bash
```

### 安装独立 Engine

适用于远程服务器。不安装网页 Client，不创建用户名密码。安装完成后会显示一个只出现一次的 owner Token。

```bash
curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/bootstrap.sh | T_AGENT_MODE=engine bash
```

将服务器地址和 Token 填入 Client 即可连接。Engine 安装模式默认端口为 `3100`。

连接完成后，点击 Client 左侧的“新建任务”，在“所属 Engine”中选择远程节点。任务数据、文档和工作目录会直接创建在所选 Engine 上。路径留空时，Engine 会在自己的 `TASKS_BASE_DIR` 下自动创建目录。

后续要为其他 Client 生成一次性配对码：

```bash
cd /path/to/t-agent
node scripts/create-engine-pairing-code.js operator
```

### 从源码目录安装

```bash
chmod +x install.sh
./install.sh --mode client
```

可在非交互环境传入账号、密码与端口：

```bash
./install.sh --mode client --port 13148 --username admin --password '请换成强密码' --tasks-dir /srv/t-agent-tasks
./install.sh --mode engine --port 3100 --tasks-dir /srv/t-agent-tasks
```

### 一键完全卸载（curl）

以下命令会停止服务、删除 macOS LaunchAgent 或 Linux systemd 启动项，并永久删除项目目录、数据库、日志、配置和任务工作目录。脚本会列出删除目标，并要求输入 `UNINSTALL` 确认：

```bash
curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/uninstall.sh | bash
```

若安装时使用了自定义目录，请在该目录的父目录执行，或显式指定目录：

```bash
curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/uninstall.sh | T_AGENT_DIR=/opt/t-agent bash
```

已有 `.env` 不会被覆盖；仅在显式传入 `--port` 或 `--tasks-dir` 时更新相应值。使用 `./install.sh --help` 查看完整参数。

### 手动配置（可选）

```bash
cp .env.example .env
```

编辑 `.env`：

```env
PORT=3000
T_AGENT_MODE=client
SESSION_SECRET=随机字符串（越长越好）
# 用 node scripts/gen-password.js <用户名> <密码> 生成
AUTH_USERS=用户名:salt:hash
TASKS_BASE_DIR=/你想存放任务 md 文件的目录
ENGINE_WORKSPACE_ROOTS=/允许 Engine 读写的任务目录
```

检查更新相关配置：

```env
GITHUB_VERSION_URL=https://raw.githubusercontent.com/TorinMars/t-agent/refs/heads/main/VERSION.json
UPDATE_GITHUB_REPOSITORY=TorinMars/t-agent
UPDATE_GITHUB_REF=main
UPDATE_GIT_REMOTE=origin
UPDATE_GIT_BRANCH=main
UPDATE_CHECK_INTERVAL_SECONDS=1800
UPDATE_ADMIN_USERS=你的本地用户名
```

服务启动后会自动检查一次，之后默认每 30 分钟检查 GitHub 上的 `VERSION.json`。发现新版本时，设置按钮会显示提示点并弹出“立即更新”按钮；只有更新管理员二次确认后才会执行。

Git 安装会检查工作区并执行 fast-forward；一键安装产生的不含 `.git` 目录会下载对应分支的官方归档。两种方式都会先备份 SQLite，保留 `.env`、数据库、日志和任务目录，然后安装依赖、构建资源并由守护进程重启。

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
# 或显式启动 Client
npm run start:client

# 只启动 Engine
npm run start:engine
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
- 统一 Engine API，支持多 Engine 聚合
- 一次性配对码和可撤销 Token
- 远程 Engine 任务、文档和 Todo CRUD API
- 远程终端的一次性 WebSocket ticket

---

## 目录结构

```
t-agent/
├── apps/engine/      # 独立 Engine 入口
├── services/         # Engine 业务组件
├── routes/           # Client 与 Engine API
├── middleware/       # Session 与 Token 授权
├── public/           # Client 前端
├── db/               # SQLite Schema
├── docs/             # 架构与 API 文档
└── data/             # 持久化数据（勿提交）
```
