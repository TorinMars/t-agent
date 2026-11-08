const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const dataHome = require('../lib/data-home');

// The data folder (~/.tagent by default, see lib/data-home.js): copied once from the old <install>/data, 0700, secrets 0600.
const { dbPath, backupsDir } = dataHome.prepare();
const db = new Database(dbPath);
// The schema generation is stored in the database (PRAGMA user_version). A database written by a newer version is refused,
// so an older app never runs its migrations over data it does not understand; an older database is migrated below and stamped.
const codeSchema = dataHome.codeSchemaVersion();
const storedSchema = db.pragma('user_version', { simple: true });
if (storedSchema > codeSchema) {
  db.close();
  throw dataHome.newerSchemaError(dbPath, storedSchema, codeSchema);
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
dataHome.secureDatabaseFiles(dbPath);

// Before an older schema generation is migrated (an existing database, user_version 1 or more), a copy is written to the backups folder, so an
// older app version can be brought back with it (it refuses the migrated database). A failed copy is logged and the start goes on.
if (storedSchema > 0 && storedSchema < codeSchema) {
  const backup = path.join(backupsDir, `db-schema-${storedSchema}-before-${codeSchema}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  try {
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    db.prepare('VACUUM INTO ?').run(backup);
    fs.chmodSync(backup, 0o600);
    console.log(`Database: schema ${storedSchema} is migrated to ${codeSchema}; a copy of the database before the migration is in ${backup}`);
  } catch (error) {
    console.warn(`Database: could not copy the database before migrating schema ${storedSchema} to ${codeSchema} (${error.message}); migrating anyway`);
  }
}

// schema.sql creates missing tables on every start; schema 9 added the T-Attention tables (attention_items, attention_events, attention_tokens) this way.
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

const { randomUUID } = require('crypto');
const identity = db.prepare("SELECT value FROM engine_identity WHERE key = 'instance_id'").get();
if (!identity) {
  db.prepare("INSERT INTO engine_identity (key, value) VALUES ('instance_id', ?)").run(randomUUID());
}

const existing = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
if (!existing.includes('user_id'))     db.exec('ALTER TABLE tasks ADD COLUMN user_id TEXT');
if (!existing.includes('share_token')) db.exec('ALTER TABLE tasks ADD COLUMN share_token TEXT');
if (!existing.includes('work_dir'))    db.exec('ALTER TABLE tasks ADD COLUMN work_dir TEXT');

for (const column of ['technical_path', 'readme_path', 'agent_path']) {
  if (!existing.includes(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
}

// Migrate documents on each host, including Engine workspaces. Missing/offline
// workspaces are left alone and retried on the next startup.
const documents = require('../services/task-documents');
for (const task of db.prepare('SELECT * FROM tasks').all()) {
  const root = task.work_dir || (task.md_path && path.dirname(task.md_path));
  if (!root || !fs.existsSync(root)) continue;
  try {
    documents.ensureDocument(task, 'agent');
    const agentPath = documents.resolveTask(task).agent_path;
    if (agentPath !== task.agent_path) db.prepare('UPDATE tasks SET agent_path = ? WHERE id = ?').run(agentPath, task.id);
  } catch (error) {
    console.warn(`Task ${task.id} instruction migration failed: ${error.message}`);
  }
}

const pairingColumns = db.prepare('PRAGMA table_info(engine_pairing_codes)').all().map(column => column.name);
if (!pairingColumns.includes('principal_id')) {
  db.exec("ALTER TABLE engine_pairing_codes ADD COLUMN principal_id TEXT NOT NULL DEFAULT 'engine'");
}

// Terminals started as a Claude / Codex session remember the agent, its session id (bound later for Codex) and when they were created.
// title_custom (1): the person named the terminal (at creation or by a rename), so that name is shown instead of the agent session's name.
// work_dir (schema 8): the directory the terminal keeps when the task's working directory changes later. Terminals that exist when the column
// is added get the task's current directory, in the same transaction, so nothing changes for them; a second start finds the column and does nothing.
const terminalColumns = db.prepare('PRAGMA table_info(task_terminals)').all().map(column => column.name);
for (const [column, type] of [['agent', 'TEXT'], ['agent_session_id', 'TEXT'], ['agent_started_at', 'INTEGER'], ['title_custom', 'INTEGER']]) {
  if (!terminalColumns.includes(column)) db.exec(`ALTER TABLE task_terminals ADD COLUMN ${column} ${type}`);
}
if (!terminalColumns.includes('work_dir')) {
  db.transaction(() => {
    db.exec('ALTER TABLE task_terminals ADD COLUMN work_dir TEXT');
    db.exec('UPDATE task_terminals SET work_dir = (SELECT work_dir FROM tasks WHERE tasks.id = task_terminals.task_id) WHERE work_dir IS NULL');
  })();
}

// T-Attention items got the context column during schema 9 (before its release); a database made by an earlier build of it gets the column here.
const attentionColumns = db.prepare('PRAGMA table_info(attention_items)').all().map(column => column.name);
if (!attentionColumns.includes('context')) db.exec('ALTER TABLE attention_items ADD COLUMN context TEXT');
// attention_tokens.scopes (extra token permissions, 'market' = "Can manage plugins"): a nullable column, so an older version that does not know
// it still reads and writes the table (its new tokens simply have no scope); no schema bump.
if (!db.prepare('PRAGMA table_info(attention_tokens)').all().some(column => column.name === 'scopes')) db.exec('ALTER TABLE attention_tokens ADD COLUMN scopes TEXT');

// The model and thinking effort chosen for an agent chat (empty: the agent's own default).
const conversationColumns = db.prepare('PRAGMA table_info(agent_conversations)').all().map(column => column.name);
for (const column of ['model', 'effort', 'queue']) { // queue: the messages queued in the chat (JSON)
  if (!conversationColumns.includes(column)) db.exec(`ALTER TABLE agent_conversations ADD COLUMN ${column} TEXT`);
}
// Where a chat is open (see schema.sql): the time it was opened on the desktop page / the phone page.
for (const column of ['opened_web', 'opened_h5', 'translate', 'collapse_keyboard']) { // translate / collapse_keyboard: the chat's switches (collapse_keyboard: NULL is on)
  if (!conversationColumns.includes(column)) db.exec(`ALTER TABLE agent_conversations ADD COLUMN ${column} INTEGER`);
}

// Bookmark groups created before the project became English-first used a Chinese default name.
db.prepare("UPDATE bookmarks SET group_name = 'Default' WHERE group_name = ?").run('\u9ed8\u8ba4');

// Terminal output history is no longer persisted (it lives in memory only). Drop what older versions stored; both statements are no-ops on a
// database that no longer has them, so this is safe to run on every start. Other task_terminals columns (agent_session_id, ...) are untouched.
db.exec('DROP TABLE IF EXISTS terminal_logs');
if (db.prepare('PRAGMA table_info(task_terminals)').all().some(column => column.name === 'buffer')) {
  db.exec('ALTER TABLE task_terminals DROP COLUMN buffer');
}

// User table (local accounts)
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id         INTEGER  PRIMARY KEY AUTOINCREMENT,
  username   TEXT     NOT NULL UNIQUE,
  salt       TEXT     NOT NULL,
  hash       TEXT     NOT NULL,
  work_dir   TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Migration: write the initial accounts configured in .env into the users table (first time only)
const config = require('../config');
for (const [username, cred] of Object.entries(config.authUsers || {})) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!exists) {
    db.prepare('INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)').run(username, cred.salt, cred.hash);
  }
}

if (storedSchema < codeSchema) db.pragma(`user_version = ${codeSchema}`);

module.exports = db;
