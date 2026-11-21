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
  sort_order       INTEGER NOT NULL DEFAULT 0,       -- display order inside a status group, highest first (ties: higher id first)
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  completed_at     TEXT,                             -- set while the status is done / failed / cancelled
  -- Schema 11 (db/index.js adds them to an older database, and makes the index on parent_id there and in services/attention.js, because
  -- this file runs before the columns exist on an older database):
  parent_id        INTEGER REFERENCES attention_items(id),  -- the parent item or NULL, an item with children cannot be deleted
  custom_status    TEXT,                             -- free one-line text beside the status (at most 100), e.g. 'Blocked'
  result           TEXT,                             -- one-line outcome (at most 500)
  -- Schema 18, schedules (services/attention-schedule.js, docs/design/attention-schedules.md). db/index.js and services/attention.js
  -- ensureScheduleColumns add them to an older database and make the index on next_at, which this file cannot: it runs before they exist there):
  schedule         TEXT,                             -- JSON { kind: once | repeat, at | rule, starts, ends, tz } or NULL
  then_action      TEXT,                             -- JSON { kind: prompt | script, ... } or NULL (remind me)
  next_at          TEXT,                             -- the next fire time (ISO UTC), NULL when nothing is left to fire
  schedule_state   TEXT,                             -- waiting | due | NULL
  runs             INTEGER NOT NULL DEFAULT 0,       -- times fired since the schedule was saved
  last_fired_at    TEXT,
  last_done_at     TEXT,
  script_runs      TEXT                              -- JSON: the last 5 script runs [{ terminal_id, task_id, at, ended_at, outcome, exit, duration_ms }]
);
CREATE INDEX IF NOT EXISTS idx_attention_items_status ON attention_items (status, sort_order);
-- The items finished last (the list's recent_finished, which the desktop window reads): read from the newest end, never the whole table. An index
-- only, made here on every start: no schema generation.
CREATE INDEX IF NOT EXISTS idx_attention_items_completed ON attention_items (completed_at);

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

-- T-Attention read copies (services/attention-copy.js, docs/design/attention-copies.md): one row per item and owner engine, this engine's own items
-- included (owner '': the journal its peers copy). item: the whole item as the owner lists it (JSON), NULL for a deleted one (a tombstone); event: the
-- kind of its last change; rev: the owner's version (a hybrid clock, ms), the later one wins; sync_seq: this database's change number. No schema
-- generation: an older version leaves these tables alone.
CREATE TABLE IF NOT EXISTS attention_copies (
  owner     TEXT    NOT NULL,
  item_id   INTEGER NOT NULL,
  rev       INTEGER NOT NULL,
  deleted   INTEGER NOT NULL DEFAULT 0,
  item      TEXT,
  event     TEXT,
  at        TEXT    NOT NULL,
  sync_seq  INTEGER NOT NULL,
  PRIMARY KEY (owner, item_id)
);
CREATE INDEX IF NOT EXISTS idx_attention_copies_seq ON attention_copies (sync_seq);
-- Changes made here to the item of an owner that was offline, applied in order when it is back (pending), or kept for the page a while when the owner
-- had a newer change of the same field (dropped). fields: the item fields to set (JSON); activity: a note; base: the values they started from.
CREATE TABLE IF NOT EXISTS attention_copy_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT    NOT NULL,
  item_id    INTEGER NOT NULL,
  fields     TEXT    NOT NULL,
  activity   TEXT,
  base       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  state      TEXT    NOT NULL DEFAULT 'pending',
  reason     TEXT,
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_attention_copy_queue_item ON attention_copy_queue (owner, item_id, id);

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

-- Usage data (schema 12, services/ui-events.js, "Usage data" in docs/design/usage-data.md): one row per press of a button of the page, written by
-- POST /api/ui-events while the switch in Settings > Usage data is on. A control is named by its stable identity (data-track, id, data-action, a
-- class name of the page), never by its text; no input, name, path or terminal text is stored. Rows older than 90 days are deleted.
CREATE TABLE IF NOT EXISTS ui_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,            -- milliseconds since 1970, on the server's clock
  page    TEXT    NOT NULL,            -- a random id of one page load (the next-click pairs stay inside one)
  key     TEXT    NOT NULL,            -- the control, e.g. 'h5-cycle', 'action:more', 'key:Escape', 'h5-terminal-main'
  detail  TEXT,                        -- a fixed product string of a list row (a preset command, a menu action), or NULL
  surface TEXT    NOT NULL,            -- where it is: 'header', 'rail', 'bottom-row', 'settings:<group>', 'dialog:<id>', ...
  view    TEXT    NOT NULL,            -- sessions | columns | maps
  layout  TEXT    NOT NULL,            -- wide | narrow
  input   TEXT    NOT NULL,            -- pointer | touch
  pane    INTEGER NOT NULL DEFAULT 0,  -- 1: pressed inside a column of the multi-column view
  device  TEXT    NOT NULL,            -- local | remote: where the shown session runs (never its name)
  state   TEXT,                        -- on | off: the new state of a switch, or NULL
  version TEXT,                        -- the app version that recorded it
  -- Schema 16, the usage data of every linked engine as one set (services/ui-events-sync.js); added to an older database by
  -- services/ui-events.js ensureSchema before this file runs.
  uid      TEXT,                       -- a random id: the identity of the press on every engine
  engine   TEXT    NOT NULL DEFAULT '', -- the instance id of the engine that recorded it; '' is this engine
  client   TEXT,                       -- phone | computer | mac-app (from the User-Agent); NULL before schema 16 (read from the layout)
  sync_seq INTEGER NOT NULL DEFAULT 0  -- its change number on this database
);
CREATE INDEX IF NOT EXISTS idx_ui_events_at ON ui_events (at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ui_events_uid ON ui_events (uid);
CREATE INDEX IF NOT EXISTS idx_ui_events_seq ON ui_events (sync_seq);

-- The controls the pages have shown (so "Not used in 30 days" can be computed), per surface and layout, with the first and last time seen.
CREATE TABLE IF NOT EXISTS ui_controls (
  key        TEXT    NOT NULL,
  surface    TEXT    NOT NULL,
  layout     TEXT    NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  sync_seq   INTEGER NOT NULL DEFAULT 0, -- schema 16: its change number on this database (the list is one set for every linked engine)
  PRIMARY KEY (key, surface, layout)
);
CREATE INDEX IF NOT EXISTS idx_ui_controls_seq ON ui_controls (sync_seq);

-- English learning (schema 13, sync columns schema 14; "Learn English" in docs/design/learn-english.md, services/learn.js). One card per English word or sentence of an owner:
-- the person's own translated sentences, the words they looked up, and the starter list. Times are milliseconds since 1970 on the server's clock.
CREATE TABLE IF NOT EXISTS learn_cards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner         TEXT    NOT NULL,                -- the login of the page (req.session.user.login), like other per-owner data
  kind          TEXT    NOT NULL,                -- word | sentence
  en            TEXT    NOT NULL,                -- the English text as it is shown
  norm          TEXT    NOT NULL,                -- en trimmed, inner spaces collapsed, lower-cased: the duplicate check
  zh            TEXT    NOT NULL DEFAULT '',     -- the Chinese meaning, '' until a meaning is fetched
  source        TEXT    NOT NULL,                -- translation | lookup | starter | manual
  context       TEXT    NOT NULL DEFAULT '',     -- where it came from (the task title), may be empty
  created_at    INTEGER NOT NULL,
  due_at        INTEGER NOT NULL,
  interval_days REAL    NOT NULL DEFAULT 0,
  ease          REAL    NOT NULL DEFAULT 2.5,
  reps          INTEGER NOT NULL DEFAULT 0,      -- answers given
  lapses        INTEGER NOT NULL DEFAULT 0,      -- answers graded "again"
  last_result   TEXT,                            -- again | hard | good, NULL before the first answer
  last_at       INTEGER,
  last_correct  INTEGER,                         -- 1 / 0: whether the last answer was right, NULL before the first answer
  suspended     INTEGER NOT NULL DEFAULT 0,
  -- Schema 14, the sync between linked devices ("Sync across linked devices" in docs/design/learn-english.md; services/learn-sync-store.js adds
  -- them to an older database): two hybrid clocks with the device that made each change ('' is this device), one for the content (en, zh,
  -- source, context, suspended) and one for the review state (due_at ... last_correct), and the change number the sync pages by.
  content_at    INTEGER NOT NULL DEFAULT 0,
  content_by    TEXT    NOT NULL DEFAULT '',
  state_at      INTEGER NOT NULL DEFAULT 0,
  state_by      TEXT    NOT NULL DEFAULT '',
  sync_seq      INTEGER NOT NULL DEFAULT 0,
  -- Schema 15: the phonetic transcription of a word card (IPA between slashes, '' when none is known), part of the content like zh; filled in from
  -- the bundled dictionary (services/phonetics.js) or the translator, never replaced by '' in the sync. services/learn-sync-store.js adds it.
  phonetic      TEXT    NOT NULL DEFAULT '',
  -- Schema 19, words picked from a translated sentence ("Picking words from translations" in docs/design/learn-english.md; services/learn-pick.js):
  -- on a sentence card the level it was last picked at ('' not yet), how many known words it met then, and the hybrid clock of that pick (the three
  -- travel together in the sync, the later pick wins). services/learn-sync-store.js adds them.
  picked_level   TEXT    NOT NULL DEFAULT '',
  picked_skipped INTEGER NOT NULL DEFAULT 0,
  picked_at      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner, kind, norm)
);
CREATE INDEX IF NOT EXISTS idx_learn_cards_due ON learn_cards (owner, suspended, due_at);
CREATE INDEX IF NOT EXISTS idx_learn_cards_seq ON learn_cards (owner, sync_seq);

