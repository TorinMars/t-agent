CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'todo',
  priority   TEXT    NOT NULL DEFAULT 'normal',
  due_date   TEXT,
  md_path    TEXT,
  technical_path TEXT,
  readme_path TEXT,
  agent_path TEXT,
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

-- Additional terminals retain the original terminal_logs table for the default shell.
CREATE TABLE IF NOT EXISTS task_terminals (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  terminal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  buffer TEXT NOT NULL DEFAULT '',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, terminal_id)
);
