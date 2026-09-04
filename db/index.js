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

const pairingColumns = db.prepare('PRAGMA table_info(engine_pairing_codes)').all().map(column => column.name);
if (!pairingColumns.includes('principal_id')) {
  db.exec("ALTER TABLE engine_pairing_codes ADD COLUMN principal_id TEXT NOT NULL DEFAULT 'engine'");
}

// terminal output history
db.exec(`CREATE TABLE IF NOT EXISTS terminal_logs (
  task_id    INTEGER PRIMARY KEY,
  buffer     TEXT    NOT NULL DEFAULT '',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

// 用户表（本地账号）
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id         INTEGER  PRIMARY KEY AUTOINCREMENT,
  username   TEXT     NOT NULL UNIQUE,
  salt       TEXT     NOT NULL,
  hash       TEXT     NOT NULL,
  work_dir   TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// 迁移：将 .env 中配置的初始账号写入 users 表（仅首次）
const config = require('../config');
for (const [username, cred] of Object.entries(config.authUsers || {})) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!exists) {
    db.prepare('INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)').run(username, cred.salt, cred.hash);
  }
}

module.exports = db;