-- Every answer, for the streak, "done today" and the mistakes list. A card's answers go with it.
CREATE TABLE IF NOT EXISTS learn_reviews (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES learn_cards(id) ON DELETE CASCADE,
  owner   TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  mode    TEXT    NOT NULL,                      -- review | spell | build | dictation | say | fill | mistakes
  grade   TEXT    NOT NULL,                      -- again | hard | good
  correct INTEGER NOT NULL,                      -- 1 / 0
  answer  TEXT,                                  -- what the person answered, at most 500 characters
  uid     TEXT,                                  -- schema 14: the id of the answer on every linked device (a random UUID), always set
  sync_seq INTEGER NOT NULL DEFAULT 0,           -- schema 14: the change number the sync pages by
  -- Schema 17, the Mistakes list and the analysis ("Mistakes" in docs/design/learn-english.md; services/learn-sync-store.js adds them): for a wrong
  -- answer what was asked for (NULL: the card's text), the first tag of the page's checker ('' for none) and whether help was used.
  expected TEXT,
  tag      TEXT    NOT NULL DEFAULT '',
  hinted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_learn_reviews_owner_at ON learn_reviews (owner, at);
CREATE INDEX IF NOT EXISTS idx_learn_reviews_card ON learn_reviews (card_id, at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_learn_reviews_uid ON learn_reviews (uid);
CREATE INDEX IF NOT EXISTS idx_learn_reviews_seq ON learn_reviews (owner, sync_seq);

-- Schema 14: where a card went when its English text was changed to another text (PATCH en), so a linked device that still has the card under the
-- old text moves it too instead of sending it back. Cards are never deleted otherwise.
CREATE TABLE IF NOT EXISTS learn_card_moves (
  owner    TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  norm     TEXT    NOT NULL,                     -- the old normalized text
  moved_to TEXT    NOT NULL,                     -- the normalized text the card has now
  at       INTEGER NOT NULL,                     -- the hybrid clock of the change
  by       TEXT    NOT NULL DEFAULT '',          -- the device that made it ('' is this device)
  sync_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, kind, norm)
);
CREATE INDEX IF NOT EXISTS idx_learn_card_moves_seq ON learn_card_moves (owner, sync_seq);

-- Schema 17: the mistake reports ("Mistake reports" in docs/design/learn-english.md; services/learn-analysis.js makes them, services/learn-sync.js
-- syncs them like answers: made once, never changed; an automatic report has the id auto-<week>, so two engines never keep two for one week).
CREATE TABLE IF NOT EXISTS learn_reports (
  owner        TEXT    NOT NULL,
  uid          TEXT    NOT NULL,                 -- a random UUID, or auto-<ISO week> for an automatic report
  created_at   INTEGER NOT NULL,
  covers_from  INTEGER NOT NULL,                 -- the wrong answers after this time ...
  covers_until INTEGER NOT NULL,                 -- ... up to this one (the next report starts here)
  auto         INTEGER NOT NULL DEFAULT 0,       -- 1: made by the weekly run
  lang         TEXT    NOT NULL DEFAULT 'en',    -- en | zh: the language of the text
  mistakes     INTEGER NOT NULL DEFAULT 0,       -- wrong answers in the stretch
  answers      INTEGER NOT NULL DEFAULT 0,       -- all answers in the stretch
  model        TEXT    NOT NULL DEFAULT '',      -- the model that wrote it
  body         TEXT    NOT NULL,                 -- JSON { summary, kinds: [{ kind, count }], findings: [{ title, cause, action, cards: [{ kind, en }] }] }
  by           TEXT    NOT NULL DEFAULT '',      -- the engine that made it ('' is this one)
  sync_seq     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, uid)
);
CREATE INDEX IF NOT EXISTS idx_learn_reports_seq ON learn_reports (owner, sync_seq);

-- Schema 20: the questions the person asked the model about a card and its answers ("Ask about a question" in docs/design/learn-english.md;
-- services/learn-ask.js). A card's messages go with it; on every engine they are the same card's by its kind and normalized text (the sync joins
-- learn_cards), a union by uid, and only the newest 20 of a card are kept (services/learn-sync-store.js pruneChats). Personal data like the answers:
-- a company computer keeps none (its page asks its home).
CREATE TABLE IF NOT EXISTS learn_chats (
  owner    TEXT    NOT NULL,
  uid      TEXT    NOT NULL,                     -- a random UUID, the same on every engine
  card_id  INTEGER NOT NULL REFERENCES learn_cards(id) ON DELETE CASCADE,
  role     TEXT    NOT NULL,                     -- user (the question, at most 500 characters) | assistant (the answer, at most 2000)
  text     TEXT    NOT NULL,
  at       INTEGER NOT NULL,                     -- the hybrid clock of the learning sync (ms): the order of a card's messages, then uid
  by       TEXT    NOT NULL DEFAULT '',          -- the engine that stored it ('' is this one)
  sync_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, uid)
);
CREATE INDEX IF NOT EXISTS idx_learn_chats_card ON learn_chats (card_id, at);
CREATE INDEX IF NOT EXISTS idx_learn_chats_seq ON learn_chats (owner, sync_seq);

