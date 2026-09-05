CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'todo',
  priority   TEXT    NOT NULL DEFAULT 'normal',
  due_date   TEXT,
  md_path    TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 任务分组。doing/todo/done 是不可修改的系统分组；其他分组由用户管理。
-- tasks.status 保存 group_key，以兼容已有任务数据。
CREATE TABLE IF NOT EXISTS task_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   TEXT    NOT NULL,
  group_key  TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system  INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id, group_key),
  UNIQUE(owner_id, name)
);

CREATE INDEX IF NOT EXISTS idx_task_groups_owner
  ON task_groups(owner_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  icon       TEXT,
  group_name TEXT    NOT NULL DEFAULT '默认',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE INDEX IF NOT EXISTS idx_task_todos_task_id
  ON task_todos(task_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS system_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS remote_access_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT 'tasks:read',
  last_used_at DATETIME,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at  DATETIME
);

CREATE TABLE IF NOT EXISTS remote_servers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  token_cipher  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'unknown',
  remote_version TEXT,
  last_checked_at DATETIME,
  last_error    TEXT,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id, base_url)
);

CREATE INDEX IF NOT EXISTS idx_remote_servers_owner ON remote_servers(owner_id, created_at);

-- Engine 授权与配对数据。Engine 只保存 Token 哈希，明文只在创建时返回一次。
CREATE TABLE IF NOT EXISTS engine_access_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT    NOT NULL DEFAULT 'engine',
  name         TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  token_prefix TEXT    NOT NULL,
  role         TEXT    NOT NULL DEFAULT 'operator',
  scopes       TEXT    NOT NULL,
  last_used_at DATETIME,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at   DATETIME
);

CREATE TABLE IF NOT EXISTS engine_pairing_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT    NOT NULL DEFAULT 'engine',
  code_hash    TEXT    NOT NULL UNIQUE,
  code_prefix  TEXT    NOT NULL,
  role         TEXT    NOT NULL DEFAULT 'operator',
  expires_at   DATETIME NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at  DATETIME
);

CREATE TABLE IF NOT EXISTS engine_identity (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
