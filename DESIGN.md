# 个人主页设计文档

> 日期：2026-07-15

> 当前实现说明（v2.3.0）：本文保留了项目早期设计记录；现行架构已经拆分为 Client 与 Engine。Client 按单用户应用运行，启动后自动建立本地用户上下文，不再使用用户名、密码、登录页或退出入口；升级时会优先沿用数据库中已有用户及其任务归属。Client 默认仅监听 `127.0.0.1`。Engine 仍通过 Bearer Token 对 Client 提供远程 API 与终端连接，不受本次登录方式调整影响。完整现行架构与部署方式以 `README.md` 和 `docs/ARCHITECTURE.md` 为准。

---

## 一、目标

构建一个私人任务管理页，功能：
- **任务列表**（左侧导航栏）：任务的增删改、状态流转
- **MD 文件预览**（右侧主区域）：点击任务展示关联 `.md` 文件，支持 Mermaid 渲染

通过 GitHub OAuth 鉴权，仅允许配置的 GitHub 用户访问。

---

## 二、技术栈

| 层次 | 技术 |
|------|------|
| 前端 | 纯 HTML + CSS + Vanilla JS（无框架） |
| 后端 | Node.js + Express |
| 数据库 | SQLite（better-sqlite3） |
| 鉴权 | GitHub OAuth 2.0 + Express Session |
| Session 持久化 | connect-better-sqlite3 |
| MD 渲染 | marked.js（CDN） |
| 流程图渲染 | mermaid.js（CDN） |

---

## 三、项目结构

```
torin-x-web/
├── server.js              # 入口，Express 服务
├── config.js              # 配置（GitHub OAuth, 允许用户名, 端口等）
├── .env                   # 环境变量（不提交 git）
├── .env.example           # 环境变量示例
├── db/
│   ├── index.js           # SQLite 连接 & 初始化
│   └── schema.sql         # 建表语句
├── routes/
│   ├── auth.js            # GitHub OAuth 路由
│   └── tasks.js           # 任务列表 API
├── middleware/
│   └── auth.js            # 登录态校验中间件
├── public/
│   ├── index.html         # 主页（登录后可见）
│   ├── login.html         # 登录页
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js         # 主页逻辑（任务列表 + MD 预览）
│       └── tasks.js       # 任务模块
└── data/
    └── db.sqlite          # SQLite 数据库文件（不提交 git）
```

---

## 四、数据模型

### tasks（任务列表）

```sql
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  status     TEXT    DEFAULT 'todo',   -- todo | doing | done
  priority   TEXT    DEFAULT 'normal', -- low | normal | high
  due_date   TEXT,                     -- YYYY-MM-DD
  md_path    TEXT,                     -- 关联的本地 .md 文件绝对路径（可为 NULL）
  work_dir   TEXT,                     -- 工作目录，默认取 md_path 所在目录（可为 NULL）
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**说明：**
- 创建任务时：可只填 `md_path`，标题自动取文件名（去掉 `.md` 后缀）
- `md_path` 必须是绝对路径且扩展名为 `.md`，服务端强校验
- `work_dir` 若未传且有 `md_path`，服务端自动取 `path.dirname(md_path)` 作为默认值

### sessions（由 connect-better-sqlite3 自动管理）

---

## 五、鉴权流程

```
用户访问任意页面
      │
      ▼
中间件检查 session.user
      │
  未登录 ──► 重定向到 /login
      │
  已登录
      │
      ▼
  GitHub username 是否在 ALLOWED_USERS 白名单？
      │
    否 ──► 返回 403 页面
      │
    是 ──► 放行
```

**OAuth 回调流程：**
1. 用户点击「GitHub 登录」→ 跳转 `GET /auth/github`
2. 重定向到 GitHub 授权页
3. GitHub 回调 `GET /auth/github/callback?code=xxx`
4. 后端用 code 换 access_token，再获取用户信息
5. 校验 `login` 字段是否在白名单，写入 session
6. 跳转首页

---

## 六、API 设计

所有 API 需要登录态，否则返回 `401`。

### 鉴权

| Method | Path | 说明 |
|--------|------|------|
| GET | `/auth/github` | 跳转 GitHub OAuth |
| GET | `/auth/github/callback` | OAuth 回调 |
| POST | `/auth/logout` | 退出登录 |
| GET | `/auth/me` | 获取当前用户信息 |

### 任务

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/tasks` | 获取所有任务（支持 `?status=todo` 过滤） |
| POST | `/api/tasks` | 新建任务 |
| PUT | `/api/tasks/:id` | 更新任务（标题、状态、优先级、due_date） |
| DELETE | `/api/tasks/:id` | 删除任务 |
| GET | `/api/tasks/:id/md` | 读取任务关联 `.md` 文件内容（纯文本） |

---

## 七、页面布局

### 登录页（`/login.html`）

居中卡片，GitHub 图标 + 「使用 GitHub 登录」按钮。

### 主页（`/`）— 三栏布局

```
┌──────────────────────────────────────────────────────────────────────────┐
│  📋 Tasks                                  [头像] matonglin  [登出]       │
├─────────────────┬───────────────────────────────────────┬────────────────┤
│                 │                                       │                │
│  [+ 新建任务]   │   # 设计文档                          │  目录          │
│                 │                                       │  ─────────     │
│  ● 进行中       │   ## 一、目标                         │  # 设计文档    │
│  ─────────────  │   ...                                 │  ├ 一、目标    │
│  ▶ design       │                                       │  ├ 二、架构    │
│  ▶ plan         │   ## 二、架构                         │  │ ├ 流程图    │
│                 │   ```mermaid                          │  │ └ 模块      │
│  ○ 待办         │   graph TD                            │  └ 三、部署    │
│  ─────────────  │     A --> B                           │                │
│    task-a       │   ```                                 │                │
│    task-b       │   [mermaid 渲染结果]                  │                │
│                 │                                       │                │
│  ✓ 已完成       │   ## 三、部署                         │                │
│  ─────────────  │   ...                                 │                │
│    old-task     │                                       │                │
│                 │                                       │                │
└─────────────────┴───────────────────────────────────────┴────────────────┘

左侧（任务导航）：280px 固定
中间（MD 预览）：flex: 1，自适应，可滚动
右侧（MD 大纲）：220px 固定，仅当有 md_path 时显示
```

---

## 八、前端交互

### 左侧导航栏

- 任务按状态分三组：**进行中 / 待办 / 已完成**，各组可折叠
- 有 `md_path` 的任务显示 `▶` 箭头图标，无 md 的任务显示普通圆点
- 点击任务 → 高亮选中，右侧加载 MD 预览
- 右键任务 → 上下文菜单（修改状态 / 删除）
- 状态圆圈点击 → 快速切换状态（todo → doing → done → todo）

### 新建任务弹窗

```
┌─────────────────────────────┐
│  新建任务                 ✕ │
├─────────────────────────────┤
│  标题  [___________________] │
│  MD路径[___________________] │  ← 输入后自动填充标题
│  优先级 ○低  ●中  ○高        │
│  截止日 [____-__-__]         │
│                             │
│           [取消]  [创建]     │
└─────────────────────────────┘
```

- `md_path` 输入框失焦时：
  1. 校验扩展名是否为 `.md`
  2. 请求 `POST /api/tasks/validate-path` 验证文件是否存在
  3. 若合法且标题为空，自动填充文件名作为标题
- 标题必填（可手动改），路径可选
- **自动创建模式**：若只填写了标题、未填写 `md_path`，点击创建时：
  1. 服务端在 `/Users/torin/main-kuaishou/02_agent/<任务标题>/` 目录下自动创建目录
  2. 创建 `<任务标题>.md` 文件，内容为 `# <任务标题>\n`
  3. 自动将 `work_dir` 设为该目录，`md_path` 设为该 md 文件路径
  4. 目录名 / 文件名取 title，非法字符替换为 `-`（替换规则：`/\s+/g → '-'`, `/[^a-zA-Z0-9一-龥\-_\.]/g → ''`）

### 右侧 MD 预览区

- 无选中任务时：显示空状态提示「← 选择左侧任务查看详情」
- 有选中任务但无 `md_path`：显示任务基本信息（标题、状态、优先级、截止日）
- 有 `md_path`：
  1. 请求 `GET /api/tasks/:id/md` 获取 markdown 原文
  2. marked.js 渲染 HTML，mermaid 代码块替换为 `<div class="mermaid">...</div>`
  3. `mermaid.init()` 触发渲染
  4. 预览区可滚动
  5. 渲染完毕后同步生成右侧大纲

### 右侧大纲（TOC）

- 仅当当前任务有 `md_path` 时显示，否则隐藏（宽度收起）
- 解析 marked.js 渲染后 DOM 中的 `h1~h4` 标题元素，生成树形目录
- 各级标题缩进：`h1` 无缩进，`h2` 缩进 8px，`h3` 缩进 16px，`h4` 缩进 24px
- 点击大纲条目 → 对应标题滚动到中间预览区可视范围顶部（`scrollIntoView`）
- 中间预览区滚动时 → 高亮当前可视范围内最顶部的标题对应的大纲条目（滚动监听 + IntersectionObserver）