-- Schema 21: the English chats ("English chat" in docs/design/learn-english-chat.md; services/learn-chat.js): the person's own conversations with the
-- model about English, their journal entries and their learning habits. A chat and its messages are the same on every engine by their uids. Personal
-- data like the answers: a company computer keeps none (its page asks its home). A deleted or pruned chat stays as a tombstone without its messages.
CREATE TABLE IF NOT EXISTS learn_convos (
  owner      TEXT    NOT NULL,
  uid        TEXT    NOT NULL,                   -- a random UUID, the same on every engine
  title      TEXT    NOT NULL DEFAULT '',        -- at most 60 characters; '' until named
  title_at   INTEGER NOT NULL DEFAULT 0,         -- the hybrid clock of the title (the newer wins)
  journal    INTEGER NOT NULL DEFAULT 0,         -- 1: a journal chat (never pruned)
  journal_by TEXT    NOT NULL DEFAULT '',        -- model | person | '': who set the flag (the person's choice always wins)
  journal_at INTEGER NOT NULL DEFAULT 0,         -- the hybrid clock of the flag
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,                   -- the time of the last message (the order of the list)
  deleted    INTEGER NOT NULL DEFAULT 0,         -- 1: a tombstone (no messages)
  deleted_at INTEGER NOT NULL DEFAULT 0,         -- the hybrid clock of the newest delete or prune, kept after a later message brings the chat back
  deleted_by TEXT    NOT NULL DEFAULT '',        -- person | prune | '': what made that tombstone (a prune never removes a journal chat)
  by         TEXT    NOT NULL DEFAULT '',        -- the engine that started it ('' is this one)
  sync_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, uid)
);
CREATE INDEX IF NOT EXISTS idx_learn_convos_seq ON learn_convos (owner, sync_seq);
CREATE INDEX IF NOT EXISTS idx_learn_convos_updated ON learn_convos (owner, deleted, updated_at);
CREATE TABLE IF NOT EXISTS learn_convo_messages (
  owner     TEXT    NOT NULL,
  uid       TEXT    NOT NULL,                    -- a random UUID, the same on every engine
  convo_uid TEXT    NOT NULL,                    -- learn_convos.uid
  role      TEXT    NOT NULL,                    -- user (at most 4000 characters) | assistant (at most 6000)
  text      TEXT    NOT NULL,
  at        INTEGER NOT NULL,                    -- the hybrid clock: the order of a chat's messages, then uid
  meta      TEXT    NOT NULL DEFAULT '',         -- assistant only, JSON { cards: [{ kind, en, zh }], mistakes: [tag], journal? }
  by        TEXT    NOT NULL DEFAULT '',
  sync_seq  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, uid)
);
CREATE INDEX IF NOT EXISTS idx_learn_convo_messages_convo ON learn_convo_messages (owner, convo_uid, at);
CREATE INDEX IF NOT EXISTS idx_learn_convo_messages_seq ON learn_convo_messages (owner, sync_seq);
