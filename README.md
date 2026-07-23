# torin-x-web

个人任务管理 + MD 文档预览，支持 GitHub OAuth 登录、内置终端、PWA 安装。

---

## 部署步骤

### 1. 创建 GitHub OAuth App

前往 https://github.com/settings/developers → **New OAuth App**

| 字段 | 填写 |
|------|------|
| Application name | 随意 |
| Homepage URL | `http://localhost:3000` |
| Authorization callback URL | `http://localhost:3000/auth/github/callback` |

创建后记录 **Client ID** 和 **Client Secret**。

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
GITHUB_CLIENT_ID=你的 Client ID
GITHUB_CLIENT_SECRET=你的 Client Secret
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback
ALLOWED_GITHUB_USERS=你的 GitHub 用户名
PORT=3000
SESSION_SECRET=随机字符串（越长越好）
TASKS_BASE_DIR=/你想存放任务 md 文件的目录
```

### 3. 安装依赖

需要 Node.js 18+。

```bash
npm install
```

> `node-pty` 依赖原生编译，需要系统有 Python3 和 C++ 编译工具。
> macOS: `xcode-select --install`
> Linux: `apt install build-essential python3`

### 4. 启动

```bash
npm start
```

访问 http://localhost:3000，用 GitHub 账号登录即可。

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