```html
<!-- CDN 引入（index.html） -->
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
```

---

## 九、配置（`.env`）

```env
# GitHub OAuth
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

# 允许访问的 GitHub 用户名（逗号分隔）
ALLOWED_GITHUB_USERS=matonglin

# 服务
PORT=3000
SESSION_SECRET=your-random-secret
```

---

## 十、依赖清单

```json
{
  "dependencies": {
    "express": "^4.18.x",
    "better-sqlite3": "^9.x",
    "connect-better-sqlite3": "^1.x",
    "express-session": "^1.17.x",
    "axios": "^1.x"
  }
}
```

---

## 十一、安全考量

| 风险 | 措施 |
|------|------|
| Session 劫持 | `httpOnly` + `secure`（生产环境）Cookie，Session Secret 随机生成 |
| CSRF | API 请求带 `X-Requested-With` header，服务端校验 |
| 越权访问 | 所有 API 过 auth 中间件，校验 session |
| 敏感配置泄露 | `.env` 加入 `.gitignore`，提供 `.env.example` |
| username 白名单绕过 | 使用 GitHub API 返回的 `login` 字段精确匹配，不信任前端传参 |
| 任意文件读取 | `/api/tasks/:id/md` 只读取数据库中已存储的 `md_path`，不接受前端传路径；强校验扩展名为 `.md` |

---

## 十二、启动方式

```bash
npm install
cp .env.example .env   # 填入 GitHub OAuth 配置
node server.js         # 开发：nodemon server.js
```

| 层次 | 技术 |
|------|------|
| 前端 | 纯 HTML + CSS + Vanilla JS（无框架） |
| 后端 | Node.js + Express |
| 数据库 | SQLite（better-sqlite3） |
| 鉴权 | GitHub OAuth 2.0 + Express Session |
| 数据持久化 | Session 存 SQLite（connect-better-sqlite3） |

---

## 三、项目结构

```
torin-x-web/
├── server.js              # 入口，Express 服务
├── config.js              # 配置（GitHub OAuth, 允许用户名, 端口等）
├── .env                   # 环境变量（不提交 git）
├── .env.example           # 环境变量示例
├── db/
│   ├── index.js           # SQLite 连接 & 初始化
│   └── schema.sql         # 建表语句
├── routes/
│   ├── auth.js            # GitHub OAuth 路由
│   ├── bookmarks.js       # 快捷导航 API
│   └── tasks.js           # 任务列表 API
├── middleware/
│   └── auth.js            # 登录态校验中间件
├── public/
│   ├── index.html         # 主页（登录后可见）
│   ├── login.html         # 登录页
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js         # 主页逻辑
│       ├── bookmarks.js   # 快捷导航模块
│       └── tasks.js       # 任务列表模块
└── data/
    └── db.sqlite          # SQLite 数据库文件（不提交 git）
```

---

## 四、数据模型

### bookmarks（快捷导航）

```sql
CREATE TABLE bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  icon       TEXT,              -- favicon URL 或 emoji
  group_name TEXT    DEFAULT '默认',
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### tasks（任务列表）

```sql
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  status     TEXT    DEFAULT 'todo',   -- todo | doing | done
  priority   TEXT    DEFAULT 'normal', -- low | normal | high
  due_date   TEXT,                     -- YYYY-MM-DD
  md_path    TEXT,                     -- 关联的本地 .md 文件绝对路径（可为 NULL）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**说明：**
- `md_path` 为可选字段
- 创建任务时：可只填 `md_path`（标题自动取文件名去掉 `.md` 后缀），也可填标题+路径
- 路径必须是绝对路径，且文件扩展名必须为 `.md`，服务端做校验

### sessions（Session 持久化，由 connect-better-sqlite3 自动管理）

---

## 五、鉴权流程

```
用户访问任意页面
      │
      ▼
中间件检查 session.user
      │
  未登录 ──► 重定向到 /login
      │
  已登录
      │
      ▼
  GitHub username 是否在 ALLOWED_USERS 列表？
      │
    否 ──► 返回 403 页面
      │
    是 ──► 放行
```

**OAuth 回调流程：**
1. 用户点击「GitHub 登录」→ 跳转 `GET /auth/github`
2. 重定向到 GitHub 授权页
3. GitHub 回调 `GET /auth/github/callback?code=xxx`
4. 后端用 code 换 access_token，再获取用户信息
5. 校验 username 是否在白名单，写入 session
6. 跳转首页

---

## 六、API 设计

所有 API 需要登录态，否则返回 `401`。

### 鉴权

| Method | Path | 说明 |
|--------|------|------|
| GET | `/auth/github` | 跳转 GitHub OAuth |
| GET | `/auth/github/callback` | OAuth 回调 |
| POST | `/auth/logout` | 退出登录 |
| GET | `/auth/me` | 获取当前用户信息 |

### 快捷导航

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/bookmarks` | 获取所有书签（按分组） |
| POST | `/api/bookmarks` | 新建书签 |
| PUT | `/api/bookmarks/:id` | 更新书签 |
| DELETE | `/api/bookmarks/:id` | 删除书签 |
| PUT | `/api/bookmarks/reorder` | 调整排序 |

### 任务列表

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/tasks` | 获取所有任务（支持 `?status=todo` 过滤） |
| POST | `/api/tasks` | 新建任务 |
| PUT | `/api/tasks/:id` | 更新任务（含状态流转） |
| DELETE | `/api/tasks/:id` | 删除任务 |
| GET | `/api/tasks/:id/md` | 读取任务关联的 .md 文件内容（纯文本返回） |

---

## 七、前端页面设计

### 登录页（`/login.html`）

- 居中卡片
- GitHub 图标 + 「使用 GitHub 登录」按钮
- 简洁，无多余元素

### 主页（`/`）

```
┌─────────────────────────────────────────────────────┐
│  🏠 Torin's Dashboard          [头像] matonglin  登出 │
├─────────────────────────────────────────────────────┤
│                                                     │
│  快捷导航                              [+ 添加]     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │  工作     │ │  工具     │ │  文档     │  ...      │
│  │  [icon]  │ │  [icon]  │ │  [icon]  │            │
│  │  Jira    │ │  ChatGPT │ │  Notion  │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│                                                     │
│  ─────────────────────────────────────────────────  │
│                                                     │
│  任务列表                              [+ 添加]     │
│  ┌─────────────────────────────────────────────┐   │
│  │ ○ [high] 完成个人主页开发          今天      │   │
│  │ ○ [norm] Review 代码               明天      │   │
│  │                                              │   │
│  │ ▶ [norm] 📄 design.md              今天      │   │  ← 关联 md 文件的任务，点击展开
│  │   ┌──────────────────────────────────────┐   │   │
│  │   │  # 设计文档                          │   │   │
│  │   │  ## 流程图                           │   │   │
│  │   │  [mermaid 渲染图]                    │   │   │
│  │   └──────────────────────────────────────┘   │   │
│  │                                              │   │
│  │ ✓ [low]  更新文档                  已完成    │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**交互细节：**
- 书签卡片：单击打开链接，右键或 hover 显示编辑/删除
- 书签分组：标签页切换
- 任务：点击圆圈切换状态（todo → doing → done）
- 添加书签/任务：inline 弹窗表单，无需跳页
- 已完成任务默认折叠，可展开查看

### 任务 MD 预览交互

**新建任务（关联 md 文件）：**
1. 点击「+ 添加」→ 弹窗出现输入框
2. 输入本地 `.md` 文件绝对路径（如 `/Users/torin/docs/design.md`）
3. 失焦时服务端校验路径合法性（扩展名 `.md`、文件存在）
4. 标题自动填充为文件名（去掉 `.md`），可手动修改
5. 提交后任务卡片展示 📄 图标标记

**任务展开预览：**
- 有 `md_path` 的任务，标题左侧有 `▶` 展开箭头
- 点击标题行 → 展开内嵌预览区（再次点击折叠）
- 展开时前端请求 `GET /api/tasks/:id/md` 拿 markdown 原文
- 使用 **marked.js** 渲染 markdown，**mermaid.js** 渲染流程图
- mermaid 代码块渲染流程：marked 解析时识别 ` ```mermaid ` 代码块 → 替换为 `<div class="mermaid">` → mermaid.js 初始化渲染
- 预览区最大高度 `500px`，超出滚动

### 前端新增依赖（CDN 引入，无构建）

```html
<!-- Markdown 渲染 -->
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<!-- Mermaid 流程图 -->
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
```

---

## 八、配置（`.env`）

```env
# GitHub OAuth
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

# 允许访问的 GitHub 用户名（逗号分隔）
ALLOWED_GITHUB_USERS=matonglin

# 服务
PORT=3000
SESSION_SECRET=your-random-secret
```

