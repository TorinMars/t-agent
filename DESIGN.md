# 个人主页设计文档

> 日期：2026-07-15

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
