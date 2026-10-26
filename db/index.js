const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = process.env.T_AGENT_DATA_DIR
  ? path.resolve(process.env.T_AGENT_DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.T_AGENT_DB_PATH
  ? path.resolve(process.env.T_AGENT_DB_PATH)
  : path.join(dataDir, 'db.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
const terminalColumns = db.prepare('PRAGMA table_info(task_terminals)').all().map(column => column.name);
for (const [column, type] of [['agent', 'TEXT'], ['agent_session_id', 'TEXT'], ['agent_started_at', 'INTEGER']]) {
  if (!terminalColumns.includes(column)) db.exec(`ALTER TABLE task_terminals ADD COLUMN ${column} ${type}`);
}

// The model and thinking effort chosen for an agent chat (empty: the agent's own default).
const conversationColumns = db.prepare('PRAGMA table_info(agent_conversations)').all().map(column => column.name);
for (const column of ['model', 'effort']) {
  if (!conversationColumns.includes(column)) db.exec(`ALTER TABLE agent_conversations ADD COLUMN ${column} TEXT`);
}

// Bookmark groups created before the project became English-first used a Chinese default name.
db.prepare("UPDATE bookmarks SET group_name = 'Default' WHERE group_name = ?").run('\u9ed8\u8ba4');

// terminal output history
db.exec(`CREATE TABLE IF NOT EXISTS terminal_logs (
  task_id    INTEGER PRIMARY KEY,
  buffer     TEXT    NOT NULL DEFAULT '',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

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

module.exports = db;