---

## 九、依赖清单

```json
{
  "dependencies": {
    "express": "^4.18.x",
    "better-sqlite3": "^9.x",
    "connect-better-sqlite3": "^1.x",
    "express-session": "^1.17.x",
    "axios": "^1.x"
  }
}
```

无需 passport，GitHub OAuth 手动实现，保持轻量。

---

## 十、安全考量

| 风险 | 措施 |
|------|------|
| Session 劫持 | `httpOnly` + `secure`（生产环境） Cookie，Session Secret 随机生成 |
| CSRF | API 请求带 `X-Requested-With` header，服务端校验 |
| 越权访问 | 每个 API 请求都过 auth 中间件，校验 session |
| 敏感配置泄露 | `.env` 加入 `.gitignore`，提供 `.env.example` |
| username 白名单绕过 | 使用 GitHub API 返回的 `login` 字段做精确匹配，不信任前端传参 |
| 任意文件读取 | `/api/tasks/:id/md` 只读取数据库中已存储的 `md_path`，不接受前端传路径；服务端强校验扩展名为 `.md` |

---

## 十一、启动方式

```bash
npm install
cp .env.example .env   # 填入 GitHub OAuth 配置
node server.js         # 开发：nodemon server.js
```

---

## 十三、开机自启动

通过 macOS **LaunchAgent** 管理，开机自动启动，进程崩溃自动拉起（`KeepAlive: true`）。

**plist 路径**：`~/Library/LaunchAgents/com.torin.x-web.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.torin.x-web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/torin/main-kuaishou/02_agent/torin-x-web/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/torin/main-kuaishou/02_agent/torin-x-web</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/torin/main-kuaishou/02_agent/torin-x-web/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/torin/main-kuaishou/02_agent/torin-x-web/logs/stderr.log</string>
</dict>
</plist>
```

**常用管理命令**：

```bash
launchctl start  com.torin.x-web   # 启动
launchctl stop   com.torin.x-web   # 停止（KeepAlive 会自动拉起，需先 unload 才能彻底停止）
launchctl unload ~/Library/LaunchAgents/com.torin.x-web.plist   # 彻底停止并取消开机启动
launchctl load   ~/Library/LaunchAgents/com.torin.x-web.plist   # 重新注册并启动

# 查看运行状态
launchctl list com.torin.x-web

# 查看日志
tail -f /Users/torin/main-kuaishou/02_agent/torin-x-web/logs/stdout.log
tail -f /Users/torin/main-kuaishou/02_agent/torin-x-web/logs/stderr.log
```

**Node.js 版本**：`/usr/local/bin/node`（v20.16.0），**不使用** Homebrew 的 node（避免版本冲突导致原生模块编译不兼容）。

> ⚠️ 升级依赖或 `npm install` 后，若包含原生模块（`better-sqlite3`、`node-pty`），需确保由 `/usr/local/bin/node` 对应的 npm 编译，然后重启服务：
> ```bash
> cd /Users/torin/main-kuaishou/02_agent/torin-x-web
> npm rebuild
> launchctl stop com.torin.x-web && launchctl start com.torin.x-web
> ```

---
## 十二、快速链接功能技术方案

> 日期：2026-07-16

### 目标

在现有三栏布局中新增「快速链接」区域，支持常用网址的增删改、分组管理，单击直接跳转。

---

### UI 设计

**布局：Header 下方横向链接栏**，不占用左侧任务导航空间。

```
┌───────────────────────────────────────────────────────────────────┐
│  📋 Tasks                              [头像] matonglin  [登出]   │
├───────────────────────────────────────────────────────────────────┤
│  🔗  [Jira] [Confluence] [ChatGPT] [KDev] …  [+]  [▾]           │  ← 新增
├──────────────────┬─────────────────────────────────┬─────────────┤
│                  │                                 │             │
│  [+ 新建任务]    │   MD Preview                    │  TOC        │
│  ─────────────   │                                 │             │
│  ▶ design        │                                 │             │
└──────────────────┴─────────────────────────────────┴─────────────┘
```

**链接 chip**：favicon 图标 + 标题，单击新标签打开；右键显示「编辑」「删除」。

**折叠/展开**：多分组时点击 `▾` 展开，状态持久化到 `localStorage`。

**新建/编辑弹窗**：

```
┌──────────────────────────────┐
│  添加链接               ✕   │
├──────────────────────────────┤
│  名称   [__________________] │
│  URL    [__________________] │  ← 失焦自动抓取 favicon & 填充名称
│  图标   [__________________] │  ← emoji 或图片 URL，留空用 favicon
│  分组   [__________________] │
│              [取消]  [添加]  │
└──────────────────────────────┘
```

URL 失焦时自动从 `{origin}/favicon.ico` 加载预览；名称为空时自动取 hostname。

---

### 数据模型

已存在（`db/schema.sql`）：

```sql
CREATE TABLE IF NOT EXISTS bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  icon       TEXT,
  group_name TEXT    NOT NULL DEFAULT '默认',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

### API（已实现，无需新增）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/bookmarks` | 获取所有书签 |
| POST | `/api/bookmarks` | 新建 |
| PUT | `/api/bookmarks/:id` | 更新 |
| DELETE | `/api/bookmarks/:id` | 删除 |
| PUT | `/api/bookmarks/reorder` | 批量排序 |

---

### 前端实现

**HTML**（插入 `<header>` 与 `.layout` 之间）：

```html
<div class="quicklinks-bar" id="quicklinks-bar">
  <span class="quicklinks-label">🔗</span>
  <div class="quicklinks-chips" id="quicklinks-chips"></div>
  <button id="btn-add-link">+</button>
  <button id="btn-toggle-links">▾</button>
</div>
```

**JS 模块**：`public/js/bookmarks.js`（已有骨架，适配 chip 横向布局）

| 交互 | 行为 |
|------|------|
| 单击 chip | `window.open(url, '_blank')` |
| 右键 chip | ContextMenu：编辑 / 删除 |
| 点击 `+` | 打开新建弹窗 |
| 点击 `▾` | 折叠/展开多分组，写 `localStorage` |

---

### 改动文件清单

| 文件 | 改动 |
|------|------|
| `public/index.html` | Header 下方插入 `.quicklinks-bar` |
| `public/css/style.css` | 新增 `.quicklinks-*` 样式 |
| `public/js/bookmarks.js` | 重写为 chip 横向布局 |
| `public/js/app.js` | `init()` 中调用 `Bookmarks.load()` |
| 后端 | 无需改动 |

---

## 十三、已实现变更记录

> 日期：2026-07-16

### 快速链接功能（已实现）

按十二章方案实现，实际落地细节：

- **布局**：`--quicklinks-height: 36px`，`.layout` 高度同步减去该值
- **chip**：`inline-flex` + `border-radius: 14px`，favicon 自动从 `{origin}/favicon.ico` 加载，失败降级为 🔗
- **折叠**：单分组时隐藏 `▾` 按钮；多分组展开后每组一行并显示分组标签；状态持久化到 `localStorage('quicklinksExpanded')`
- **右键菜单**：复用全局 `ContextMenu`，提供编辑 / 删除操作

---

### Tools 页面局域网分享链接（已实现）

**背景**：`public/tools/` 目录下的静态工具页（如 `kwai-url-parser.html`）不做鉴权，需展示可供局域网直接访问的完整 URL。

**实现方案**：

1. **后端**：`server.js` 新增无鉴权接口：
   ```
   GET /api/local-ip  →  { ip: "192.168.x.x", port: 3000 }
   ```
   使用 `os.networkInterfaces()` 获取第一个非内网 IPv4 地址。

2. **前端**（`kwai-url-parser.html`）：页面加载时请求 `/api/local-ip`，将 `window.location` 的 hostname/port 替换为局域网 IP，展示在 header 右侧。

3. **UI**：
   ```
   ┌────────────────────────────────────────────────────────────┐
   │  🔗 Kwai URL 解析工具    http://192.168.1.4:3000/tools/… [复制链接] │
   └────────────────────────────────────────────────────────────┘
   ```
   点击整行或「复制链接」按钮均触发 `navigator.clipboard.writeText()`，复制后按钮短暂变为「已复制 ✓」。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `server.js` | 新增 `GET /api/local-ip`，启动日志打印 LAN 地址 |
| `public/tools/kwai-url-parser.html` | header 右侧插入分享链接组件，JS 动态拼接局域网 URL |

---

## 十四、任务工作路径 + 内嵌终端

> 日期：2026-07-20

### 目标

1. 每个任务新增 `work_dir`（工作目录）字段，默认取 `md_path` 所在目录
2. 内容区新增 Tab 切换（**文档** / **终端**），终端使用 xterm.js 打开服务器 Shell
3. Shell 进程常驻内存，终端输出（含命令 + 返回内容）持久化到 SQLite，支持服务重启后历史恢复

---

