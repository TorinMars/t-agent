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
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Schema 10: when the task was archived (ISO 8601 UTC); NULL while it is in use. See services/task-archive.js.
  archived_at TEXT
);

-- Task groups. doing/todo/done are system groups that cannot be modified; other groups are managed by users.
-- tasks.status stores the group_key, for compatibility with existing task data.
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
  group_name TEXT    NOT NULL DEFAULT 'Default',
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

-- Engine authorization and pairing data. The Engine only stores token hashes; the plaintext is returned once at creation.
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

-- The default terminal has no task_terminals row, so its (renamed) title is kept here.
CREATE TABLE IF NOT EXISTS task_default_terminal_titles (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL
);

-- A task whose default terminal was deleted, or that was made without one (lib/task-default-terminal.js), has a row here; the default terminal is then not listed or connectable.
CREATE TABLE IF NOT EXISTS task_default_terminal_removed (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE
);

-- The directory the default terminal keeps (schema 8): written the first time its shell starts. Without a row it follows the task's work_dir.
CREATE TABLE IF NOT EXISTS task_default_terminal_dirs (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  work_dir TEXT NOT NULL
);

-- work_dir (added by the column migration in db/index.js, schema 8): the directory the terminal was created in; NULL follows the task.
CREATE TABLE IF NOT EXISTS task_terminals (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  terminal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, terminal_id)
);

-- Chat-style Claude / Codex conversations of a task. session_id is the agent's own session (set once the first turn starts, or when an existing one is resumed).
CREATE TABLE IF NOT EXISTS agent_conversations (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  session_id TEXT,
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  -- When the chat was opened (ms) on the desktop page / the phone page, NULL when it is not open there. The desktop shows every open chat
  -- as a tab, the phone one at a time; each page restores its own.
  opened_web INTEGER,
  opened_h5 INTEGER,
  -- The state of the chat's translation switch (1 = on): each chat keeps its own.
  translate INTEGER,
  collapse_keyboard INTEGER, -- NULL: the default (on)
  -- The messages the person queued while the agent works, as JSON ([{ id, label, body }]), kept so a refresh does not lose them. NULL / empty: none.
  queue TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_task ON agent_conversations (task_id, updated_at);

-- App list: manually registered, self-registered by programs (API), and auto-registered PM2 processes.
-- pm2_name links to a PM2 process name; when a row with source=pm2 is deleted by the user it is only hidden (hidden=1), so the next sync does not auto-register it again.
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  source TEXT NOT NULL DEFAULT 'manual',
  pm2_name TEXT UNIQUE,
  port INTEGER,
  host TEXT,
  domain TEXT,
  scheme TEXT NOT NULL DEFAULT 'http',
  path TEXT NOT NULL DEFAULT '/',
  url TEXT,
  description TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Records of cleaned local repo directories: the task directory and task are kept; after a repo directory is deleted it can be restored from the repo address, branch and commit.
-- One task directory can hold several repos, so records are keyed by repo path.
CREATE TABLE IF NOT EXISTS repo_cleanups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL,
  path       TEXT NOT NULL UNIQUE,
  remote     TEXT NOT NULL,
  branch     TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  cleaned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- T-Attention (schema 9): one central list of work items that agents, services and the person create and update (services/attention.js,
-- routes/attention.js). Self-contained: it does not refer to tasks, terminals or chats; link_url may point at a page. Times are ISO 8601 UTC text.
CREATE TABLE IF NOT EXISTS attention_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT    NOT NULL,
  notes            TEXT,
  status           TEXT    NOT NULL DEFAULT 'todo',  -- todo | working | waiting_user | review | done | failed | cancelled
  priority         TEXT    NOT NULL DEFAULT 'none',  -- high | medium | low | none
  due_date         TEXT,                             -- YYYY-MM-DD
  source           TEXT    NOT NULL DEFAULT 'user',  -- listener name ('claude'), 'cli' or 'user'
  external_ref     TEXT    UNIQUE,                   -- the caller's own key, e.g. 'claude:<session_id>'
  attention_reason TEXT,                             -- why it needs the person
  link_url         TEXT,                             -- http(s) or a page path starting with '/'
  link_label       TEXT,
  meta             TEXT,                             -- a JSON object of at most 8 KiB
  context          TEXT,                             -- recall card: JSON object of at most 32 KiB (goal, last_reply, pending, files, summary, ...)
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  completed_at     TEXT                              -- set while the status is done / failed / cancelled
);
CREATE INDEX IF NOT EXISTS idx_attention_items_status ON attention_items (status, sort_order);

-- History of an item, written in the same transaction as the change. data: the changed fields as JSON. A deleted item takes its events with it.
CREATE TABLE IF NOT EXISTS attention_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES attention_items(id) ON DELETE CASCADE,
  at          TEXT    NOT NULL,
  actor       TEXT    NOT NULL,  -- 'user', 'cli', a token name or a listener name
  type        TEXT    NOT NULL,  -- created | updated | status | activity (timeline: data {kind, text}); deleted is published only
  from_status TEXT,
  to_status   TEXT,
  data        TEXT
);
CREATE INDEX IF NOT EXISTS idx_attention_events_item ON attention_events (item_id, id);

-- Bearer tokens ('tatt_...') for the CLI and listener plugins: only the sha256 hash is stored, the token is shown once. They reach /api/attention* only.
CREATE TABLE IF NOT EXISTS attention_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  scopes       TEXT   -- extra permissions, space separated: 'market' = "Can manage plugins" (/api/attention/market); NULL = none
);