### 数据模型变更

**tasks 表** 新增字段（`ALTER TABLE` 追加）：

```sql
ALTER TABLE tasks ADD COLUMN work_dir TEXT;
-- 工作目录，默认取 md_path 所在目录，可手动修改
```

**新增 terminal_logs 表**：

```sql
CREATE TABLE IF NOT EXISTS terminal_logs (
  task_id    INTEGER PRIMARY KEY,
  buffer     TEXT    NOT NULL DEFAULT '',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- buffer：终端全量原始输出（ANSI escape codes），上限 5MB，超出从头截断保留后 5MB
```

---

### API 变更

`POST /api/tasks`、`PUT /api/tasks/:id`：新增 `work_dir` 字段，未传时自动取 `path.dirname(md_path)`。

`POST /api/tasks/validate-path`：响应追加 `work_dir: path.dirname(md_path)`。

**新增 WebSocket 接口**：

| 接口 | 说明 |
|------|------|
| `GET /terminal/ws?taskId=:id` | 升级为 WebSocket，连接任务对应的 Shell |

---

### 终端架构

```
前端 xterm.js  ←—— WebSocket ——→  node-pty（per task，常驻内存）
                                       ↓
                              内存 buffer（5MB 环形）
                                       ↓  每 5s 或累积 50KB flush
                              SQLite terminal_logs（持久化）
```

**进程生命周期**：pty 随任务首次连接创建，ws 断开不销毁，仅服务重启时消失。服务重启后从 `terminal_logs` 恢复历史 buffer，再 spawn 新 pty。

---

### UI 变更

工具栏下方新增 Tab 栏（仅当选中任务时显示）：

```
[📄 文档]  [⌨ 终端]
```

- **文档 tab**：原有 MD 预览 + TOC，行为不变
- **终端 tab**：全屏 xterm.js 黑色终端，cwd = `work_dir`，连接时自动回放历史 buffer

新建/编辑任务弹窗新增「工作路径」输入框，md_path 失焦校验通过后自动填充。

---

### 新增依赖

```json
"node-pty": "^1.0.0",
"ws": "^8.0.0"
```

前端 CDN 引入（`index.html`）：

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit/lib/addon-fit.js"></script>
```

---

### 改动文件清单

| 文件 | 改动 |
|------|------|
| `db/index.js` | 追加 work_dir 迁移；新建 terminal_logs 表 |
| `routes/tasks.js` | POST/PUT 支持 work_dir；validate-path 返回 work_dir |
| `routes/terminal.js` | 新建：WebSocket PTY，node-pty 常驻，buffer + SQLite 双写 |
| `server.js` | 挂载 ws server，拦截 `/terminal/ws` upgrade |
| `package.json` | 新增 node-pty、ws |
| `public/index.html` | 引入 xterm.js CDN；新增 tab 栏和 terminal-pane 结构 |
| `public/js/tasks.js` | Tab 切换；xterm 初始化；work_dir 表单字段；WebSocket 转发 |
| `public/css/style.css` | 新增 tab 栏、terminal-pane、.task-info-path 样式 |

---

## 十六、任务拖拽排序 + 个人任务分组

> 日期：2026-07-27

### 目标

1. 左侧任务列表支持拖拽排序（同组内调换顺序）
2. 拖拽到其他状态组 → 修改任务 status
3. 新增 status 值 `personal`（个人任务），作为第四个分组，与进行中/待办/已完成并列

---

### 侧边栏结构

```
● 进行中
  ▶ design
○ 待办
  task-a
✓ 已完成
  old-task
★ 个人任务      ← 新增 status='personal' 分组
  life-task
```

---

### 拖拽行为

| 拖拽场景 | 结果 |
|---------|------|
| 同 status 组内拖拽 | 更新 sort_order |
| 拖到不同 status 组 | 更新 status + sort_order |

- 拖拽时高亮目标插入位置（占位线）
- 拖拽结束后提交 status 变更 + 批量提交 sort_order

---

### 改动范围

**前端**（仅 tasks.js + style.css）：
- `STATUS_ORDER` 追加 `'personal'`，`STATUS_LABEL` 加 `'个人任务'`
- STATUS_NEXT 循环中 personal → todo
- 新建/编辑弹窗状态选项加「个人任务」
- 侧边栏 HTML5 拖拽逻辑

**后端**：无需改动（status 字段已是 TEXT，`personal` 直接存储）

**DB**：无需改动

---

### API 变更

新增 `PUT /api/tasks/reorder`：批量更新 sort_order，body: `[{ id, sort_order }]`

---

### 改动文件清单

| 文件 | 改动 |
|------|------|
| `routes/tasks.js` | 新增 PUT /api/tasks/reorder |
| `public/js/tasks.js` | STATUS_ORDER/LABEL/NEXT 更新；拖拽逻辑；新建弹窗状态选项 |
| `public/css/style.css` | 新增拖拽占位、高亮样式 |

---

## 十五、PWA Window Controls Overlay + Header 显示模式切换

> 日期：2026-07-21

### 目标

1. manifest 启用 `window-controls-overlay`，将 Header 内容（Logo + 用户信息）融入系统标题栏，节省 48px 垂直空间
2. 新增切换按钮，支持在「标题栏模式」和「页面内 Header 模式」之间切换，偏好持久化到 `localStorage`

---

### manifest 变更

```json
"display": "standalone",
"display_override": ["window-controls-overlay", "standalone"]
```

> `display_override` 优先于 `display`，浏览器按序选第一个支持的模式；不支持 overlay 的环境自动降级到 standalone，行为不变。

---

### CSS 适配（`style.css`）

使用 CSS 环境变量读取系统标题栏区域尺寸，仅在 overlay 模式下生效：

```css
@media (display-mode: window-controls-overlay) {
  .header {
    position: fixed;
    top: env(titlebar-area-y, 0);
    left: env(titlebar-area-x, 0);
    width: env(titlebar-area-width, 100%);
    height: env(titlebar-area-height, 48px);
    -webkit-app-region: drag;          /* 整个 header 可拖拽 */
    z-index: 1000;
  }
  /* 按钮、头像不可拖拽 */
  .header button,
  .header a,
  .header img,
  .header-mode-btn {
    -webkit-app-region: no-drag;
  }
  /* layout 顶部留出 header 高度 */
  .page-wrapper {
    padding-top: env(titlebar-area-height, 48px);
  }
}
```

---

### 切换按钮

**位置**：Header 右侧，登出按钮旁边

**图标**：
- 标题栏模式（当前是 overlay）：显示 `⊡`（收进标题栏）
- 页面模式（当前是页面内）：显示 `⊞`（展开到页面）

**逻辑**：
- 读/写 `localStorage('header-mode')`，值为 `'overlay'` 或 `'page'`
- `'page'` 模式：`<html>` 加 `class="header-page-mode"`，CSS 覆盖 overlay 媒体查询，强制 header 在页面内正常流布局
- `'overlay'` 模式：移除该 class，依赖 `@media (display-mode: window-controls-overlay)` 自动生效

---

### 改动文件清单

| 文件 | 改动 |
|------|------|
| `public/manifest.json` | 新增 `display_override` |
| `public/css/style.css` | 新增 `@media (display-mode: window-controls-overlay)` 适配；新增 `.header-page-mode` 覆盖样式 |
| `public/index.html` | header 新增切换按钮 |
| `public/js/app.js` | 初始化时读取 localStorage，绑定切换按钮逻辑 |

---

## 十八、左侧选中任务高亮增强

> 日期：2026-08-07

### 目标

增强左侧任务导航中当前选中任务的视觉识别度，不改变任务选择、拖拽和状态切换逻辑。

### 样式方案

- 选中项使用更明显的主题色浅背景，与普通 hover 状态区分
- 左侧强调条由 3px 增加为 4px，并使用主题链接色
- 选中项文字颜色提升为主文字色并加粗
- 增加轻微内阴影，保持现有圆角和列表布局不变
- 不修改未选中任务、任务状态圆点和交互行为

### 改动文件清单

| 文件 | 改动 |
|------|------|
| `public/css/style.css` | 增强 `.task-nav-item.active` 背景、文字、强调条和阴影样式 |

---

## 十九、未选中任务灰色蒙层

> 日期：2026-08-07

### 目标

在左侧任务列表中，对未选中的任务项追加一层透明灰色蒙层，使当前选中任务在视觉上更突出。

### 样式方案

- 未选中任务 `.task-nav-item:not(.active)` 整体 `opacity: 0.55`，呈现灰蒙效果
- hover 时 `opacity: 1` 恢复，保持原有 hover 背景不变
- 选中项 `.active` 维持上一节增强的高亮样式，不受影响
- 不改变布局、交互和 DOM 结构

### 改动文件清单

| 文件 | 改动 |
|------|------|
| `public/css/style.css` | 新增 `.task-nav-item:not(.active)` 透明度规则与 hover 恢复 |

### 风险与权衡

| 风险 | 处理 |
|------|------|
| 状态圆点 / 终端角标也被蒙层 | 整体降亮，但未选中状态下用户对状态需求不强；hover 即恢复 |
| 浅色主题下视觉过淡 | 0.55 在浅色/深色主题下均可读，必要时后续按主题分别调整 |



---

## 十七、终端 WebSocket 自动重连

> 日期：2026-08-05

### 背景

当前终端 WebSocket 断开后，仅在 xterm 中写入 `[连接已断开，切换任务可重新连接]`，需要用户手动「切走再切回」该任务的 shell tab 才能重新连接。在服务重启、网络抖动等场景下体验差。

### 目标

- ws 非主动断开时，自动按指数退避策略重连，无需用户干预
- 重连成功后复用原 xterm 实例，回放服务端历史 buffer（与现有「切换任务重连」体验一致）
- 用户切走任务 / 实例被显式销毁时，立即取消挂起的重连，避免悬挂 ws

### 重连策略

| 元素 | 取值 |
|------|------|
| 首次重连延迟 | 1s |
| 退避方式 | 指数退避 `delay = 1000 * 2^attempts` |
| 最大延迟 | 30s |
| 最大尝试次数 | 无上限（持续重试，直到 ws 成功或实例被销毁） |
| 触发时机 | `ws.onclose` 且实例未被显式销毁 |
| 取消时机 | 实例从 `termInstances` 中移除（`disposed = true`） |

### 状态机

```
ws.open(OPEN)  ── onclose ──►  scheduleReconnect(delay)
       ↑                            │
       │                            ↓ (delay 后)
       │                       connect() 新建 ws
       │                            │
       └──── onopen(成功) ──────────┘
                                    │
                              onclose(失败) ──► scheduleReconnect(delay*2)
```

### 实现要点

1. **实例字段扩展**：`termInstances.set(task.id, inst)` 中的 `inst` 新增：
   - `disposed: boolean` — 实例是否已被销毁
   - `reconnectTimer: number | null` — 挂起的重连定时器
   - `reconnectAttempts: number` — 已重连尝试次数（onopen 成功后清零）

2. **ws 生命周期与 terminal 解耦**：
   - `t.onData` / `t.onResize` 在 terminal 创建时设置一次，内部读 `inst.ws`，避免每次重连重复注册
   - `connect()` 只负责 ws 生命周期，可被多次调用

3. **重连前清屏 + 历史回放**：
   - `ws.onopen` 触发时若 `reconnectAttempts > 0`（即重连场景），先 `t.reset()` 清空当前内容
   - 服务端会在新 ws 上发送 `{ type: 'history', data }`，xterm 写入后即恢复历史
   - 重连成功后追加 `\x1b[32m[重新连接成功]\x1b[0m` 提示

4. **onclose 处理**：
   - 检查 `inst.disposed` 与 `termInstances.get(task.id) === inst`，避免销毁后的旧 ws 误触发重连
   - 写入 `\x1b[33m[连接已断开，{N}s 后自动重连...]\x1b[0m`（替换原「切换任务可重新连接」文案）
   - 计算退避延迟，设置 `reconnectTimer`，到点后调用 `connect()`

5. **onerror 静默化**：原本会写入 `[WebSocket 连接失败]`，现交由 `onclose` 统一处理，避免错误信息与重连提示重复

6. **实例销毁路径**：抽取 `disposeTerminalInstance(taskId)` 辅助函数，统一处理：
   - `inst.disposed = true`
   - `clearTimeout(inst.reconnectTimer)`
   - `inst.ws.close()`
   - `inst.term.dispose()`、`inst.el.remove()`
   - `termInstances.delete(taskId)`
   - 若当前 `termTaskId === taskId`，清空全局 `term`/`fitAddon`/`termWs`/`termTaskId`
   - `connectTerminal` 内的旧实例清理逻辑、未来可能的页面卸载逻辑均复用此函数

7. **后台任务同样自动重连**：当前未显示的 task ws 断开也会触发重连，用户切回时即可用，无需等待

### 改动文件清单

| 文件 | 改动 |
|------|------|
| `public/js/tasks.js` | `connectTerminal` 重构：抽出 `createTerminalInstance` 与 `disposeTerminalInstance`；ws 生命周期与 terminal 解耦；`onclose` 改为按指数退避调度 `connect()`；`onopen` 在重连场景下先 `t.reset()`；移除「切换任务可重新连接」固定文案 |

### 风险与权衡

| 风险 | 处理 |
|------|------|
| Session 失效导致重连失败 | 当前不区分失败原因，会持续按 30s 间隔重试。用户刷新页面即可重新登录。后续可在 ws close code 上区分 401 后停止重连并提示 |
| 重连时清屏丢失滚动历史 | 与现有「切换任务重连」体验一致（旧实例销毁、新实例回放历史 buffer），用户已习惯 |
| 后台多任务同时重连可能瞬时打爆服务端 | 退避策略天然分散重连时间；单用户场景下任务数有限，无显著压力 |

---

## 二十、任务内容多标签与待办清单

> 日期：2026-08-13

### 目标

- 将原「文档」标签改名为「技术方案」
- 增加 `README` 与 `AGENT.md` Markdown 预览标签
- 增加按任务隔离、由 SQLite 持久化的「待办」页面
- 保留现有终端标签及每个任务的标签记忆能力

### 标签与文件映射

| 标签 | 数据来源 |
|------|----------|
| 技术方案 | `task.md_path` |
| README | `task.work_dir/README.md`，无 `work_dir` 时取技术方案所在目录 |
| AGENT.md | `task.work_dir/AGENT.md`，无 `work_dir` 时取技术方案所在目录 |
| 待办 | SQLite `task_todos` 表 |
| 终端 | 现有 WebSocket PTY 会话 |

待办标签沿用完整文档工具栏，保留「打开文件夹 / VSCode 打开 / 分享」按钮与工具栏高度，避免切换标签时内容区上下跳动。

新建任务时始终保证三份文档存在：技术方案 `DESIGN.md`（`task.md_path`）、`README.md` 和 `AGENT.md`。只填标题时会创建任务目录及这三份标准文档；手动指定技术方案路径时，会保留用户指定的文件名，并在当前 Task 目录补齐缺失的 `README.md` 和 `AGENT.md`。已有文件一律保留，不做覆盖。已有任务的文件不存在时仍由页面提供显式创建按钮。

### 数据模型

```sql
CREATE TABLE IF NOT EXISTS task_todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  completed  INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

### API

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/tasks/:id/document/:kind` | 读取 `technical/readme/agent` 文档 |
| POST | `/api/tasks/:id/document/:kind` | 创建缺失的 `README.md` 或 `AGENT.md` |
| PUT | `/api/tasks/:id/document/:kind` | 保存 `technical/readme/agent` Markdown 内容 |
| GET | `/api/tasks/:id/todos` | 获取任务待办 |
| POST | `/api/tasks/:id/todos` | 新增待办 |
| PUT | `/api/tasks/:id/todos/:todoId` | 更新内容或完成状态 |
| DELETE | `/api/tasks/:id/todos/:todoId` | 删除待办 |

### Markdown 在线编辑

- 技术方案、`README.md` 和 `AGENT.md` 工具栏增加「编辑」按钮
- 使用 Microsoft 官方 Monaco Editor（VS Code 同源编辑器），采用 VS Code 明亮主题、Markdown 语法高亮、行号、自动补全括号和软换行
- 使用 Monaco 原生 VS Code 快捷键、搜索/替换面板、多光标和列选择，仅额外绑定 `Cmd/Ctrl+S` 到应用的 Markdown 保存接口
- Monaco 0.56.0 以 ESM 包为源，通过 esbuild 构建后本地托管主线程与 worker 资源，避免 CDN 与 worker 跨域问题
- 文档修改未保存时，切换任务或标签前会要求确认
- 新增 `PUT /api/tasks/:id/document/:kind`，经过任务归属校验后写入对应 Markdown，单文档限制 5MB

所有接口先按当前登录用户校验任务归属。

---

## 二十一、检查更新与远程服务任务

> 日期：2026-08-14
> 状态：仅设计，尚未实现

### 1. 背景与目标

当前应用只管理本机 SQLite 中的任务和本机文件。新方案希望增加：

1. **GitHub 版本检查**：后台定时读取服务端固定的 GitHub `VERSION.json` 链接，比较本地与远端版本，发现更高版本时弹窗提醒。
2. **连接对等实例**：每个 torin-x-web 启动后既是本地客户端，也是可被其他实例连接的远程服务端。
3. **统一任务导航**：左侧栏明确分为「本地任务」和「远程服务」，远程服务下再显示其任务。
4. **保持数据边界**：本地任务仍使用本地 DB/文件；远程任务的 DB、文档和终端始终由对应远程服务管理。

### 2. 范围与非目标

#### 本期设计范围

- 通过 URL、端口和 Token 配置多个对等服务实例，支持连接测试、启用/停用和移除
- 远程任务列表、技术方案、README、AGENT.md 和待办清单
- 远程任务的新建、编辑、状态流转和删除
- 定时查询 GitHub 版本链接、手动立即检查、新版弹窗与经确认后更新本地服务

#### 暂不纳入首期

- 本地与远程任务的自动双向同步或合并
- 离线修改远程任务后再回传
- 跨服务器拖拽迁移任务
- 无人确认的自动更新；每次更新都需用户在弹窗中确认
- 第三方任务平台（GitHub Issues、Linear、Jira 等）

### 3. 核心原则

1. **浏览器不直连远程**：所有远程请求都由本地 Express 代理，避免 CORS，也不把远程 Token 暴露给前端。
2. **不复制为本地任务**：远程任务是实时访问的远程资源，不写入本地 `tasks` 表。
3. **显式标识来源**：任务标识必须是 `(source, serverId, taskId)`，不能只用数字 `id`。
4. **Token 决定权限**：连接表单不重复设置权限，实际能力由远程 Token scope 和服务端开关决定。
5. **查询自动、更新手动**：读取固定 GitHub 版本链接可定时自动执行；Git fetch、修改本地代码、安装依赖、迁移 DB 和重启必须经用户确认。
6. **对等角色对称**：同一套程序同时挂载本地 Session API 和 Token 鉴权的 remote API，不存在单独的「客户端版」或「服务端版」。

### 4. 左侧栏信息架构

```text
左侧任务栏
├─ 本地任务                         [ + ]
│  ├─ 个人任务
│  ├─ 进行中
│  ├─ 待办
│  └─ 已完成
└─ 远程服务                         [ + 连接 ]
   ├─ ● 家中 Mac                         [ ⋯ ]
   │  ├─ 个人任务
   │  ├─ 进行中
   │  ├─ 待办
   │  └─ 已完成
   └─ ○ 办公室服务器（离线）           [ 重试 ]
```

#### 展示约定

- 一级区域「本地任务」和「远程服务」可折叠，折叠状态按用户保存。
- 每个远程服务显示连接状态：在线、检测中、离线、认证失效、版本不兼容。
- 远程任务条目显示云端标识，tooltip 显示服务器名称。
- 「新建任务」按钮作用于当前选中的任务源；若未选中远程服务，默认在本地创建。
- 跨本地/远程或跨服务器拖拽在首期禁止，光标显示不可放置。
- 远程服务暂时不可用时，保留最后一次任务列表快照，但整组置灰并标记「非实时」。

### 5. 连接远程服务流程

#### 连接表单

| 字段 | 说明 |
|------|------|
| URL | 主机或域名，例如 `https://tasks.example.com` 或 `http://192.168.1.20` |
| 端口 | 远程 torin-x-web 监听端口，例如 `14002` |
| Token | 远程实例签发的访问 Token，仅在新增或更换时输入 |

用户只需提供以上三项。服务器显示名称由 `/capabilities` 返回的 `instance_name`、主机名或 URL 自动生成，用户可在连接成功后可选修改别名。可读/可写/终端能力不在表单中单独选择，以 Token scope 为准。

#### 连接测试

```text
用户填写 URL + 端口 + Token
    ↓
本地实例组装并校验 base URL
    ↓
GET <remote>/api/remote/v1/capabilities
Authorization: Bearer <token>
    ↓
校验服务身份、API 版本、Token scope
    ↓
保存连接 → 首次加载任务快照
```

连接失败时不保存明文 Token，只返回可操作的错误分类：DNS/超时、TLS 失败、401 Token 无效、403 scope 不足、API 版本不兼容。

### 6. 系统架构

每个运行中的 torin-x-web 实例都同时具备两种角色：

- **客户端角色**：用当前浏览器 Session 管理本地任务，并使用保存的 Token 连接其他实例。
- **远程服务端角色**：监听同一 URL/端口，对其他实例提供 `/api/remote/v1/*` Token API。

```text
实例 A（浏览器当前打开）
  ├─ Web UI + Session API ──► A 的 SQLite / 文件 / PTY
  ├─ Remote Client ── Token ──────────┐
  └─ Remote Server `/api/remote/v1/*`        │
                                                ▼
实例 B
  ├─ Web UI + Session API ──► B 的 SQLite / 文件 / PTY
  ├─ Remote Client
  └─ Remote Server `/api/remote/v1/*` ◄──┘
```

A 可连 B，B 也可反向连 A；两个连接的 Token 与权限相互独立。请求不继续级联转发，从 A 访问 B 时只能看到 B 的本地任务，不会再暴露 B 已连接的 C 实例，避免环路与权限扩散。

#### 为什么不让前端直连远程

- Token 不进入 `localStorage`、DOM 或浏览器请求日志。
- 不需要在远程服务开放 CORS。
- 本地后端可统一实现超时、服务器身份验证和错误脱敏。
- 前端只处理统一的本地/remote task view model。

### 7. 本地数据模型

#### `remote_servers`

```sql
CREATE TABLE remote_servers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             TEXT NOT NULL,
  name                TEXT NOT NULL,
  base_url            TEXT NOT NULL,
  port                INTEGER NOT NULL,
  token_ciphertext    TEXT NOT NULL,
  token_iv            TEXT NOT NULL,
  token_auth_tag      TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  remote_instance_id  TEXT,
  api_version         TEXT,
  remote_app_version  TEXT,
  last_status         TEXT NOT NULL DEFAULT 'unknown',
  last_error_code     TEXT,
  last_checked_at     DATETIME,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, base_url, port)
);
```

Token 使用 AES-256-GCM 加密，密钥从独立的 `REMOTE_CREDENTIALS_KEY` 环境变量获取，不复用 `SESSION_SECRET`。API 返回连接配置时永不返回 Token 或密文字段。

#### `remote_task_snapshots`

```sql
CREATE TABLE remote_task_snapshots (
  server_id       INTEGER NOT NULL,
  remote_task_id  TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  remote_revision TEXT,
  fetched_at      DATETIME NOT NULL,
  PRIMARY KEY (server_id, remote_task_id),
  FOREIGN KEY (server_id) REFERENCES remote_servers(id) ON DELETE CASCADE
);
```

快照只用于离线展示任务列表，不作为可编辑的离线副本。默认不缓存 Markdown 全文、终端历史和 Token。

#### GitHub 版本检查状态

更新状态是实例级而不是用户级，因为所有登录用户共享同一份服务代码。状态可存在单例 `system_state` 表或独立 JSON：

```text
github_version_url     https URL       # 固定的 GitHub VERSION.json 链接
git_remote             origin          # 仅在确认更新后使用
git_branch             main            # 仅在确认更新后使用
update_check_interval  1800            # 默认 30 分钟
update_last_checked_at datetime
update_local_version   semver
update_remote_version  semver
update_manifest_etag   text
update_manifest_mtime  text             # GitHub Last-Modified
update_status          idle | checking | current | available | local_newer | blocked | updating | failed
update_error           safe error code
update_notice_version  semver           # 已弹窗的远程版本
```

### 8. 远程服务 API 协议

新建独立的版本化命名空间 `/api/remote/v1`，不直接暴露现有 Session API。

#### 接口概览

| Method | 路径 | Scope | 说明 |
|--------|------|-------|------|
| GET | `/api/remote/v1/capabilities` | `server:read` | 实例 ID、应用/API 版本、功能与 scope |
| GET | `/api/remote/v1/tasks` | `tasks:read` | 远程任务列表，支持 `updated_since` |
| POST | `/api/remote/v1/tasks` | `tasks:write` | 新建远程任务 |
| GET | `/api/remote/v1/tasks/:id` | `tasks:read` | 任务详情与 revision |
| PUT | `/api/remote/v1/tasks/:id` | `tasks:write` | 更新任务，需带 revision |
| DELETE | `/api/remote/v1/tasks/:id` | `tasks:write` | 删除远程任务 |
| GET/PUT | `/api/remote/v1/tasks/:id/documents/:kind` | `docs:read/write` | `technical/readme/agent` 文档 |
| GET/POST/PUT/DELETE | `/api/remote/v1/tasks/:id/todos...` | `todos:read/write` | 待办 CRUD |
| WS | `/api/remote/v1/tasks/:id/terminal` | `terminal` | 远程 PTY，需单独开启 |

#### 任务视图模型

前端将本地和远程任务规范化为：

```json
{
  "key": "remote:12:task:87",
  "source": "remote",
  "server_id": 12,
  "server_name": "家中 Mac",
  "id": "87",
  "title": "Example",
  "status": "doing",
  "priority": "normal",
  "due_date": null,
  "capabilities": {
    "write": true,
    "documents": true,
    "todos": true,
    "terminal": false
  },
  "revision": "2026-08-14T09:20:11.123Z:4",
  "stale": false
}
```

### 9. 本地代理 API

前端只调用本地接口：

| Method | 路径 | 说明 |
|--------|------|------|
| GET/POST | `/api/remote-servers` | 列表 / 新增连接 |
| PUT/DELETE | `/api/remote-servers/:id` | 使用已保存 Token 验证新地址后修改 / 移除连接 |
| POST | `/api/remote-servers/test` | 保存前测试连接 |
| POST | `/api/remote-servers/:id/test` | 使用已保存 Token 测试待修改的新地址 |
| POST | `/api/remote-servers/:id/check` | 重新检查指定服务 |
| GET | `/api/remote-servers/:id/tasks` | 通过本地代理获取远程任务 |
| `*` | `/api/remote-servers/:id/tasks/:taskId/...` | 代理任务、文档和待办操作 |
| GET | `/api/system/version` | 当前 app/API/schema 版本和 Git commit |
| GET | `/api/system/update-status` | 最近 GitHub 版本检查结果与更新进度 |
| POST | `/api/system/check-update` | 立即请求固定的 GitHub 版本链接并比较版本 |
| POST | `/api/system/apply-update` | 确认后更新本地服务，完成后触发受控重启 |

`check-update` 可对普通已登录用户开放，`apply-update` 必须要求实例管理员权限和二次确认，防止任意注册用户重启整个服务。

代理必须实现：

- 只允许请求 DB 中已配置的 `base_url`，禁止前端传入任意目标 URL。
- 连接与读超时，请求取消，有上限的重试与指数退避。
- 过滤 hop-by-hop header，不透传 Cookie、本地 Session 和内部错误堆栈。
- 限制返回体与 Markdown 大小，防止远程服务耗尽内存。
- 防止 SSRF：解析后地址、重定向目标和 DNS rebinding 都要重新校验；访问私网地址需要用户显式启用。

### 10. 远程鉴权与 Token 管理

远程服务不复用浏览器 Session，增加 Personal Access Token：

```text
Token 格式：txw_<public-id>_<secret>
DB 只保存 secret 的 scrypt/Argon2id hash
Token scope：
  server:read
  tasks:read | tasks:write
  docs:read  | docs:write
  todos:read | todos:write
  terminal
```

管理要求：

- Token 只在创建时显示一次，可设过期时间、名称并随时撤销。
- 每次请求记录 Token ID、用户、scope、目标资源和结果，不记录 secret 或文档全文。
- 连接名与 Token 所属用户绑定，不允许访问远程其他用户的任务。
- 终端 scope 默认不授予，并且远程服务器可全局禁用 Remote PTY。

### 11. 并发与冲突处理

- 远程 task/document 返回 `revision` 或 `ETag`。
- 更新时本地代理传递 `If-Match`/revision。
- 远程内容已变更时返回 `409 Conflict` 或 `412 Precondition Failed`。
- 前端不直接覆盖，对 Markdown 显示「重新加载 / 复制本地修改 / 查看差异」。
- 待办按单条 ID 和 `updated_at` 冲突检测。

### 12. 远程终端方案

远程终端的风险高于任务读写，建议放在第三阶段：

```text
浏览器 xterm
  ↔ 本地 WebSocket /terminal/remote/:serverId/:taskId
  ↔ 远程 WSS /api/remote/v1/tasks/:id/terminal
  ↔ 远程 PTY
```

- 本地服务仅做双向字节流代理，Token 不下发到浏览器。
- 不在本地 SQLite 持久化远程终端输出，历史由远程管理。
- 心跳、消息大小、并发会话数和空闲时间必须限制。
- 断线重连时需用 `(serverId, taskId)` 区分会话，不与本地任务 ID 混用。

### 13. 检查更新设计

#### 版本信息

仓库根目录新增 `VERSION.json`，作为应用版本和协议兼容性的唯一发布信息源。`package.json.version` 在发布流程中与 `VERSION.json.app_version` 保持一致，但运行时以 `VERSION.json` 为准。

```json
{
  "app_version": "1.0.0",
  "api_version": 1,
  "schema_version": 1,
  "min_remote_api_version": 1,
  "max_remote_api_version": 1,
  "published_at": "2026-08-14T12:00:00Z",
  "release_url": "https://github.com/owner/repository/releases/tag/v1.0.0"
}
```

字段说明：

| 版本 | 用途 |
|------|------|
| `app_version` | 应用发布版本，语义化版本，例如 `1.4.0` |
| `api_version` | 远程 API 协议版本，例如 `1` |
| `schema_version` | SQLite 迁移版本，例如 `7` |
| `min_remote_api_version` | 当前客户端可连接的最低远程 API 版本 |
| `max_remote_api_version` | 当前客户端可连接的最高远程 API 版本 |
| `published_at` | 可选，版本发布时间，用于界面展示 |
| `release_url` | 可选，对应 GitHub Release 页面，用于查看发布说明 |

`GET /api/system/version` 返回当前版本、构建 commit、构建时间和支持的 remote API 版本范围。

#### 本地与 GitHub 版本比较

定时检查不执行 `git fetch`。本地读取部署目录根部的版本文件，远端通过服务端配置的固定 GitHub HTTPS 链接读取：

```text
本地版本：读取工作区根目录 VERSION.json
远程版本：GET https://raw.githubusercontent.com/<owner>/<repository>/<branch>/VERSION.json
```

也允许使用 GitHub Contents API 的固定地址，但同一实例只能配置一个受信版本源。该地址由部署配置或环境变量提供，前端只读展示，任何检查接口都不能接收临时 URL。公开仓库优先使用 Raw 链接；私有仓库如需 GitHub Token，只能从服务端环境读取且日志必须脱敏。

判定规则：

| 条件 | 结果 |
|------|------|
| `remote.app_version > local.app_version` | 有可用更新，弹窗提醒 |
| `remote.app_version = local.app_version` | 版本已是最新，不弹出更新提醒 |
| `remote.app_version < local.app_version` | 本地版本较新，不允许降级 |
| 本地或远端 `VERSION.json` 不存在/无效 | 更新检查失败，不允许更新 |
| 远程版本更高 | 显示可用版本；用户点击更新后再执行 Git 安全预检 |

`app_version` 必须使用严格 SemVer，通过 semver 库比较，不进行字符串比较。`api_version` 和 `schema_version` 不用于判断「是否有新版」，但在更新预检阶段用于兼容性和迁移检查。

定时检查只以 GitHub `VERSION.json.app_version` 为准，不尝试发现版本号未提升的提交。因此发布流程必须保证可发布代码合入目标分支前先提升版本号。

#### GitHub 版本源与定时查询

当前实例使用固定的 GitHub `VERSION.json` 链接检查更新。版本链接以及实际更新使用的 Git remote/branch 都由服务端配置，前端不能传入任意 URL、remote、branch 或命令。

```text
定时器触发（默认每 30 分钟）
    ↓
读取本地 VERSION.json
    ↓
携带 If-None-Match / If-Modified-Since
GET <configured-github-version-url>
    ↓
使用 semver 比较 app_version
    ↓
远程版本更高
  → 通知前端；更新能力待用户确认后预检
远程版本相同
  → 无正式更新
```

- 定时检查只发起只读 HTTPS 请求并读取本地版本文件，不调用 Git、不修改工作区。
- 启动后延迟 30 秒做首次检查，之后默认每 30 分钟一次，可配置为 5 分钟至 24 小时。
- 同一时刻只能有一个检查进程；手动检查会复用正在执行的任务。
- HTTP 请求默认 10 秒超时、响应体上限 16 KiB；只允许 HTTPS 和服务端允许列表中的 GitHub 域名，重定向后再次校验目标。
- 使用 ETag/`If-None-Match` 和 Last-Modified/`If-Modified-Since`，GitHub 返回 `304` 时复用上次校验通过的远端版本。
- 对响应执行 JSON schema、严格 SemVer 和字段长度校验；错误只保存安全错误码，不记录凭据或完整响应。
- 记录本地/远程版本、版本链接、发布时间、Release 链接和上次检查时间，不在定时检查阶段计算 commit 差异。

#### 应用更新流程

用户点击「立即更新」后，服务端按以下流程执行：

```text
获取全局 update lock
    ↓
重新请求 GitHub VERSION.json，确认远程版本仍然更高
    ↓
git fetch --prune <configured-remote> <configured-branch>
    ↓
预检：目标分支 VERSION.json 与 GitHub 检查结果一致、Git 仓库、remote/branch、工作区清洁、只存在 fast-forward 路径
    ↓
记录 previous_commit
    ↓
git merge --ff-only <remote>/<branch>
    ↓
npm ci
    ↓
npm run build:monaco
    ↓
运行 DB migration 与快速自检
    ↓
写入 restart marker，向守护进程请求受控重启
```

强制预检规则：

- fetch 后必须校验 `<remote>/<branch>` 中的 `VERSION.json.app_version` 等于刚从 GitHub 链接取得的版本；不一致时阻断更新，避免缓存、分支或版本链接配置错误。
- `git status --porcelain` 非空时禁止更新，弹窗提示「本地有未提交修改」，不自动 stash、reset 或丢弃文件。
- 当前分支 ahead 或 diverged 时禁止更新，不自动 rebase/merge。
- 更新过程不允许并行写 DB schema，需要维护状态和全局锁。
- npm/build/migration/self-check 任一失败时不自动启动新版；保留 `previous_commit` 与日志，向用户显示恢复指引。
- 数据库迁移在更新前创建带时间戳的 SQLite backup；回滚代码不等于自动回滚 DB，因此 schema migration 必须尽量向后兼容。
- 重启不依赖旧 Node 进程「自己重启自己」，由 LaunchAgent/systemd/PM2 等守护方式重新拉起。

#### UI 交互

- 设置弹窗增加「检查更新」：只读的 GitHub 版本链接、本地/远程 `app_version`、发布时间、Release 链接、检查间隔、上次检查时间和「立即检查」。
- 定时查询发现更高的远程 `app_version` 后，对每个远程版本只弹窗一次，同时保留设置按钮小蓝点。
- 弹窗展示本地→远程版本、发布时间和发布说明入口，按钮为「稍后提醒」和「立即更新」；Git 分支、工作区和 fast-forward 状态在点击「立即更新」后的预检阶段展示。
- 点击「立即更新」前再次明确确认；更新期间显示阶段与日志摘要，前端轮询 update status。
- 非管理员用户只收到「有新版本，请联系管理员」提示，不显示「立即更新」按钮。
- 服务重启期间页面显示「正在重启」并定时请求健康接口；新进程就绪后自动刷新。
- 结果状态：已是最新、可更新、本地有修改、分支已分叉、检查失败、更新失败、重启中、更新完成。

#### 版本发布规则

- 每次准备向跟踪分支发布可更新版本时，必须先提升 `VERSION.json.app_version`。
- 需要改变 remote API 协议时提升 `api_version`，并同步维护最小/最大兼容版本。
- 包含 SQLite schema 变更时提升 `schema_version`，并提供对应的有序 migration。
- CI/发布检查验证 `VERSION.json` schema、SemVer 合法性、`package.json.version` 一致性，以及当代码发布时版本号确已提升。

### 14. 缓存、刷新与故障降级

- 展开远程服务时加载任务；已展开服务每 60 秒轻量刷新，页面不可见时暂停。
- 用户可点击服务器旁的刷新按钮立即重试。
- 远程返回 429 或 5xx 时指数退避，不对写请求自动重试。
- 快照 TTL 建议为 7 天；超过 TTL 只显示服务器离线，不再展示旧任务。
- 选中的远程任务断线时，已加载内容保留为只读，页面顶部显示「连接已断开」。

### 15. 安全要求

| 风险 | 设计措施 |
|------|----------|
| SSRF | 目标 URL 白名单化；DNS/重定向二次校验；私网需显式开启 |
| Token 泄漏 | 后端加密保存；不返回前端；日志脱敏 |
| 中间人 | 生产强制 HTTPS；不提供「忽略 TLS 错误」选项 |
| 越权 | PAT 绑定用户与 scope；远程再次校验任务归属 |
| 写冲突 | revision/ETag + `If-Match`，不静默覆盖 |
| 恶意远程响应 | 大小/超时限制；字段 schema 校验；Markdown 渲染前清洗 |
| 远程 PTY 滥用 | 独立 scope、全局开关、会话限制与审计日志 |
| 恶意版本链接或响应 | URL 由服务端固定；仅允许 HTTPS 与受信 GitHub 域名；重定向复检；限制超时/大小；严格校验 JSON schema |
| 恶意 Git 更新 | remote/branch 由服务端固定；只允许 fast-forward；更新需人工确认；可选校验签名 commit/tag |
| 更新覆盖本地修改 | 工作区非空立即阻断，不自动 stash/reset/rebase |
| 更新后无法启动 | 依赖/构建/迁移/自检分阶段状态；SQLite 备份；记录 previous commit；守护进程负责重启 |

### 16. 性能与可观测性

- 单个远程请求默认 8 秒超时，文档请求 15 秒，超时值有安全上限。
- 服务器状态检查可并行，但设置全局并发上限，避免应用启动时同时压测多个远程。
- 记录 `server_id`、路由、耗时、状态码和错误分类，不记录 Token、密码、终端内容和 Markdown 全文。
- 连接管理页显示最近检查时间与上次错误类型，便于自助诊断。

### 17. 分阶段实施计划

#### Phase 1：对等服务协议与只读远程任务

1. 引入 app/api/schema 版本和 SQLite 迁移机制。
2. 实现 PAT 与 `/api/remote/v1/capabilities`。
3. 使每个实例同时启用 Remote Client/Server，实现 URL + 端口 + Token 连接、加密存储和测试。
4. 左侧栏增加本地/远程分区。
5. 只读加载远程任务、三份 Markdown 和待办。
6. 实现快照与离线降级。

#### Phase 2：GitHub 版本检查与受控更新

1. 新增并校验 `VERSION.json`，定时请求固定 GitHub 链接、比较 SemVer，并实现 ETag 缓存与单例锁。
2. 新版本弹窗、稍后提醒、手动检查和 update status 轮询。
3. 工作区/分叉/fast-forward 预检、SQLite 备份和受控更新 pipeline。
4. 与 LaunchAgent/systemd/PM2 约定重启和新进程健康检查。

#### Phase 3：远程写操作与终端

1. 任务、Markdown 和待办读写 scope，revision/ETag 冲突处理。
2. 独立 terminal scope 与服务端总开关。
3. WebSocket 双向代理、限流、审计、断线重连与端到端测试。

### 18. 验收标准

#### 远程连接

- 可添加多个远程服务，并清晰区分在线、离线、认证失效和不兼容。
- 浏览器网络、DOM、localStorage 和前端错误中均不出现远程 Token。
- 左侧栏本地任务行为不受远程服务故障影响。
- 远程离线时可查看未过期快照，但不能编辑。
- 不能将本地任务拖入远程，也不能跨远程服务器排序。

#### 检查更新

- 定时检查通过固定 GitHub 链接读取 `VERSION.json.app_version`，并正确判断已是最新、有新版、本地较新和检查失败。
- 同一远程版本只弹窗一次，更高版本到达后可再次提醒。
- GitHub 超时、非受信重定向、超限响应、非法 JSON 或非法 SemVer 均安全失败，不进入更新流程。
- 用户确认更新后，只有 Git 目标分支版本与 GitHub 版本一致且可 fast-forward 时才继续。
- 工作区有修改或分支分叉时，更新被阻断且不丢弃任何文件。
- 用户确认后可完成 fast-forward、依赖、构建、迁移、自检和受控重启。
- 任一阶段失败都有明确状态和恢复信息，新版未通过自检时不对外提供服务。

### 19. 待确认决策

| 决策项 | 推荐默认 | 备选 |
|--------|----------|------|
| 远程服务类型 | 只支持 torin-x-web 实例 | 抽象第三方 provider，复杂度显著增加 |
| 连接表单 | URL + 端口 + Token | 额外显示名、权限选项（不必要） |
| 首期远程权限 | Token 允许什么就展示什么，Phase 1 UI 仍只读 | 首期直接开放读写 |
| 远程终端 | Phase 3 单独开发 | 与远程任务首期同时开放 |
| 版本文件 | 根目录 `VERSION.json`，运行时唯一版本源 | 仅使用 `package.json.version`，无法同时表达 API/schema 兼容性 |
| 远端版本来源 | 服务端固定的 GitHub Raw `VERSION.json` 链接 | GitHub Contents API 固定链接，适合私有仓库鉴权 |
| Git 更新目标 | 当前分支跟踪的 `origin/main` | 环境变量配置 remote/branch |
| 检查间隔 | 启动 30 秒后首次，之后每 30 分钟 | 5 分钟至 24 小时可配置 |
| 更新行为 | 弹窗确认后执行完整 pipeline 并重启 | 只提示、由用户手动运行命令 |
| 私网 HTTP | 仅开发模式允许 | 连接配置中经高风险确认启用 |

### 20. 预计改动范围（实施阶段）

| 区域 | 预计改动 |
|------|----------|
| DB | schema migration、`remote_servers`、`remote_task_snapshots`、PAT 与用户设置 |
| Server | 每个实例同时启用 remote client/server、本地 proxy、凭据加密、Git scheduler/update pipeline |
| Frontend | 左侧树形任务源、连接管理、统一 task key、远程错误/冲突 UI |
| Terminal | 远程 WebSocket 代理与权限隔离（Phase 3） |
| Release | `VERSION.json`、app/api/schema 版本、Git remote/branch 规范、migration、守护重启约定 |
| Tests | 版本文件 schema/SemVer、本地/远程版本比较、协议契约、SSRF/Token 泄漏、Git behind/ahead/diverged、脏工作区、pipeline 失败与重启 |
